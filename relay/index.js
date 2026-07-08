import http from 'http';
import { WebSocketServer } from 'ws';
import url from 'url';
import webpush from 'web-push';

const PORT = parseInt(process.env.PORT) || 8080;

// In-memory queue for offline peers (peerId -> Array of queued messages)
const offlineQueues = new Map();

// Active WebSocket connections (peerId -> WebSocket client)
const activeConnections = new Map();

console.log('==========================================');
console.log('   Starting Call of SSH Relay Server      ');
console.log('==========================================');

// 1. Web Push VAPID credentials
let vapidKeys = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};

if (!vapidKeys.publicKey || !vapidKeys.privateKey) {
  console.log('No VAPID keys in environment. Generating dynamic keypair for testing...');
  const keys = webpush.generateVAPIDKeys();
  vapidKeys = keys;
  console.log('Dynamic VAPID Public Key:', vapidKeys.publicKey);
}

webpush.setVapidDetails(
  'mailto:call-of-ssh-support@example.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// 2. HTTP Server to serve VAPID Public Key to frontend clients
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  if (parsedUrl.pathname === '/vapid-public-key' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ publicKey: vapidKeys.publicKey }));
  } else if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Relay Server is Online');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// 3. WebSocket Broker Server
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, req) => {
  const parsedUrl = url.parse(req.url, true);
  const peerId = parsedUrl.query.peerId;

  if (!peerId) {
    console.log('Connection rejected: missing peerId query parameter.');
    ws.close(4001, 'Missing peerId');
    return;
  }

  // Register peer connection
  console.log(`Peer connected to relay: ${peerId}`);
  activeConnections.set(peerId, ws);

  // Deliver any queued offline messages
  if (offlineQueues.has(peerId)) {
    const queue = offlineQueues.get(peerId);
    console.log(`Delivering ${queue.length} queued messages to newly connected peer: ${peerId}`);
    while (queue.length > 0) {
      const msg = queue.shift();
      ws.send(JSON.stringify({
        type: 'RELAY_MSG',
        from: msg.from,
        payload: msg.payload
      }));
    }
    offlineQueues.delete(peerId);
  }

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      if (data.type === 'RELAY_MSG') {
        const { to, payload, pushSubscription, notificationText } = data;
        
        if (!to || !payload) {
          console.warn(`Malformed RELAY_MSG from ${peerId}: missing target or payload.`);
          return;
        }

        const recipientWs = activeConnections.get(to);

        if (recipientWs && recipientWs.readyState === 1) { // OPEN
          // Route immediately
          recipientWs.send(JSON.stringify({
            type: 'RELAY_MSG',
            from: peerId,
            payload
          }));
          console.log(`Relayed message from ${peerId} to online peer ${to}`);
        } else {
          // Recipient is offline, queue the message
          console.log(`Recipient ${to} is offline. Queueing message from ${peerId}.`);
          if (!offlineQueues.has(to)) {
            offlineQueues.set(to, []);
          }
          offlineQueues.get(to).push({
            from: peerId,
            payload
          });

          // Trigger Web Push Notification if a subscription is supplied
          if (pushSubscription) {
            console.log(`Firing background Web Push notification to offline recipient ${to}`);
            try {
              const pushPayload = JSON.stringify({
                title: 'Call of SSH',
                body: notificationText || 'You received a new encrypted message.',
                peerId: peerId
              });
              
              await webpush.sendNotification(pushSubscription, pushPayload);
              console.log('Web Push Notification delivered successfully.');
            } catch (err) {
              console.error('Failed to deliver Web Push notification:', err.message);
            }
          }
        }
      }
    } catch (err) {
      console.error(`Error processing WebSocket message from ${peerId}:`, err);
    }
  });

  ws.on('close', () => {
    console.log(`Peer disconnected from relay: ${peerId}`);
    activeConnections.delete(peerId);
  });

  ws.on('error', (err) => {
    console.error(`Socket error for peer ${peerId}:`, err);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Relay Server running on port ${PORT}`);
  console.log(`VAPID Public Key Endpoint: http://localhost:${PORT}/vapid-public-key`);
});
