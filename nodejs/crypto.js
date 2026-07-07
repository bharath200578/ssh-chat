import crypto from 'crypto';

/**
 * Generates an Ed25519 identity keypair for long-term peer identification.
 */
export function generateIdentityKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKey, privateKey };
}

/**
 * Computes a secure SHA-256 fingerprint for a public key.
 * This serves as the user's "Peer ID" address.
 */
export function getFingerprint(publicKeyPem) {
  // Strip PEM headers/footers and newlines for a clean hash source
  const cleanPem = publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s+/g, '');
  
  const hash = crypto.createHash('sha256').update(cleanPem, 'base64').digest('hex');
  return `ssh-p2p:${hash.substring(0, 32)}`;
}

/**
 * Generates a volatile ephemeral X25519 keypair for Perfect Forward Secrecy (PFS).
 */
export function generateEphemeralKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { publicKey, privateKey };
}

/**
 * Computes a shared secret using Diffie-Hellman over X25519.
 */
export function computeSharedSecret(ourPrivateKeyPem, peerPublicKeyPem) {
  const privateKey = crypto.createPrivateKey(ourPrivateKeyPem);
  const publicKey = crypto.createPublicKey(peerPublicKeyPem);
  return crypto.diffieHellman({ privateKey, publicKey });
}

/**
 * Derives encryption/decryption keys and IV parameters from a shared secret using HKDF.
 * Generates two distinct 256-bit symmetric keys:
 * - One for encrypting outbound messages (e.g. Alice -> Bob)
 * - One for decrypting inbound messages (e.g. Bob -> Alice)
 */
export function deriveSessionKeys(sharedSecret, isInitiator) {
  const salt = Buffer.from('CallOfSSH-V1-Salt');
  
  // Deriving outbound key
  const outboundInfo = Buffer.from(isInitiator ? 'InitiatorToResponder' : 'ResponderToInitiator');
  const outboundKey = crypto.hkdfSync('sha256', sharedSecret, salt, outboundInfo, 32);

  // Deriving inbound key
  const inboundInfo = Buffer.from(isInitiator ? 'ResponderToInitiator' : 'InitiatorToResponder');
  const inboundKey = crypto.hkdfSync('sha256', sharedSecret, salt, inboundInfo, 32);

  return { outboundKey, inboundKey };
}

/**
 * Signs data using an Ed25519 private key.
 */
export function signTranscript(privateKeyPem, data) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(data), privateKey);
}

/**
 * Verifies a signature using an Ed25519 public key.
 */
export function verifyTranscript(publicKeyPem, data, signature) {
  try {
    const publicKey = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(data), publicKey, Buffer.from(signature));
  } catch (err) {
    return false;
  }
}

/**
 * Encrypts a payload (string or buffer) using AES-256-GCM.
 * Returns an object containing the ciphertext, 12-byte IV, and 16-byte authentication tag.
 */
export function encrypt(payload, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  const bufferPayload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  let ciphertext = cipher.update(bufferPayload);
  ciphertext = Buffer.concat([ciphertext, cipher.final()]);
  
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex')
  };
}

/**
 * Decrypts a payload using AES-256-GCM.
 * Assumes inputs are hex-encoded strings.
 */
export function decrypt(encryptedObj, key) {
  const iv = Buffer.from(encryptedObj.iv, 'hex');
  const ciphertext = Buffer.from(encryptedObj.ciphertext, 'hex');
  const tag = Buffer.from(encryptedObj.tag, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  
  return decrypted;
}
