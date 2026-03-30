import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function deriveKey() {
  const envKey = process.env.ENCRYPTION_KEY;
  if (process.env.NODE_ENV === 'production' && !envKey) {
    throw new Error(
      "ENCRYPTION_KEY must be set in production. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  const keyMaterial = envKey || 'flowtex-dev-encryption-key-change-in-production';
  return crypto.scryptSync(keyMaterial, 'flowtex-salt', 32);
}

let _key = null;
function key() {
  if (!_key) _key = deriveKey();
  return _key;
}

export function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + tag + ':' + encrypted;
}

export function decrypt(data) {
  if (typeof data !== 'string') throw new Error('Invalid encrypted data');
  const parts = data.split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted data');
  const [ivHex, tagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
