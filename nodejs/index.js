import { createRequire } from 'module';
const require = createRequire(import.meta.url);
try {
  const bridge = require('bridge');
  bridge.channel.on('message', (msg) => {
    console.log('[Node] Message from WebView:', msg);
  });
  process.on('uncaughtException', (err) => {
    try {
      bridge.channel.send('error', { message: err.message, stack: err.stack });
    } catch (e) {}
    console.error('[Node Uncaught Exception]:', err);
  });
} catch (e) {
  console.log('[Node] Capawesome bridge not available.');
}

import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import db from './db.js';
import { generateIdentityKeypair, getFingerprint } from './crypto.js';
import { P2PNetwork } from './network.js';

const PORT = parseInt(process.env.PORT) || 22001;
const WS_PORT = parseInt(process.env.WS_PORT) || 9001;
const HTTP_PORT = parseInt(process.env.HTTP_PORT) || 8001;

console.log('==========================================');
console.log('   Starting Call of SSH Daemon Engine     ');
console.log('==========================================');

// 1. Identity Key generation/load
if (!db.getIdentity()) {
  console.log('No identity found. Generating new Ed25519 keypair...');
  const { publicKey, privateKey } = generateIdentityKeypair();
  db.setIdentity(publicKey, privateKey);
}

const myIdentity = db.getIdentity();
const myPeerId = getFingerprint(myIdentity.publicKey);
console.log(`Identity Public Key Loaded.`);
console.log(`Local Peer ID: ${myPeerId}`);
console.log(`Local Username (Alias): ${db.getAlias()}`);

// 2. WebSocket IPC clients collection
const wsClients = new Set();
function notifyWsClients(type, data) {
  const payload = JSON.stringify({ type, data });
  wsClients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(payload);
    }
  });
}

// 3. Initialize P2P networking layer
const p2p = new P2PNetwork(PORT, notifyWsClients);
p2p.myPushSubscription = db.data.pushSubscription || null;
p2p.start();

// 4. Start HTTP Media File Server (to serve downloads locally to UI)
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url);
  const pathname = decodeURIComponent(parsedUrl.pathname);
  
  if (pathname.startsWith('/files/')) {
    const filename = path.basename(pathname);
    const filePath = path.join(p2p.downloadsDir, filename);

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.txt': 'text/plain'
      };
      
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      
      const stream = fs.createReadStream(filePath);
      stream.on('error', (err) => {
        console.error('File stream error:', err);
        res.writeHead(500);
        res.end('Internal Server Error');
      });
      stream.pipe(res);
    } else {
      res.writeHead(404);
      res.end('File not found');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`Media serving HTTP server running on http://localhost:${HTTP_PORT}`);
});

// 5. Start WebSocket server for UI IPC
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`Frontend UI connected to WS IPC on port ${WS_PORT}`);

  ws.on('message', async (message) => {
    try {
      const command = JSON.parse(message.toString());
      await handleWsCommand(ws, command);
    } catch (err) {
      console.error('Failed to handle WS message:', err);
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log('Frontend UI disconnected');
  });
});

