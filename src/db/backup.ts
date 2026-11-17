import { mkdirSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import type { DB } from './connection.js';
import { dataPath } from '../paths.js';

const NAME = /^bank-(\d{4}-\d{2}-\d{2})\.db$/;

/**
 * One online backup of the database per day (bank-YYYY-MM-DD.db, safe while the app writes), keeping the latest
 * `keep`. Used by the desktop app, whose data no longer sits in a folder the user copies by hand.
 */
export async function dailyBackup(db: DB, dir = dataPath('backups'), keep = 14): Promise<string | null> {
  mkdirSync(dir, { recursive: true });
  const day = new Date().toLocaleDateString('sv-SE'); // local YYYY-MM-DD
  const existing = readdirSync(dir).filter(f => NAME.test(f)).sort();
  let made: string | null = null;
  if (!existing.includes(`bank-${day}.db`)) {
    made = join(dir, `bank-${day}.db`);
    await db.backup(made);
    existing.push(`bank-${day}.db`);
  }
  for (const old of existing.sort().slice(0, Math.max(0, existing.length - keep))) rmSync(join(dir, old), { force: true });
  return made;
}
