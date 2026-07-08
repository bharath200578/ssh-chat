import React, { useState } from 'react';
import { User, Copy, Check, Radio, Network, Plus, Compass } from 'lucide-react';

export default function Sidebar({
  profile,
  peers,
  activePeer,
  setActivePeer,
  onUpdateAlias,
  onManualConnect
}) {
  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasInput, setAliasInput] = useState('');
  const [copied, setCopied] = useState(false);
  
  // Manual connection form
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualIp, setManualIp] = useState('127.0.0.1');
  const [manualPort, setManualPort] = useState('');
  const [manualAlias, setManualAlias] = useState('');

  // Add Contact by Peer ID form
  const [showAddContactForm, setShowAddContactForm] = useState(false);
  const [contactPeerId, setContactPeerId] = useState('');
  const [contactAlias, setContactAlias] = useState('');

  const copyPeerId = () => {
    if (!profile?.peerId) return;
    navigator.clipboard.writeText(profile.peerId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleAliasSubmit = (e) => {
    e.preventDefault();
    if (aliasInput.trim()) {
      onUpdateAlias(aliasInput.trim());
      setEditingAlias(false);
    }
  };

  const startEditAlias = () => {
    setAliasInput(profile?.alias || '');
    setEditingAlias(true);
  };

  const handleManualDial = (e) => {
    e.preventDefault();
    if (!manualPort) return;
    
    onManualConnect({
      ip: manualIp,
      port: parseInt(manualPort),
      alias: manualAlias.trim() || `ManualPeer-${manualPort}`
    });
    
    setManualPort('');
    setManualAlias('');
    setShowManualForm(false);
  };

  const handleAddContactSubmit = (e) => {
    e.preventDefault();
    if (!contactPeerId.trim()) return;

    if (onAddContact) {
      onAddContact(contactPeerId.trim(), contactAlias.trim());
    }

    setContactPeerId('');
    setContactAlias('');
    setShowAddContactForm(false);
  };

  return (
    <aside className="sidebar">
      {/* Profile Section */}
      <div className="profile-section">
        <div className="profile-header">
          <div className="avatar">
            {profile?.alias ? profile.alias.substring(0, 2).toUpperCase() : 'ME'}
          </div>
          <div className="profile-info">
            {editingAlias ? (
              <form onSubmit={handleAliasSubmit}>
                <input
                  type="text"
                  className="alias-edit-input"
                  value={aliasInput}
                  onChange={(e) => setAliasInput(e.target.value)}
                  onBlur={() => setEditingAlias(false)}
                  maxLength={15}
                  autoFocus
                />
              </form>
            ) : (
              <h3 onClick={startEditAlias} style={{ cursor: 'pointer' }} title="Click to edit nickname">
                {profile?.alias || 'Loading...'}
                <span className="status-dot" style={{ marginLeft: 6 }}></span>
              </h3>
            )}
            <span className="peer-id-badge" onClick={copyPeerId} title="Click to copy Peer ID">
              {profile?.peerId ? (
                <>
                  {profile.peerId.substring(0, 15)}...
                  {copied ? <Check size={10} style={{ marginLeft: 4, color: 'var(--color-success)' }} /> : <Copy size={10} style={{ marginLeft: 4 }} />}
                </>
              ) : 'Generating key...'}
            </span>
          </div>
        </div>
      </div>

      {/* Manual Connection & Add Contact Actions */}
      <div style={{ padding: '12px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={() => {
            setShowManualForm(!showManualForm);
            setShowAddContactForm(false);
          }}
          style={{
            width: '100%',
            background: showManualForm ? 'rgba(255,255,255,0.05)' : 'rgba(0, 240, 255, 0.08)',
            border: '1px dashed var(--border-glow)',
            color: 'var(--text-main)',
            padding: '8px 12px',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            transition: 'var(--transition-fast)'
          }}
        >
          <Plus size={14} />
          {showManualForm ? 'Cancel Manual Connect' : 'Connect via IP/Port'}
        </button>

        <button
          onClick={() => {
            setShowAddContactForm(!showAddContactForm);
            setShowManualForm(false);
          }}
          style={{
            width: '100%',
            background: showAddContactForm ? 'rgba(255,255,255,0.05)' : 'rgba(0, 240, 255, 0.08)',
            border: '1px dashed var(--border-glow)',
            color: 'var(--text-main)',
            padding: '8px 12px',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            transition: 'var(--transition-fast)'
          }}
        >
          <User size={14} />
          {showAddContactForm ? 'Cancel Add Contact' : 'Add Friend by Peer ID'}
        </button>

        {showManualForm && (
          <form onSubmit={handleManualDial} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              type="text"
              placeholder="IP Address (e.g. 127.0.0.1)"
              value={manualIp}
              onChange={(e) => setManualIp(e.target.value)}
              className="alias-edit-input"
              style={{ margin: 0 }}
              required
            />
            <input
              type="number"
              placeholder="TCP Port (e.g. 22002)"
              value={manualPort}
              onChange={(e) => setManualPort(e.target.value)}
              className="alias-edit-input"
              style={{ margin: 0 }}
              required
            />
            <input
              type="text"
              placeholder="Nickname (optional)"
              value={manualAlias}
              onChange={(e) => setManualAlias(e.target.value)}
              className="alias-edit-input"
              style={{ margin: 0 }}
            />
            <button
              type="submit"
              style={{
                background: 'var(--color-primary)',
                color: '#000',
                border: 'none',
                padding: '6px 12px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.85rem'
              }}
            >
              Dial Node
            </button>
          </form>
        )}

        {showAddContactForm && (
          <form onSubmit={handleAddContactSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              type="text"
              placeholder="Peer ID (ssh-p2p:...)"
              value={contactPeerId}
              onChange={(e) => setContactPeerId(e.target.value)}
              className="alias-edit-input"
              style={{ margin: 0 }}
              required
            />
            <input
              type="text"
              placeholder="Nickname"
              value={contactAlias}
              onChange={(e) => setContactAlias(e.target.value)}
              className="alias-edit-input"
              style={{ margin: 0 }}
            />
            <button
              type="submit"
              style={{
                background: 'var(--color-primary)',
                color: '#000',
                border: 'none',
                padding: '6px 12px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '0.85rem'
              }}
            >
              Add Contact
            </button>
          </form>
        )}
      </div>

      {/* Discovered Peers Section */}
      <div className="peers-list-section">
        <h4 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Compass size={12} /> Discovered Peers (P2P)
        </h4>
        {peers.length === 0 ? (
          <div style={{ padding: '0 24px', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Searching network... Run another daemon instance to connect automatically.
          </div>
        ) : (
          peers.map((peer) => {
            const isActive = activePeer?.peerId === peer.peerId;
            return (
              <div
                key={peer.peerId}
                className={`peer-item ${isActive ? 'active' : ''}`}
                onClick={() => setActivePeer(peer)}
              >
                <div className="avatar remote">
                  {peer.alias.substring(0, 2).toUpperCase()}
                </div>
                <div className="peer-item-info">
                  <div className="peer-item-header">
                    <span className="peer-name">{peer.alias}</span>
                    <span className={`status-dot ${peer.online ? 'online' : 'offline'}`}></span>
                  </div>
                  <span className="peer-address">
                    {peer.online ? `${peer.ip}:${peer.port}` : 'Offline (relayed)'}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* System Metrics */}
      <div className="network-details">
        <h4 style={{ fontSize: '0.75rem', textTransform: 'uppercase', marginBottom: 4, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Network size={12} /> Local Node Network
        </h4>
        <span>
          <span>TCP Daemon Port:</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{profile?.tcpPort || '...'}</span>
        </span>
        <span>
          <span>WS IPC Port:</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{profile?.wsPort || '...'}</span>
        </span>
        <span>
          <span>Multicast Group:</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>239.255.255.250</span>
        </span>
      </div>
    </aside>
  );
}
