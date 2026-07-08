import React, { useRef, useEffect } from 'react';
import { Terminal, ShieldAlert, X } from 'lucide-react';

export default function HandshakeConsole({ logs, activePeer, onClose }) {
  const consoleEndRef = useRef(null);

  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Filter logs for the active peer only
  const activeLogs = logs.filter(log => log.peerId === activePeer?.peerId);

  return (
    <section className="security-console">
      <header className="console-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Terminal size={18} />
          <h3>Security Console</h3>
        </div>
        <button 
          onClick={onClose} 
          style={{ 
            background: 'none', 
            border: 'none', 
            color: 'var(--text-dark)', 
            cursor: 'pointer',
            padding: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'color 0.2s'
          }}
          onMouseEnter={(e) => e.currentTarget.style.color = 'var(--color-primary)'}
          onMouseLeave={(e) => e.currentTarget.style.color = 'var(--text-dark)'}
          title="Close Console"
        >
          <X size={18} />
        </button>
      </header>

      <div className="console-logs">
        {!activePeer ? (
          <div className="console-empty">
            <pre style={{ color: 'var(--color-primary-glow)', fontSize: '0.8rem', lineHeight: 1.2 }}>
{`
  ___  __   _    _      ___  ____ 
 / __)/ _\\ ( )  ( )    / __)/ ___)
( (_ /    \\| (__| (__ ( (_  \\___ \\
 \\___)\\_/\\_/(____(____)\\___)(____/
 `}
            </pre>
            <p style={{ fontSize: '0.75rem', maxWidth: 220 }}>
              Listening for local multicast heartbeats. Select a contact to monitor connection negotiation.
            </p>
          </div>
        ) : activeLogs.length === 0 ? (
          <div className="console-empty">
            <ShieldAlert size={24} style={{ color: 'var(--text-dark)' }} />
            <p style={{ fontSize: '0.75rem', color: 'var(--text-dark)' }}>
              No active session logs. Send a message to dial TCP port and execute handshake.
            </p>
          </div>
        ) : (
          <>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-dark)', borderBottom: '1px dashed rgba(255,255,255,0.05)', paddingBottom: 6 }}>
              --- SECURE SHELL SESSION LOGS ---
            </div>
            {activeLogs.map((log, index) => (
              <div key={index} className={`log-entry ${log.type}`}>
                <span className="log-time">
                  {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <div>{log.message}</div>
              </div>
            ))}
            <div ref={consoleEndRef} />
          </>
        )}
      </div>
    </section>
  );
}
