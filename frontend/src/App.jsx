import React, { useState, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { Nodejs } from '@capawesome/capacitor-nodejs';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import HandshakeConsole from './components/HandshakeConsole';

export default function App() {
  // Start the embedded Node.js daemon if running natively on mobile
  useEffect(() => {
    if (Capacitor.isNativePlatform()) {
      console.log('[App] Starting native embedded Node.js service...');
      Nodejs.start()
        .then(() => {
          console.log('[App] Native Node.js service started.');
          // Listen for error messages from the background Node.js process
          Nodejs.addListener('message', (event) => {
            if (event.eventName === 'error') {
              alert(`[Node Daemon Error]\n\n${event.args[0].message}\n\n${event.args[0].stack}`);
            }
          });
        })
        .catch(err => {
          console.error('[App] Failed to start native Node.js:', err);
          alert('Failed to start Node.js: ' + err.message);
        });
    }
  }, []);

  const [profile, setProfile] = useState(null);
  const [peers, setPeers] = useState([]);
  const [activePeer, setActivePeer] = useState(null);
  const [messages, setMessages] = useState([]);
  const [handshakeLogs, setHandshakeLogs] = useState([]);
  const [fileProgress, setFileProgress] = useState(null);
  const [connected, setConnected] = useState(false);
  const [showConsole, setShowConsole] = useState(true);
  
  const wsRef = useRef(null);
  const activePeerRef = useRef(null);
  const peersRef = useRef([]);

  // Sync peers ref to prevent stale closures in WebSocket event listeners
  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);


  // Auto-hide console by default on small windows
  useEffect(() => {
    if (window.innerWidth < 980) {
      setShowConsole(false);
    }
  }, []);

  // Sync ref to allow accessing activePeer inside async WS callbacks
  useEffect(() => {
    activePeerRef.current = activePeer;
    if (activePeer) {
      // Fetch history for new active peer
      sendWsCmd({ type: 'GET_MESSAGES', peerId: activePeer.peerId });
    } else {
      setMessages([]);
    }
  }, [activePeer]);

  // Helper to register background Service Worker and fetch VAPID keys for Web Push
  const registerPushNotifications = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.warn('Service Workers or Push Notifications are not supported in this browser.');
      return;
    }

    try {
      // 1. Register sw.js
      const registration = await navigator.serviceWorker.register('/sw.js');
      console.log('Service Worker registered:', registration);

      // 2. Fetch VAPID public key
      const relayHttpUrl = import.meta.env.VITE_RELAY_HTTP_URL || 'https://call-of-ssh-relay.onrender.com';
      const response = await fetch(`${relayHttpUrl}/vapid-public-key`);
      const { publicKey } = await response.json();

      // Convert VAPID key base64 to Uint8Array
      const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
      const base64 = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
      const rawData = window.atob(base64);
      const outputArray = new Uint8Array(rawData.length);
      for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
      }

      // 3. Register browser subscription
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: outputArray
      });

      console.log('Registered Web Push subscription:', subscription);

      // 4. Update local daemon IPC
      sendWsCmd({
        type: 'REGISTER_PUSH_SUBSCRIPTION',
        subscription
      });
    } catch (err) {
      console.error('Failed to register Web Push notifications:', err);
    }
  };

  // Connect to Local Daemon WebSocket
  useEffect(() => {
    let reconnectTimer;
    let isUnmounted = false;
    
    const connect = () => {
      if (isUnmounted) return;
      const wsPort = import.meta.env.VITE_WS_PORT || '9001';
      const wsUrl = `ws://localhost:${wsPort}`;
      console.log(`Connecting to local P2P daemon at ${wsUrl}`);
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (isUnmounted) return;
        console.log('WS connected to P2P daemon');
        setConnected(true);
        // Request profile and peer list immediately
        sendWsCmd({ type: 'GET_PROFILE' });
        sendWsCmd({ type: 'GET_PEERS' });
        registerPushNotifications();
      };

      ws.onclose = () => {
        if (isUnmounted) return;
        console.log('WS disconnected from P2P daemon. Retrying in 2s...');
        setConnected(false);
        setProfile(null);
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onerror = (err) => {
        console.error('WS Error:', err);
      };

      ws.onmessage = (event) => {
        if (isUnmounted) return;
        try {
          const { type, data } = JSON.parse(event.data);
          handleDaemonMessage(type, data);
        } catch (err) {
          console.error('Failed to parse incoming WS message:', err);
        }
      };
    };

    connect();

    return () => {
      isUnmounted = true;
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []);

  const sendWsCmd = (cmd) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(cmd));
    }
  };

  const handleDaemonMessage = (type, data) => {
    switch (type) {
      case 'PROFILE_INFO':
        setProfile(data);
        break;

      case 'PEER_LIST':
        setPeers(data);
        break;

      case 'PEER_DISCOVERED':
        sendWsCmd({ type: 'GET_PEERS' });
        break;

      case 'PEER_CONNECTED':
        sendWsCmd({ type: 'GET_PEERS' });
        break;

      case 'PEER_DISCONNECTED':
        sendWsCmd({ type: 'GET_PEERS' });
        break;

      case 'PEER_MIGRATED': {
        const { tempId, realId, peer } = data;
        
        // 1. Refetch peers list from daemon
        sendWsCmd({ type: 'GET_PEERS' });

        // 2. If the active peer was the manual temporary one, migrate selection
        if (activePeerRef.current?.peerId === tempId) {
          setActivePeer(peer);
        }

        // 3. Migrate handshake logs from tempId to realId
        setHandshakeLogs((prev) =>
          prev.map((log) => (log.peerId === tempId ? { ...log, peerId: realId } : log))
        );
        break;
      }

      case 'MESSAGE_HISTORY':
        if (activePeerRef.current?.peerId === data.peerId) {
          setMessages(data.messages);
        }
        break;

      case 'MESSAGE_SENT':
        if (activePeerRef.current?.peerId === data.peerId) {
          setMessages((prev) => [...prev, data.message]);
        }
        break;

      case 'NEW_MESSAGE':
        if (activePeerRef.current?.peerId === data.peerId) {
          setMessages((prev) => [...prev, data.message]);
        } else {
          // Highlight unread peers (console print for debugging)
          console.log(`New message received from inactive peer ${data.peerId}`);
        }

        // Trigger HTML5 Web Notification
        if ('Notification' in window && Notification.permission === 'granted') {
          // Find sender alias using peers ref
          const sender = peersRef.current.find((p) => p.peerId === data.peerId);
          const senderName = sender ? sender.alias : data.peerId.substring(0, 12);

          // Alert only if browser tab is hidden OR user is looking at a different chat channel
          if (document.hidden || activePeerRef.current?.peerId !== data.peerId) {
            new Notification(`Call of SSH: Message from ${senderName}`, {
              body: data.message.text || 'Sent you a media attachment',
              tag: data.peerId // Group notifications by peerId
            });
          }
        }
        break;

      case 'FILE_PROGRESS':
        if (activePeerRef.current?.peerId === data.peerId) {
          setFileProgress(data);
        }
        break;

      case 'HANDSHAKE_STEP':
        setHandshakeLogs((prev) => [...prev, data]);
        break;

      case 'SEND_ERROR':
        // Add failure trace to logs
        setHandshakeLogs((prev) => [
          ...prev,
          {
            peerId: data.peerId,
            type: 'error',
            message: `Handshake / Connection Error: ${data.error}`,
            timestamp: new Date().toISOString()
          }
        ]);
        break;

      default:
        console.warn('Unhandled message type from daemon:', type);
    }
  };

  const handleSendMessage = (text) => {
    if (!activePeer) return;
    sendWsCmd({
      type: 'SEND_MESSAGE',
      peerId: activePeer.peerId,
      text
    });
  };

  const handleSendFile = (fileObj) => {
    if (!activePeer) return;
    sendWsCmd({
      type: 'SEND_FILE',
      peerId: activePeer.peerId,
      fileId: crypto.randomUUID(),
      name: fileObj.name,
      fileType: fileObj.type,
      size: fileObj.size,
      base64Data: fileObj.base64Data
    });
  };

  const handleUpdateAlias = (newAlias) => {
    sendWsCmd({
      type: 'SET_ALIAS',
      alias: newAlias
    });
  };

  const handleManualConnect = (peerDetails) => {
    sendWsCmd({
      type: 'MANUAL_CONNECT',
      ip: peerDetails.ip,
      port: peerDetails.port,
      alias: peerDetails.alias
    });
  };

  const handleAddContact = (peerId, alias) => {
    sendWsCmd({
      type: 'ADD_CONTACT',
      peerId,
      alias
    });
  };

  const handleSelectPeer = (peer) => {
    setActivePeer(peer);
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch((err) => {
        console.log('Push notification permission prompt skipped:', err);
      });
    }
  };

  return (
    <main className={`app-container ${activePeer ? 'has-active-peer' : ''} ${showConsole ? 'console-open' : 'console-closed'}`}>
      <Sidebar
        profile={profile}
        peers={peers}
        activePeer={activePeer}
        setActivePeer={handleSelectPeer}
        onUpdateAlias={handleUpdateAlias}
        onManualConnect={handleManualConnect}
        onAddContact={handleAddContact}
      />
      <ChatArea
        activePeer={activePeer}
        messages={messages}
        fileProgress={fileProgress}
        onSendMessage={handleSendMessage}
        onSendFile={handleSendFile}
        onBack={() => setActivePeer(null)}
        onToggleConsole={() => setShowConsole(!showConsole)}
        showConsole={showConsole}
      />
      <HandshakeConsole logs={handshakeLogs} activePeer={activePeer} />
    </main>
  );
}
