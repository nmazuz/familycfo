import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';

/** The master-password encryption (desktop/credentials.ts, only where the OS has no credential store). */

export interface PasswordParams { salt: string; N: number; r: number; p: number }

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

export const newPasswordParams = (): PasswordParams => ({ salt: randomBytes(16).toString('base64'), N: 2 ** 17, r: 8, p: 1 });

export const deriveKey = (password: string, kdf: PasswordParams): Promise<Buffer> =>
  scryptAsync(password.normalize('NFKC'), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });

/** base64 of iv(12) + tag(16) + AES-256-GCM ciphertext */
export function aesEncrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

/** Throws on a wrong key or a changed file (GCM authenticates). */
export function aesDecrypt(key: Buffer, secret: string): string {
  const raw = Buffer.from(secret, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
