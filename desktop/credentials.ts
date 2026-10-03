import { randomUUID } from 'crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { app, safeStorage } from 'electron';
import type { Config } from '../src/scraper.js';
import { aesDecrypt, aesEncrypt, deriveKey, newPasswordParams, type PasswordParams } from './vault.js';

/**
 * Bank logins of the desktop app, in one file format on macOS, Windows and Linux (userData/credentials.json):
 *
 *   index   company, label and field NAMES of each login, in the clear, so listing them never decrypts anything
 *   secret  the logins' values, encrypted by:
 *           - the OS store through Electron's safeStorage: macOS Keychain, Windows DPAPI, Linux libsecret / KWallet
 *           - or, only where there is no OS store (Linux without a keyring, where safeStorage would fall back to a
 *             hard-coded key), a master password: scrypt → AES-256-GCM. The derived key stays in memory for a few
 *             minutes after it is typed, then is wiped
 *
 * The values are decrypted only in this process, when a scrape (or a login check) asks for them, and only for the
 * logins it runs. They go to the server process over IPC, never over HTTP, and are never sent to the UI.
 */

export interface BankLogin { id: string; companyId: string; label: string; credentials: Record<string, string> }
export interface BankLoginInfo { id: string; companyId: string; label: string; fields: string[] }
export type Backend = 'system' | 'password';

interface StoreFile {
  v: 1;
  backend: Backend;
  index: BankLoginInfo[];
  /** base64: safeStorage output, or iv(12) + tag(16) + AES-GCM ciphertext */
  secret: string;
  kdf?: PasswordParams;
}

const file = () => join(app.getPath('userData'), 'credentials.json');

// ---- which store -------------------------------------------------------------------------------------------------

/** The OS store, unless (Linux) safeStorage would only obfuscate with a fixed key. */
export function backend(): Backend {
  if (!safeStorage.isEncryptionAvailable()) return 'password';
  if (process.platform === 'linux') {
    const kind = safeStorage.getSelectedStorageBackend();
    if (kind === 'basic_text' || kind === 'unknown') return 'password';
  }
  return 'system';
}

/** For the UI: where the logins are kept, in words. */
export function storeName(): string {
  if (backend() === 'password') return 'סיסמת-על (אין מאגר סיסמאות במערכת)';
  if (process.platform === 'darwin') return 'Keychain של macOS';
  if (process.platform === 'win32') return 'הגנת הנתונים של Windows (DPAPI)';
  return safeStorage.getSelectedStorageBackend().startsWith('kwallet') ? 'KWallet' : 'GNOME Keyring (libsecret)';
}

// ---- master-password key (only for backend 'password') -----------------------------------------------------------

const KEY_TTL = 5 * 60_000;
let cachedKey: { key: Buffer; timer: NodeJS.Timeout } | null = null;
const forgetKey = () => {
  if (!cachedKey) return;
  clearTimeout(cachedKey.timer);
  cachedKey.key.fill(0);
  cachedKey = null;
};
const keepKey = (key: Buffer) => {
  forgetKey();
  cachedKey = { key, timer: setTimeout(forgetKey, KEY_TTL) };
  cachedKey.timer.unref?.();
};

/**
 * Asks the user for the master password (the app shows a dialog; desktop/main.ts wires this). Resolves with the
 * password, or rejects when the user cancels or doesn't answer.
 */
export type PasswordMode = 'create' | 'unlock' | 'retry';
let askPassword: ((mode: PasswordMode) => Promise<string>) | null = null;
export function setPasswordPrompt(prompt: (mode: PasswordMode) => Promise<string>): void {
  askPassword = prompt;
}

/** Try a typed master password against the stored file (or set it up when there is none). */
async function unlockWith(password: string, store: StoreFile | null): Promise<{ key: Buffer; kdf: PasswordParams }> {
  if (password.length < 8) throw new Error('סיסמת-העל צריכה לפחות 8 תווים');
  const kdf = store?.kdf ?? newPasswordParams();
  const key = await deriveKey(password, kdf);
  if (store?.secret) {
    try { aesDecrypt(key, store.secret); } catch { key.fill(0); throw new Error('סיסמת-על שגויה'); }
  }
  return { key, kdf };
}

