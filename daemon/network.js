import net from 'net';
import dgram from 'dgram';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import crypto from 'crypto';
import db from './db.js';
import {
  getFingerprint,
  generateEphemeralKeypair,
  computeSharedSecret,
  deriveSessionKeys,
  signTranscript,
  verifyTranscript,
  encrypt,
  decrypt
} from './crypto.js';

const DISCOVERY_MULTICAST = '239.255.255.250';
const DISCOVERY_PORT = 53535;

// Packet Frame Types
const FRAME_HS_X25519_C = 0x01; // Client ephemeral key + alias
const FRAME_HS_X25519_S = 0x02; // Server ephemeral key + alias
const FRAME_HS_AUTH_C = 0x03;   // Client Identity PEM + signature
const FRAME_HS_AUTH_S = 0x04;   // Server Identity PEM + signature
const FRAME_MSG_TEXT = 0x10;    // Encrypted text
const FRAME_FILE_START = 0x20;  // File metadata start
const FRAME_FILE_CHUNK = 0x21;  // File data chunk
const FRAME_FILE_END = 0x22;    // File end

export class P2PNetwork {
  constructor(port, wsNotifyCallback) {
    this.port = port;
    this.wsNotify = wsNotifyCallback; // Used to broadcast handshake steps and messages to UI
    this.connections = {}; // peerId -> Connection object
    this.discoveredPeers = {}; // peerId -> { peerId, alias, ip, port, lastSeen }
    
    this.tcpServer = null;
    this.udpSocket = null;
    this.relayWs = null;
    this.relayUrl = process.env.RELAY_URL || 'wss://ssh-chat-34qo.onrender.com';
    
    // Ensure download dir exists
    this.downloadsDir = process.env.DOWNLOADS_DIR || './downloads';
    if (!fs.existsSync(this.downloadsDir)) {
      fs.mkdirSync(this.downloadsDir, { recursive: true });
    }
  }

  start() {
    this.startTcpServer();
    this.startUdpDiscovery();
    this.connectToRelay();
  }

  // --- TCP Server ---
  startTcpServer() {
    this.tcpServer = net.createServer((socket) => {
      this.handleIncomingConnection(socket);
    });

    this.tcpServer.listen(this.port, () => {
      console.log(`TCP P2P Server listening on port ${this.port}`);
    });
  }

