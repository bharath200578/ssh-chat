import React, { useState, useRef, useEffect } from 'react';
import { Send, Paperclip, Shield, Image, Film, File, MessageSquare, ArrowLeft, Terminal } from 'lucide-react';

export default function ChatArea({
  activePeer,
  messages,
  fileProgress,
  onSendMessage,
  onSendFile,
  onBack,
  onToggleConsole,
  showConsole
}) {
  const [inputText, setInputText] = useState('');
  const [lightboxImage, setLightboxImage] = useState(null);
  const messagesContainerRef = useRef(null);
  const fileInputRef = useRef(null);

  // Auto-scroll only the message container to the bottom
  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages, fileProgress]);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (inputText.trim()) {
      onSendMessage(inputText.trim());
      setInputText('');
    }
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Convert file to Base64 to transmit over WebSocket IPC
    const reader = new FileReader();
    reader.onload = () => {
      const base64Data = reader.result.split(',')[1];
      onSendFile({
        name: file.name,
        type: file.type,
        size: file.size,
        base64Data
      });
    };
    reader.readAsDataURL(file);
    
    // Clear input
    e.target.value = '';
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  const formatSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (!activePeer) {
    return (
      <section className="chat-area chat-empty">
        <Shield size={64} />
        <h2>Secure Peer-to-Peer Tunnel</h2>
        <p>
          Select a discovered peer from the sidebar to establish an encrypted session.
          All messages and media are transferred directly without intermediary servers.
        </p>
      </section>
    );
  }

  return (
    <section className="chat-area">
      {/* Chat Header */}
      <header className="chat-header">
        <div className="chat-header-info">
          <button 
            type="button" 
            className="back-btn" 
            onClick={onBack}
            title="Back to peer list"
          >
            <ArrowLeft size={20} />
          </button>
          
          <div className="avatar remote">
            {activePeer.alias.substring(0, 2).toUpperCase()}
          </div>
          <div className="chat-header-text">
            <h3>{activePeer.alias}</h3>
            <span>{activePeer.peerId}</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="secured-badge" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', color: 'var(--color-success)', background: 'rgba(57, 255, 20, 0.05)', padding: '6px 12px', borderRadius: '8px', border: '1px solid rgba(57, 255, 20, 0.1)' }}>
            <Shield size={14} /> E2EE Secured
          </div>
          
          <button
            type="button"
            className={`console-toggle-btn ${showConsole ? 'active' : ''}`}
            onClick={onToggleConsole}
            title="Toggle Security Console"
          >
            <Terminal size={20} />
          </button>
        </div>
      </header>

      {/* Message Feed */}
      <div className="chat-messages" ref={messagesContainerRef}>
        {messages.length === 0 ? (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            <MessageSquare size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
            <p>No messages yet. Send a text or file to start the secure session.</p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = msg.sender === 'me';
            return (
              <div key={msg.id} className={`message-row ${isMe ? 'sent' : 'received'}`}>
                <div className="message-bubble">
                  {/* File Attachment Payload */}
                  {msg.file && (
                    <div className="message-media">
                      {msg.file.type?.startsWith('image/') ? (
                        <img
                          src={msg.file.url}
                          alt={msg.file.name}
                          onClick={() => setLightboxImage(msg.file.url)}
                        />
                      ) : msg.file.type?.startsWith('video/') ? (
                        <video src={msg.file.url} controls preload="metadata" />
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 12, background: 'rgba(0,0,0,0.2)' }}>
                          <File size={28} style={{ color: 'var(--color-primary)' }} />
                          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                            <span style={{ fontSize: '0.85rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{msg.file.name}</span>
                            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{formatSize(msg.file.size)}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* Text Payload */}
                  {msg.text && <p>{msg.text}</p>}
                  
                  <span className="message-time">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Input Bar & Progress bar */}
      <div className="chat-input-bar">
        {/* Upload / Download File Progress */}
        {fileProgress && fileProgress.status !== 'complete' && (
          <div className="file-progress-container">
            <div className="file-progress-header">
              <span>{fileProgress.status === 'sending' ? 'Encrypting & Sending:' : 'Receiving & Decrypting:'} {fileProgress.name}</span>
              <span>{fileProgress.progress}%</span>
            </div>
            <div className="file-progress-bar-bg">
              <div
                className="file-progress-bar-fill"
                style={{ width: `${fileProgress.progress}%` }}
              ></div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="chat-input-form">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            style={{ display: 'none' }}
            accept="image/*,video/*"
          />
          <button
            type="button"
            className="attachment-btn"
            onClick={triggerFileSelect}
            title="Attach Image or Video"
          >
            <Paperclip size={20} />
          </button>
          <input
            type="text"
            className="text-input"
            placeholder={`Type a secure message for ${activePeer.alias}...`}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
          />
          <button type="submit" className="send-btn">
            <Send size={18} />
          </button>
        </form>
      </div>

      {/* Lightbox Modal */}
      {lightboxImage && (
        <div className="media-modal" onClick={() => setLightboxImage(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <img src={lightboxImage} alt="Lightbox Preview" />
            <button className="modal-close" onClick={() => setLightboxImage(null)}>Close [X]</button>
          </div>
        </div>
      )}
    </section>
  );
}