async function passwordKey(store: StoreFile | null): Promise<{ key: Buffer; kdf: PasswordParams }> {
  if (cachedKey && store?.kdf) return { key: cachedKey.key, kdf: store.kdf };
  if (!askPassword) throw new Error('locked');
  // up to three tries
  for (let attempt = 0; ; attempt++) {
    const password = await askPassword(!store ? 'create' : attempt ? 'retry' : 'unlock');
    try {
      const result = await unlockWith(password, store);
      keepKey(result.key);
      return result;
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

// ---- file --------------------------------------------------------------------------------------------------------

function readStore(): StoreFile | null {
  if (!existsSync(file())) return null;
  const store = JSON.parse(readFileSync(file(), 'utf8')) as StoreFile;
  if (store.v !== 1) throw new Error('unknown credentials file version');
  return store;
}

async function readSecrets(store: StoreFile | null): Promise<BankLogin[]> {
  if (!store?.secret) return [];
  if (store.backend === 'system') {
    return JSON.parse(safeStorage.decryptString(Buffer.from(store.secret, 'base64'))).logins;
  }
  const { key } = await passwordKey(store);
  return JSON.parse(aesDecrypt(key, store.secret)).logins;
}

async function writeStore(logins: BankLogin[], previous: StoreFile | null): Promise<void> {
  // a file created with a master password keeps it (a keyring installed later doesn't silently change the store)
  const kind = previous?.backend ?? backend();
  const plain = JSON.stringify({ logins });
  let store: StoreFile;
  if (kind === 'system') {
    store = { v: 1, backend: 'system', index: [], secret: safeStorage.encryptString(plain).toString('base64') };
  } else {
    const { key, kdf } = await passwordKey(previous);
    store = { v: 1, backend: 'password', index: [], secret: aesEncrypt(key, plain), kdf };
  }
  store.index = logins.map(info);
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 1), { mode: 0o600 });
  renameSync(tmp, file());
}

const info = (l: BankLogin): BankLoginInfo => ({ id: l.id, companyId: l.companyId, label: l.label, fields: Object.keys(l.credentials) });

// ---- API ---------------------------------------------------------------------------------------------------------

/** No decryption: the clear-text index. */
export function listLogins(): BankLoginInfo[] {
  return readStore()?.index ?? [];
}

export function storeInfo(): { backend: Backend; name: string; locked: boolean } {
  const kind = readStore()?.backend ?? backend();
  return { backend: kind, name: storeName(), locked: kind === 'password' && !cachedKey };
}

/** Add a login, or update one (by id): fields left empty keep their stored value. */
export async function saveLogin(input: { id?: string; companyId: string; label?: string; credentials: Record<string, string> }): Promise<BankLoginInfo> {
  if (typeof input.companyId !== 'string' || !/^\w+$/.test(input.companyId)) throw new Error('bad company');
  const credentials = Object.fromEntries(Object.entries(input.credentials ?? {})
    .filter(([k, v]) => /^\w+$/.test(k) && typeof v === 'string').map(([k, v]) => [k, v.trim()]));
  const store = readStore();
  const logins = await readSecrets(store);
  const existing = input.id ? logins.find(l => l.id === input.id) : undefined;
  if (input.id && !existing) throw new Error('no such login');
  const login: BankLogin = existing
    ? { ...existing, label: input.label?.trim() ?? existing.label,
      credentials: { ...existing.credentials, ...Object.fromEntries(Object.entries(credentials).filter(([, v]) => v)) } }
    : { id: randomUUID(), companyId: input.companyId, label: input.label?.trim() ?? '', credentials };
  await writeStore(existing ? logins.map(l => (l.id === login.id ? login : l)) : [...logins, login], store);
  return info(login);
}

export async function removeLogin(id: string): Promise<void> {
  const store = readStore();
  await writeStore((await readSecrets(store)).filter(l => l.id !== id), store);
}

/** The scraper's configuration — only the logins asked for (all, for a full scrape). Called per scrape / check. */
export async function scraperConfig(loginIds?: string[]): Promise<Config> {
  const logins = (await readSecrets(readStore())).filter(l => !loginIds || loginIds.includes(l.id));
  if (!logins.length) throw new Error('no bank logins yet — add them in Settings → bank accounts');
  return {
    accounts: logins.map(l => ({ id: l.id, label: l.label, companyId: l.companyId as Config['accounts'][number]['companyId'], credentials: l.credentials })),
  };
}

/** One-time import of an accounts.json (the CLI's plain-text file). The caller tells the user to delete it. */
export async function importAccountsFile(path: string): Promise<number> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { accounts?: { companyId: string; credentials: Record<string, string> }[] };
  const store = readStore();
  const logins = await readSecrets(store);
  const added = (parsed.accounts ?? []).filter(a => /^\w+$/.test(a.companyId))
    .map(a => ({ id: randomUUID(), companyId: a.companyId, label: '', credentials: a.credentials }));
  await writeStore([...logins, ...added], store);
  return added.length;
}

export const lock = forgetKey;
