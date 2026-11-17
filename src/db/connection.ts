import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';
import { dataPath } from '../paths.js';

export type DB = Database.Database;

let instance: DB | undefined;

/** Open (and migrate) a database. Tests pass ':memory:'. */
export function openDb(path = process.env.BANK_DB || dataPath('bank.db')): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

/** Shared process-wide connection to bank.db. */
export function getDb(): DB {
  instance ??= openDb();
  return instance;
}