  // --- UDP Multicast Peer Discovery ---
  startUdpDiscovery() {
    this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.udpSocket.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'DISCOVER') {
          const myId = getFingerprint(db.getIdentity().publicKey);
          // Don't discover ourselves
          if (data.peerId === myId) return;

          const peer = {
            peerId: data.peerId,
            alias: data.alias,
            ip: rinfo.address,
            port: data.tcpPort,
            lastSeen: new Date().toISOString()
          };

          this.discoveredPeers[peer.peerId] = peer;
          db.saveContact(peer.peerId, peer.alias);
          
          this.wsNotify('PEER_DISCOVERED', peer);
        }
      } catch (err) {
        // Ignore malformed packets
      }
    });

    this.udpSocket.bind(DISCOVERY_PORT, () => {
      try {
        this.udpSocket.addMembership(DISCOVERY_MULTICAST);
        console.log(`UDP Discovery listening on Multicast ${DISCOVERY_MULTICAST}:${DISCOVERY_PORT}`);
      } catch (e) {
        console.log('Multicast binding failed (probably interface issue), falling back to UDP broadcast listener');
      }
      
      // Start broadcasting our presence
      setInterval(() => {
        this.broadcastPresence();
      }, 3000);
    });
  }

  broadcastPresence() {
    const identity = db.getIdentity();
    if (!identity) return;

    const myId = getFingerprint(identity.publicKey);
    const packet = JSON.stringify({
      type: 'DISCOVER',
      peerId: myId,
      alias: db.getAlias(),
      tcpPort: this.port
    });

    const message = Buffer.from(packet);
    
    // Broadcast on multicast
    this.udpSocket.send(message, 0, message.length, DISCOVERY_PORT, DISCOVERY_MULTICAST, (err) => {
      if (err) {
        // Fall back to local broadcast if multicast fails
        try {
          this.udpSocket.setBroadcast(true);
          this.udpSocket.send(message, 0, message.length, DISCOVERY_PORT, '255.255.255.255');
        } catch (e) {}
      }
    });
  }

  // --- Connection Management ---
  async connectToPeer(peerId) {
    if (this.connections[peerId] && this.connections[peerId].state === 'SECURE') {
      return this.connections[peerId];
    }

    const peerInfo = this.discoveredPeers[peerId];
    
    // 1. If discovered locally or manually input, try TCP direct connection first
    if (peerInfo) {
      this.logHandshake(peerId, 'info', `Dialing TCP connection to ${peerInfo.ip}:${peerInfo.port}...`);
      try {
        const conn = await new Promise((resolve, reject) => {
          const socket = net.createConnection({ host: peerInfo.ip, port: peerInfo.port }, () => {
            this.logHandshake(peerId, 'info', `Connected to TCP socket. Initiating SSH-like handshake...`);
            const conn = new Connection(socket, this, true, peerId);
            this.connections[peerId] = conn;
            conn.onSecure = () => resolve(conn);
            conn.onError = (err) => reject(err);
          });

          socket.on('error', (err) => {
            reject(err);
          });
        });
        return conn;
      } catch (err) {
        console.log(`TCP connection to ${peerId} failed: ${err.message}. Falling back to Relay Server...`);
      }
    }

    // 2. Fallback to virtual socket connection via WAN Relay Server
    return this.dialRelay(peerId);
  }

  handleIncomingConnection(socket) {
    const remoteAddress = socket.remoteAddress;
    console.log(`Incoming TCP connection from ${remoteAddress}`);
    // We don't know their peerId yet; it will be established during handshake.
    new Connection(socket, this, false);
  }

  registerConnection(peerId, connection) {
    // If we have an existing different connection, close it
    if (this.connections[peerId] && this.connections[peerId] !== connection) {
      try { this.connections[peerId].socket.destroy(); } catch (e) {}
    }
    this.connections[peerId] = connection;
    this.wsNotify('PEER_CONNECTED', { peerId, state: 'SECURE' });
  }

  logHandshake(peerId, type, message) {
    this.wsNotify('HANDSHAKE_STEP', { peerId, type, message, timestamp: new Date().toISOString() });
  }

  // --- Relay Server Client Managers ---
  connectToRelay() {
    const identity = db.getIdentity();
    if (!identity) return;

    const myId = getFingerprint(identity.publicKey);
    const relayWsUrl = `${this.relayUrl}/?peerId=${myId}`;
    console.log(`Connecting to public WAN P2P Relay: ${this.relayUrl}`);

    const ws = new WebSocket(relayWsUrl);
    this.relayWs = ws;

    ws.on('open', () => {
      console.log('Successfully connected to WAN P2P Relay Server');
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'RELAY_MSG') {
          const { from, payload } = msg;
          let conn = this.connections[from];
          if (!conn) {
            console.log(`Incoming virtual socket connection via Relay from: ${from}`);
            conn = new Connection(null, this, false, from, true);
            this.connections[from] = conn;
          }
          conn.processFrame(payload.frameType, Buffer.from(payload.framePayload, 'hex'));
        }
      } catch (err) {
        console.error('Failed to process incoming relay socket frame:', err);
      }
    });

    ws.on('close', () => {
      console.log('Disconnected from P2P Relay. Retrying in 5 seconds...');
      setTimeout(() => this.connectToRelay(), 5000);
    });

    ws.on('error', (err) => {
      console.error('P2P Relay connection error:', err.message);
    });
  }

  sendRelayFrame(toPeerId, type, payloadBuffer) {
    if (this.relayWs && this.relayWs.readyState === 1) {
      // Lookup if we have a Web Push subscription saved for Bob
      const contact = db.getContacts().find((c) => c.peerId === toPeerId);
      const pushSubscription = contact?.pushSubscription || null;

      const relayPacket = {
        type: 'RELAY_MSG',
        to: toPeerId,
        payload: {
          frameType: type,
          framePayload: payloadBuffer.toString('hex')
        },
        pushSubscription,
        notificationText: `New encrypted message from ${db.getAlias()}`
      };
      this.relayWs.send(JSON.stringify(relayPacket));
    } else {
      console.error('Cannot send relayed frame: Relay client is offline.');
    }
  }

  dialRelay(peerId) {
    this.logHandshake(peerId, 'info', `TCP connection failed or unavailable. Dialing virtual socket via Relay Server...`);
    return new Promise((resolve, reject) => {
      const conn = new Connection(null, this, true, peerId, true);
      this.connections[peerId] = conn;
      
      conn.onSecure = () => resolve(conn);
      conn.onError = (err) => reject(err);
      
      conn.startHandshake();
    });
  }
}

