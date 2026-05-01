import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;   // 96-bit IV — required for GCM
const TAG_BYTES = 16;  // 128-bit auth tag — GCM default
const KEY_BYTES = 32;  // 256-bit key

export interface EncryptionService {
  /** Encrypts plaintext and returns a base64-encoded `iv:authTag:ciphertext` blob. */
  encrypt(plaintext: string): string;
  /** Decrypts a base64-encoded `iv:authTag:ciphertext` blob and returns the plaintext. */
  decrypt(ciphertext: string): string;
}

/**
 * Creates an AES-256-GCM encryption service from a base64-encoded 256-bit key.
 * The key must decode to exactly 32 bytes.
 *
 * Stored format: `base64(iv):base64(authTag):base64(ciphertext)`
 */
export function createEncryptionService(keyBase64: string): EncryptionService {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `Encryption key must be ${KEY_BYTES} bytes (got ${key.length}). ` +
      `Generate with: require('crypto').randomBytes(32).toString('base64')`,
    );
  }

  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      return [
        iv.toString('base64'),
        authTag.toString('base64'),
        encrypted.toString('base64'),
      ].join(':');
    },

    decrypt(blob: string): string {
      const parts = blob.split(':');
      if (parts.length !== 3) {
        throw new Error('Invalid encrypted blob format — expected iv:authTag:ciphertext');
      }
      const [ivB64, tagB64, ciphertextB64] = parts;
      const iv = Buffer.from(ivB64, 'base64');
      const authTag = Buffer.from(tagB64, 'base64');
      const ciphertext = Buffer.from(ciphertextB64, 'base64');

      if (iv.length !== IV_BYTES) {
        throw new Error(`Invalid IV length: ${iv.length} (expected ${IV_BYTES})`);
      }
      if (authTag.length !== TAG_BYTES) {
        throw new Error(`Invalid auth tag length: ${authTag.length} (expected ${TAG_BYTES})`);
      }

      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}

/** PII fields on the contact object that should be encrypted before INSERT. */
export const PII_FIELDS: ReadonlySet<string> = new Set([
  'First Name',
  'Last Name',
  'Email Address',
  'Phone Number',
]);
