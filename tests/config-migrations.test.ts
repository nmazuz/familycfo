import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations.js';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'familycfo-config-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
describe('configuration loading', () => {
  it('reads only the explicitly selected synthetic file', async () => {
    const path = join(dir, 'accounts.json'); writeFileSync(path, JSON.stringify({ accounts: [], categoryApiUrl: 'https://categorizer.invalid' }));
    vi.stubEnv('ACCOUNTS_FILE', path); vi.resetModules(); const { loadConfig } = await import('../src/config.js');
    expect(loadConfig()).toEqual({ accounts: [], categoryApiUrl: 'https://categorizer.invalid' });
  });
  it('missing and invalid JSON configuration fail without fallback to real credentials', async () => {
    const path = join(dir, 'missing.json'); vi.stubEnv('ACCOUNTS_FILE', path); vi.resetModules(); const { loadConfig } = await import('../src/config.js');
    expect(() => loadConfig()).toThrow('not found'); writeFileSync(path, 'invalid json'); expect(() => loadConfig()).toThrow(SyntaxError);
  });
});
describe('migration and persistent database lifecycle', () => {
  it('migration versions are unique and increasing, run once and preserve data on reopen', () => {
    const versions = migrations.map(m => m.version); expect(new Set(versions).size).toBe(versions.length); expect(versions).toEqual([...versions].sort((a, b) => a - b));
    const path = join(dir, 'test.db'); let db = openDb(path);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1); expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.prepare('SELECT version FROM schema_version ORDER BY version').pluck().all()).toEqual(versions);
    db.prepare("INSERT INTO tags (name) VALUES ('Synthetic persistent tag')").run(); expect(runMigrations(db)).toEqual([]); db.close();
    db = openDb(path);
    try { expect(db.prepare('SELECT name FROM tags').pluck().all()).toEqual(['Synthetic persistent tag']); expect(db.pragma('foreign_key_check')).toEqual([]); expect(db.pragma('integrity_check', { simple: true })).toBe('ok'); } finally { db.close(); }
  });
  it('upgrades a partially migrated database without losing user-edited rows', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)');
      const cutoff = 14;
      for (const m of migrations.filter(m => m.version <= cutoff)) { db.transaction(() => { m.up(db); db.prepare('INSERT INTO schema_version (version,name) VALUES (?,?)').run(m.version, m.name); })(); }
      db.prepare("UPDATE members SET name='Synthetic edited name' WHERE id=1").run();
      const ran = runMigrations(db); expect(ran).toEqual(migrations.filter(m => m.version > cutoff).map(m => m.version));
      expect(db.prepare('SELECT name FROM members WHERE id=1').pluck().get()).toBe('Synthetic edited name');
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1); expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally { db.close(); }
  });
});