class Connection {
  constructor(socket, network, isInitiator, targetPeerId = null, relayed = false) {
    this.socket = socket;
    this.network = network;
    this.isInitiator = isInitiator;
    this.peerId = targetPeerId; // May be null initially for server-side connections
    this.state = 'CONNECTING'; // CONNECTING, HS_SENT_EPH, HS_RECV_EPH, SECURE
    this.relayed = relayed; // Direct TCP by default, true for virtual sockets
    
    this.outboundKey = null;
    this.inboundKey = null;
    
    // Handshake variables
    this.ourEph = null;
    this.peerEphPub = null;
    this.peerIdentityPub = null;
    this.peerAlias = '';
    
    // File Transfer States
    this.activeDownloads = {}; // fileId -> { writeStream, filePath, receivedBytes, size, name }
    
    this.onSecure = null;
    this.onError = null;
    
    this.buffer = Buffer.alloc(0);
    this.init();
  }

  init() {
    if (!this.relayed && this.socket) {
      this.socket.on('data', (chunk) => this.handleData(chunk));
      
      this.socket.on('error', (err) => {
        console.error(`Socket error with ${this.peerId || 'Unknown'}:`, err);
        this.handleDisconnect(err);
      });

      this.socket.on('close', () => {
        console.log(`Socket closed with ${this.peerId || 'Unknown'}`);
        this.handleDisconnect();
      });
    }
    
    if (this.isInitiator) {
      this.startHandshake();
    }
  }

  handleDisconnect(err = null) {
    this.state = 'CLOSED';
    if (this.peerId) {
      delete this.network.connections[this.peerId];
      delete this.network.discoveredPeers[this.peerId];
      this.network.wsNotify('PEER_DISCONNECTED', { peerId: this.peerId });
    }
    if (this.onError && err) {
      this.onError(err);
    }
  }

