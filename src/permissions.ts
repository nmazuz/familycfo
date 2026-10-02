import { chmodSync, existsSync, mkdirSync, mkdtempSync, lstatSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { ACCOUNTS_FILE } from './config.js';

/** Owner-only: the data here is bank logins and a household's finances. POSIX only (Windows has no such modes). */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;
const supported = process.platform !== 'win32';

/** Create a directory (and parents) owner-only. An existing directory is left as it is — see `warnIfBroad`. */
export function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/** Never reuse the predictable legacy temp path: another local user could have planted it. */
export function createAgentWorkdir(parent: string = tmpdir()): string {
  const path = mkdtempSync(join(parent, 'household-agent-'));
  ensureAgentWorkdir(path);
  return path;
}

/** Fail closed on a replaced directory; tighten the mode before copying financial documents. */
export function ensureAgentWorkdir(path: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory() || (supported && st.uid !== process.getuid?.())) {
    throw new Error('Agent work directory must be a directory owned by the current user');
  }
  if (supported) chmodSync(path, PRIVATE_DIR_MODE);
}

let agentWorkdir: string | undefined;
export function getAgentWorkdir(): string {
  agentWorkdir ??= createAgentWorkdir();
  ensureAgentWorkdir(agentWorkdir);
  return agentWorkdir;
}

/** Make an existing file owner-only. Best effort; used for files this app creates itself (the database). */
export function chmodPrivate(path: string): void {
  if (!supported || !existsSync(path)) return;
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch {
    // not ours to change (e.g. owned by another user): `warnBroadPermissions` still reports it
  }
}

/** Describe `path` when group/others can access it; undefined when it is private, missing, or modes don't apply. */
export function broadPermissions(path: string): string | undefined {
  if (!supported || !existsSync(path)) return undefined;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) === 0) return undefined;
  const want = statSync(path).isDirectory() ? '700' : '600';
  return `${path} is accessible to other users (mode ${mode.toString(8)}); run: chmod ${want} ${path}`;
}

/** The files and folders that hold logins or financial data. */
export function sensitivePaths(): string[] {
  const db = resolve(process.env.BANK_DB || 'bank.db');
  return [resolve(ACCOUNTS_FILE), db, `${db}-wal`, `${db}-shm`, resolve('backups'), resolve('data'),
    resolve(process.env.POLICIES_DIR ?? 'data/policies'), resolve(process.env.REPORTS_DIR ?? 'data/reports'),
    ...(agentWorkdir ? [agentWorkdir] : [])];
}

/** Warn (never fail, never change user files) about sensitive paths other users can read. Returns the warnings. */
export function warnBroadPermissions(log: (msg: string) => void = console.warn): string[] {
  const warnings = [...new Set(sensitivePaths())].map(broadPermissions).filter((w): w is string => !!w);
  for (const w of warnings) log(`WARNING: ${w}`);
  return warnings;
}
