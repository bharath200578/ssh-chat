import fs from 'fs';
import path from 'path';

class LocalDatabase {
  constructor() {
    const defaultDbPath = process.env.TMPDIR ? path.join(process.env.TMPDIR, 'node_db.json') : './db.json';
    this.filePath = process.env.DB_PATH || defaultDbPath;
    this.data = {
      identity: null,
      alias: process.env.ALIAS || 'Peer',
      contacts: {},
      messages: {}
    };
    this.init();
  }

  init() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir) && dir !== '.') {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(this.filePath)) {
        const fileContent = fs.readFileSync(this.filePath, 'utf8');
        this.data = JSON.parse(fileContent);
        // Guarantee structure
        if (!this.data.contacts) this.data.contacts = {};
        if (!this.data.messages) this.data.messages = {};
        if (!this.data.alias) this.data.alias = process.env.ALIAS || 'Peer';
      } else {
        this.save();
      }
    } catch (err) {
      console.error('Failed to initialize database, using memory-only:', err);
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save database to disk:', err);
    }
  }

  getIdentity() {
    return this.data.identity;
  }

  setIdentity(publicKey, privateKey) {
    this.data.identity = { publicKey, privateKey };
    this.save();
  }

  getAlias() {
    return this.data.alias;
  }

  setAlias(newAlias) {
    this.data.alias = newAlias;
    this.save();
  }

  getContacts() {
    return Object.values(this.data.contacts);
  }

  saveContact(peerId, alias, publicKey = null, pushSubscription = null) {
    const existing = this.data.contacts[peerId] || {};
    this.data.contacts[peerId] = {
      peerId,
      alias: alias || existing.alias || peerId.substring(0, 12),
      publicKey: publicKey || existing.publicKey || null,
      pushSubscription: pushSubscription || existing.pushSubscription || null,
      lastSeen: new Date().toISOString()
    };
    this.save();
    return this.data.contacts[peerId];
  }

  getMessages(peerId) {
    return this.data.messages[peerId] || [];
  }

  saveMessage(peerId, sender, text, file = null) {
    if (!this.data.messages[peerId]) {
      this.data.messages[peerId] = [];
    }

    const message = {
      id: crypto.randomUUID(),
      sender, // e.g., 'me' or remote peerId
      text,
      file, // null or { name, size, type, localPath, url }
      timestamp: new Date().toISOString()
    };

    this.data.messages[peerId].push(message);
    this.save();
    return message;
  }
}

const db = new LocalDatabase();
export default db;