async function handleWsCommand(ws, cmd) {
  const sendResponse = (type, data) => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type, data }));
    }
  };

  switch (cmd.type) {
    case 'GET_PROFILE':
      sendResponse('PROFILE_INFO', {
        peerId: myPeerId,
        alias: db.getAlias(),
        tcpPort: PORT,
        wsPort: WS_PORT,
        httpPort: HTTP_PORT
      });
      break;

    case 'REGISTER_PUSH_SUBSCRIPTION': {
      db.data.pushSubscription = cmd.subscription;
      db.save();
      p2p.myPushSubscription = cmd.subscription;
      console.log('Registered Web Push subscription for this node.');
      break;
    }

    case 'SET_ALIAS':
      db.setAlias(cmd.alias);
      sendResponse('PROFILE_INFO', {
        peerId: myPeerId,
        alias: db.getAlias(),
        tcpPort: PORT,
        wsPort: WS_PORT,
        httpPort: HTTP_PORT
      });
      console.log(`Alias updated to: ${cmd.alias}`);
      break;

    case 'GET_PEERS': {
      const contacts = db.getContacts().map(c => ({
        peerId: c.peerId,
        alias: c.alias,
        online: p2p.discoveredPeers[c.peerId] ? true : false,
        ip: p2p.discoveredPeers[c.peerId]?.ip || null,
        port: p2p.discoveredPeers[c.peerId]?.port || null
      }));
      
      const discovered = Object.values(p2p.discoveredPeers).map(p => ({
        peerId: p.peerId,
        alias: p.alias,
        online: true,
        ip: p.ip,
        port: p.port
      }));

      const mergedMap = new Map();
      contacts.forEach(c => mergedMap.set(c.peerId, c));
      discovered.forEach(d => mergedMap.set(d.peerId, d));
      
      sendResponse('PEER_LIST', Array.from(mergedMap.values()));
      break;
    }

    case 'GET_MESSAGES':
      sendResponse('MESSAGE_HISTORY', {
        peerId: cmd.peerId,
        messages: db.getMessages(cmd.peerId)
      });
      break;

    case 'SEND_MESSAGE': {
      const { peerId, text } = cmd;
      try {
        const conn = await p2p.connectToPeer(peerId);
        conn.sendMessage(text);
        
        // Save locally
        const msg = db.saveMessage(peerId, 'me', text);
        sendResponse('MESSAGE_SENT', { peerId, message: msg });
      } catch (err) {
        console.error(`Failed to send message to ${peerId}:`, err);
        sendResponse('SEND_ERROR', { peerId, error: err.message });
      }
      break;
    }

    case 'SEND_FILE': {
      const { peerId, name, fileType, size, base64Data } = cmd;
      try {
        const conn = await p2p.connectToPeer(peerId);
        const fileBuffer = Buffer.from(base64Data, 'base64');
        
        notifyWsClients('FILE_PROGRESS', {
          peerId,
          fileId: cmd.fileId || 'temp-id',
          name,
          progress: 0,
          status: 'sending'
        });

        // Send over connection
        await conn.sendFile({ name, type: fileType, size }, fileBuffer, (sent, total) => {
          const percent = Math.round((sent / total) * 100);
          notifyWsClients('FILE_PROGRESS', {
            peerId,
            fileId: cmd.fileId || 'temp-id',
            name,
            progress: percent,
            status: 'sending'
          });
        });

        // Create local copy in downloads if we want to display it in our own chat
        const safeName = `${Date.now()}-sent-${name.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
        const filePath = path.join(p2p.downloadsDir, safeName);
        fs.writeFileSync(filePath, fileBuffer);

        const fileData = {
          name,
          size,
          type: fileType,
          url: `http://localhost:${HTTP_PORT}/files/${safeName}`,
          localPath: filePath
        };

        const msg = db.saveMessage(peerId, 'me', `Sent file: ${name}`, fileData);
        sendResponse('MESSAGE_SENT', { peerId, message: msg });
        notifyWsClients('FILE_PROGRESS', {
          peerId,
          fileId: cmd.fileId || 'temp-id',
          name,
          progress: 100,
          status: 'complete'
        });
      } catch (err) {
        console.error(`Failed to send file to ${peerId}:`, err);
        sendResponse('SEND_ERROR', { peerId, error: err.message });
      }
      break;
    }

    case 'MANUAL_CONNECT': {
      const { ip, port, alias } = cmd;
      const tempPeerId = `manual:${ip}:${port}`;
      p2p.discoveredPeers[tempPeerId] = {
        peerId: tempPeerId,
        alias: alias || `Manual-${port}`,
        ip,
        port,
        lastSeen: new Date().toISOString()
      };
      
      notifyWsClients('PEER_DISCOVERED', p2p.discoveredPeers[tempPeerId]);
      
      console.log(`Manual dial command: Dialing TCP peer at ${ip}:${port}`);
      p2p.connectToPeer(tempPeerId).catch((err) => {
        console.error(`Manual connection failed to ${ip}:${port}:`, err);
        sendResponse('SEND_ERROR', { peerId: tempPeerId, error: err.message });
      });
      break;
    }

    default:
      console.warn('Unknown WebSocket command:', cmd.type);
  }
}