  // TCP Parsing: [Length (4 Bytes Big Endian)] [Type (1 Byte)] [Payload]
  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    
    while (this.buffer.length >= 5) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length >= 4 + length) {
        const type = this.buffer.readUInt8(4);
        const payload = this.buffer.slice(5, 4 + length);
        this.buffer = this.buffer.slice(4 + length);
        
        try {
          this.processFrame(type, payload);
        } catch (err) {
          console.error('Error processing frame:', err);
          this.socket.destroy(err);
        }
      } else {
        break;
      }
    }
  }

  sendFrame(type, payloadBuffer) {
    if (this.state === 'CLOSED') return;
    if (this.relayed) {
      this.network.sendRelayFrame(this.peerId, type, payloadBuffer);
    } else {
      const header = Buffer.alloc(5);
      header.writeUInt32BE(payloadBuffer.length + 1, 0);
      header.writeUInt8(type, 4);
      this.socket.write(Buffer.concat([header, payloadBuffer]));
    }
  }

  // --- SSH-Like Handshake State Machine ---
  
  startHandshake() {
    this.state = 'HS_SENT_EPH';
    this.ourEph = generateEphemeralKeypair();
    
    const packet = JSON.stringify({
      ephemeralPub: this.ourEph.publicKey,
      alias: db.getAlias()
    });

    this.network.logHandshake(this.peerId, 'x25519_sent', 'Generated & sent ephemeral X25519 public key (eA) + Alias.');
    this.sendFrame(FRAME_HS_X25519_C, Buffer.from(packet, 'utf8'));
  }

  processFrame(type, payload) {
    switch (type) {
      case FRAME_HS_X25519_C:
        if (!this.isInitiator && this.state === 'CONNECTING') {
          this.handleX25519Exchange(payload);
        }
        break;
        
      case FRAME_HS_X25519_S:
        if (this.isInitiator && this.state === 'HS_SENT_EPH') {
          this.handleX25519Response(payload);
        }
        break;
        
      case FRAME_HS_AUTH_C:
        if (!this.isInitiator && this.state === 'HS_RECV_EPH') {
          this.handleIdentityVerification(payload);
        }
        break;
        
      case FRAME_HS_AUTH_S:
        if (this.isInitiator && this.state === 'HS_RECV_EPH') {
          this.handleIdentityVerificationResponse(payload);
        }
        break;

      case FRAME_MSG_TEXT:
        if (this.state === 'SECURE') {
          this.handleEncryptedMessage(payload);
        }
        break;
        
      case FRAME_FILE_START:
        if (this.state === 'SECURE') {
          this.handleFileStart(payload);
        }
        break;
        
      case FRAME_FILE_CHUNK:
        if (this.state === 'SECURE') {
          this.handleFileChunk(payload);
        }
        break;
        
      case FRAME_FILE_END:
        if (this.state === 'SECURE') {
          this.handleFileEnd(payload);
        }
        break;

      default:
        console.warn('Unknown frame type received:', type);
    }
  }

  // --- Handshake Steps ---
  
  // Bob receives Alice's X25519 key
  handleX25519Exchange(payload) {
    const data = JSON.parse(payload.toString('utf8'));
    this.peerEphPub = data.ephemeralPub;
    this.peerAlias = data.alias;
    
    // Server generates its own ephemeral key
    this.ourEph = generateEphemeralKeypair();
    
    // Compute Shared Secret
    const sharedSecret = computeSharedSecret(this.ourEph.privateKey, this.peerEphPub);
    
    // Derive AES keys
    const { outboundKey, inboundKey } = deriveSessionKeys(sharedSecret, false);
    this.outboundKey = outboundKey;
    this.inboundKey = inboundKey;
    
    this.state = 'HS_RECV_EPH';
    
    const responsePacket = JSON.stringify({
      ephemeralPub: this.ourEph.publicKey,
      alias: db.getAlias()
    });
    
    this.sendFrame(FRAME_HS_X25519_S, Buffer.from(responsePacket, 'utf8'));
    console.log('Bob: X25519 shared secret established, derived keys.');
  }

  // Alice receives Bob's X25519 key response
  handleX25519Response(payload) {
    const data = JSON.parse(payload.toString('utf8'));
    this.peerEphPub = data.ephemeralPub;
    this.peerAlias = data.alias;
    
    // Compute Shared Secret
    const sharedSecret = computeSharedSecret(this.ourEph.privateKey, this.peerEphPub);
    
    // Derive AES keys
    const { outboundKey, inboundKey } = deriveSessionKeys(sharedSecret, true);
    this.outboundKey = outboundKey;
    this.inboundKey = inboundKey;
    
    this.network.logHandshake(this.peerId, 'dh_agree', 'Received ephemeral key (eB). Computed Diffie-Hellman secret, derived symmetric read/write session keys.');
    
    this.state = 'HS_RECV_EPH';
    
    // Send Identity Verification
    this.sendIdentityAuth();
  }

  // Alice sends Identity verification details (Frame 3)
  sendIdentityAuth() {
    const identity = db.getIdentity();
    
    // Sign the transcript: eA_pub + eB_pub
    const transcript = this.ourEph.publicKey + this.peerEphPub;
    const signature = signTranscript(identity.privateKey, transcript);
    
    const payload = JSON.stringify({
      identityPub: identity.publicKey,
      signature: signature.toString('hex'),
      pushSubscription: this.network.myPushSubscription || null
    });
    
    const encrypted = encrypt(payload, this.outboundKey);
    
    this.network.logHandshake(this.peerId, 'auth_sent', 'Signing handshake transcript (eA + eB) with long-term Ed25519 private key. Sent encrypted Identity PEM & Signature.');
    this.sendFrame(FRAME_HS_AUTH_C, Buffer.from(JSON.stringify(encrypted), 'utf8'));
  }

  // Bob receives Alice's Identity details and verifies it (Frame 3 receiver)
  handleIdentityVerification(payload) {
    const encryptedObj = JSON.parse(payload.toString('utf8'));
    const decryptedPayload = decrypt(encryptedObj, this.inboundKey);
    const data = JSON.parse(decryptedPayload.toString('utf8'));
    
    const clientIdentityPub = data.identityPub;
    const signature = Buffer.from(data.signature, 'hex');
    const pushSubscription = data.pushSubscription || null;
    
    // Transcript: eA_pub (peer) + eB_pub (our)
    const transcript = this.peerEphPub + this.ourEph.publicKey;
    
    const isValid = verifyTranscript(clientIdentityPub, transcript, signature);
    if (!isValid) {
      throw new Error('Cryptographic signature verification failed.');
    }
    
    this.peerId = getFingerprint(clientIdentityPub);
    this.peerIdentityPub = clientIdentityPub;
    
    // Save to Database
    db.saveContact(this.peerId, this.peerAlias, clientIdentityPub, pushSubscription);
    
    // Register TCP socket inside the network connections
    this.network.registerConnection(this.peerId, this);
    
    // Send Bob's identity response (Frame 4)
    const myIdentity = db.getIdentity();
    const myTranscript = this.ourEph.publicKey + this.peerEphPub;
    const mySignature = signTranscript(myIdentity.privateKey, myTranscript);
    
    const authResponsePayload = JSON.stringify({
      identityPub: myIdentity.publicKey,
      signature: mySignature.toString('hex'),
      pushSubscription: this.network.myPushSubscription || null
    });
    
    const encryptedResponse = encrypt(authResponsePayload, this.outboundKey);
    this.sendFrame(FRAME_HS_AUTH_S, Buffer.from(JSON.stringify(encryptedResponse), 'utf8'));
    
    this.state = 'SECURE';
    this.network.logHandshake(this.peerId, 'secure', 'Verified client identity signature. Sent own Identity & signature. Connection SECURED.');
    
    if (this.onSecure) this.onSecure();
  }

  // Alice receives Bob's identity details and verifies it (Frame 4 receiver)
  handleIdentityVerificationResponse(payload) {
    const encryptedObj = JSON.parse(payload.toString('utf8'));
    const decryptedPayload = decrypt(encryptedObj, this.inboundKey);
    const data = JSON.parse(decryptedPayload.toString('utf8'));
    
    const serverIdentityPub = data.identityPub;
    const signature = Buffer.from(data.signature, 'hex');
    const pushSubscription = data.pushSubscription || null;
    
    const transcript = this.peerEphPub + this.ourEph.publicKey;
    const isValid = verifyTranscript(serverIdentityPub, transcript, signature);
    if (!isValid) {
      throw new Error('Cryptographic signature verification failed on server response.');
    }
    
    const verifiedPeerId = getFingerprint(serverIdentityPub);
    if (this.peerId && this.peerId !== verifiedPeerId) {
      if (this.peerId.startsWith('manual:')) {
        const tempId = this.peerId;
        const peerInfo = this.network.discoveredPeers[tempId];
        delete this.network.discoveredPeers[tempId];
        
        peerInfo.peerId = verifiedPeerId;
        peerInfo.alias = peerInfo.alias.startsWith('Manual-') ? verifiedPeerId.substring(0, 12) : peerInfo.alias;
        this.network.discoveredPeers[verifiedPeerId] = peerInfo;
        
        db.saveContact(verifiedPeerId, peerInfo.alias, serverIdentityPub, pushSubscription);
        this.peerId = verifiedPeerId;
        this.network.registerConnection(verifiedPeerId, this);
        this.network.wsNotify('PEER_MIGRATED', { tempId, realId: verifiedPeerId, peer: peerInfo });
      } else {
        throw new Error(`Identity mismatch: expected ${this.peerId}, got ${verifiedPeerId}`);
      }
    } else {
      this.peerId = verifiedPeerId;
      this.peerIdentityPub = serverIdentityPub;
      
      // Save to Database
      db.saveContact(this.peerId, this.peerAlias, serverIdentityPub, pushSubscription);
      
      // Register TCP socket
      this.network.registerConnection(this.peerId, this);
    }
    
    this.state = 'SECURE';
    this.network.logHandshake(this.peerId, 'secure', 'Successfully verified server signature. Connection is fully SECURED (AES-256-GCM + PFS).');
    
    if (this.onSecure) this.onSecure();
  }

  // --- Messaging and Data Protocols ---
  
  sendMessage(text) {
    if (this.state !== 'SECURE') {
      throw new Error('Cannot send message. Channel is not secure.');
    }
    
    const packet = JSON.stringify({ text, timestamp: new Date().toISOString() });
    const encrypted = encrypt(packet, this.outboundKey);
    
    this.sendFrame(FRAME_MSG_TEXT, Buffer.from(JSON.stringify(encrypted), 'utf8'));
  }

  handleEncryptedMessage(payload) {
    const encryptedObj = JSON.parse(payload.toString('utf8'));
    const decryptedBuffer = decrypt(encryptedObj, this.inboundKey);
    const data = JSON.parse(decryptedBuffer.toString('utf8'));
    
    // Store message in database
    const msg = db.saveMessage(this.peerId, this.peerId, data.text);
    
    // Notify Frontend
    this.network.wsNotify('NEW_MESSAGE', { peerId: this.peerId, message: msg });
  }

  // --- Chunked P2P File Sharing (Images / Videos) ---
  
  async sendFile(fileMetadata, fileBuffer, progressCallback) {
    if (this.state !== 'SECURE') {
      throw new Error('Cannot send file. Channel is not secure.');
    }

    const fileId = crypto.randomUUID();
    const chunkSize = 64 * 1024; // 64KB chunks
    const totalChunks = Math.ceil(fileBuffer.length / chunkSize);

    // 1. Send FILE_START
    const startPayload = JSON.stringify({
      fileId,
      name: fileMetadata.name,
      size: fileMetadata.size,
      type: fileMetadata.type,
      totalChunks
    });
    const encStart = encrypt(startPayload, this.outboundKey);
    this.sendFrame(FRAME_FILE_START, Buffer.from(JSON.stringify(encStart), 'utf8'));
    
    // 2. Loop and send chunks with small intervals to prevent network congestion
    for (let i = 0; i < totalChunks; i++) {
      if (this.state === 'CLOSED') return;
      
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, fileBuffer.length);
      const chunkBytes = fileBuffer.slice(start, end);
      
      // Encrypt raw buffer chunk
      const encChunk = encrypt(chunkBytes, this.outboundKey);
      
      const chunkPayload = JSON.stringify({
        fileId,
        chunkIndex: i,
        iv: encChunk.iv,
        ciphertext: encChunk.ciphertext,
        tag: encChunk.tag
      });

      this.sendFrame(FRAME_FILE_CHUNK, Buffer.from(chunkPayload, 'utf8'));
      
      if (progressCallback) {
        progressCallback(i + 1, totalChunks);
      }
      
      // Wait 10ms to let socket flush
      await new Promise(r => setTimeout(r, 10));
    }

    // 3. Send FILE_END
    const endPayload = JSON.stringify({ fileId });
    const encEnd = encrypt(endPayload, this.outboundKey);
    this.sendFrame(FRAME_FILE_END, Buffer.from(JSON.stringify(encEnd), 'utf8'));
  }

  handleFileStart(payload) {
    const encryptedObj = JSON.parse(payload.toString('utf8'));
    const decryptedBuffer = decrypt(encryptedObj, this.inboundKey);
    const meta = JSON.parse(decryptedBuffer.toString('utf8'));

    const { fileId, name, size, type, totalChunks } = meta;
    const safeName = `${Date.now()}-${name.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    const filePath = path.join(this.network.downloadsDir, safeName);
    
    const writeStream = fs.createWriteStream(filePath);
    
    this.activeDownloads[fileId] = {
      writeStream,
      filePath,
      name,
      size,
      type,
      totalChunks,
      receivedChunks: 0
    };

    console.log(`Starting incoming file transfer: ${name} (${size} bytes)`);
    this.network.wsNotify('FILE_PROGRESS', { peerId: this.peerId, fileId, name, progress: 0, status: 'receiving' });
  }

  handleFileChunk(payload) {
    const data = JSON.parse(payload.toString('utf8'));
    const download = this.activeDownloads[data.fileId];
    if (!download) return;

    // Decrypt the raw binary bytes of this chunk
    const chunkDecrypted = decrypt({
      iv: data.iv,
      ciphertext: data.ciphertext,
      tag: data.tag
    }, this.inboundKey);

    download.writeStream.write(chunkDecrypted);
    download.receivedChunks++;

    const percent = Math.round((download.receivedChunks / download.totalChunks) * 100);
    this.network.wsNotify('FILE_PROGRESS', {
      peerId: this.peerId,
      fileId: data.fileId,
      name: download.name,
      progress: percent,
      status: 'receiving'
    });
  }

  handleFileEnd(payload) {
    const encryptedObj = JSON.parse(payload.toString('utf8'));
    const decryptedBuffer = decrypt(encryptedObj, this.inboundKey);
    const { fileId } = JSON.parse(decryptedBuffer.toString('utf8'));

    const download = this.activeDownloads[fileId];
    if (!download) return;

    download.writeStream.end(() => {
      delete this.activeDownloads[fileId];
      console.log(`File transfer completed and written to: ${download.filePath}`);
      
      // Save message in local db representing the file transfer
      const fileData = {
        name: download.name,
        size: download.size,
        type: download.type,
        // Frontend will fetch this file from daemon via HTTP: GET /files/:filename
        url: `http://localhost:${process.env.HTTP_PORT}/files/${path.basename(download.filePath)}`,
        localPath: download.filePath
      };

      const msg = db.saveMessage(this.peerId, this.peerId, `Sent file: ${download.name}`, fileData);
      
      this.network.wsNotify('FILE_PROGRESS', { peerId: this.peerId, fileId, name: download.name, progress: 100, status: 'complete' });
      this.network.wsNotify('NEW_MESSAGE', { peerId: this.peerId, message: msg });
    });
  }
}
