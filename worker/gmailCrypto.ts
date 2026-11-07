/**
 * worker/gmailCrypto.ts - AES-256-GCM Encryption for Gmail OAuth Tokens
 *
 * Implements Rule 33 / E09 / Phase 4 security contract:
 * - Refresh token encrypted at rest with AES-256-GCM using GMAIL_ENCRYPTION_KEY.
 * - 12-byte cryptographic random IV per encryption.
 * - Stored as base64 string "iv_b64:ciphertext_b64".
 * - Never logs or stores plaintext tokens.
 */

async function getEncryptionKey(keySecret?: string): Promise<CryptoKey> {
  const secret = keySecret || 'fallback_dev_gmail_secret_key_change_in_prod_32b';
  // Derive 32-byte (256-bit) key via SHA-256
  const enc = new TextEncoder();
  const secretBytes = enc.encode(secret);
  const hash = await crypto.subtle.digest('SHA-256', secretBytes);

  return crypto.subtle.importKey(
    'raw',
    hash,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptToken(token: string, keySecret?: string): Promise<string> {
  const key = await getEncryptionKey(keySecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(token);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  const ivB64 = btoa(String.fromCharCode(...iv));
  const cipherB64 = btoa(String.fromCharCode(...new Uint8Array(cipherBuffer)));

  return `${ivB64}:${cipherB64}`;
}

export async function decryptToken(encryptedString: string, keySecret?: string): Promise<string> {
  const parts = encryptedString.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted token format: missing IV or ciphertext delimiter');
  }

  const [ivB64, cipherB64] = parts;
  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const cipherBytes = Uint8Array.from(atob(cipherB64), (c) => c.charCodeAt(0));

  const key = await getEncryptionKey(keySecret);
  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    cipherBytes
  );

  return new TextDecoder().decode(decryptedBuffer);
}
