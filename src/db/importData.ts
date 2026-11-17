import Database from 'better-sqlite3';
import { cpSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { dataPath } from '../paths.js';

/**
 * First run of the desktop app with "use my existing data": copy bank.db (an online backup, so a copy taken while
 * `npm run dev` still has it open is consistent) and the documents (data/policies, data/reports) from a folder,
 * e.g. the repo checkout, into the data dir. The bank logins are not copied here — desktop/main.ts imports
 * accounts.json into the Keychain itself.
 */
export async function importHousehold(fromDir: string): Promise<{ db: boolean; documents: string[] }> {
  mkdirSync(dataPath(), { recursive: true });
  const target = dataPath('bank.db');
  if (existsSync(target)) throw new Error(`${target} already exists — not overwriting it`);

  const source = join(fromDir, 'bank.db');
  let db = false;
  if (existsSync(source)) {
    const src = new Database(source, { readonly: true, fileMustExist: true });
    try { await src.backup(target); } finally { src.close(); }
    db = true;
  }
  const documents: string[] = [];
  for (const sub of ['policies', 'reports']) {
    const from = join(fromDir, 'data', sub);
    if (!existsSync(from)) continue;
    cpSync(from, dataPath('data', sub), { recursive: true, errorOnExist: false, force: false });
    documents.push(sub);
  }
  return { db, documents };
}
