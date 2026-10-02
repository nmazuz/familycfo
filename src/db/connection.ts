import Database from 'better-sqlite3';
import { closeSync, openSync } from 'fs';
import { runMigrations } from './migrate.js';
import { chmodPrivate, PRIVATE_FILE_MODE } from '../permissions.js';

export type DB = Database.Database;

let instance: DB | undefined;

/** Open (and migrate) a database. Tests pass ':memory:'. */
export function openDb(path = process.env.BANK_DB || 'bank.db'): DB {
  const onDisk = path !== ':memory:' && path !== '';
  // a new database file is owner-only from the start (SQLite gives -wal / -shm the same mode as the main file)
  if (onDisk) closeSync(openSync(path, 'a', PRIVATE_FILE_MODE));
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  if (onDisk) for (const p of [path, `${path}-wal`, `${path}-shm`]) chmodPrivate(p);
  return db;
}

/** Shared process-wide connection to bank.db. */
export function getDb(): DB {
  instance ??= openDb();
  return instance;
}
