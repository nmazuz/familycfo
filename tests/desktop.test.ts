import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { testDb } from './helpers.js';
import { openDb } from '../src/db/connection.js';
import { dailyBackup } from '../src/db/backup.js';
import { takeAlertsToNotify } from '../src/analytics/alerts.js';
import { lastDueAt, scrapeTime } from '../src/server/scheduler.js';
import { localOnly, serveWeb } from '../src/server/web.js';
import { loadConfig, setConfigProvider } from '../src/config.js';

describe('daily scrape schedule', () => {
  it('reads HH:MM and ignores anything else', () => {
    const db = testDb();
    expect(scrapeTime(db)).toBeNull();
    db.prepare(`INSERT INTO settings (key, value) VALUES ('scrape_time', '7:05')`).run();
    expect(scrapeTime(db)).toEqual({ hour: 7, minute: 5 });
    db.prepare(`UPDATE settings SET value = '25:00' WHERE key = 'scrape_time'`).run();
    expect(scrapeTime(db)).toBeNull();
  });

  it('the last due time is today once it passed, else yesterday', () => {
    const at = (h: number, m: number) => new Date(2026, 9, 2, h, m);
    expect(lastDueAt({ hour: 7, minute: 0 }, at(9, 0))).toEqual(at(7, 0));
    expect(lastDueAt({ hour: 7, minute: 0 }, at(6, 59))).toEqual(new Date(2026, 9, 1, 7, 0));
  });
});

describe('alert notifications', () => {
  it('each new, undismissed alert is handed out once', () => {
    const db = testDb();
    const add = (key: string, dismissed = false) => db.prepare(`INSERT INTO alerts (type, severity, dedupe_key, title, message, dismissed_at)
      VALUES ('budget', 'warning', ?, ?, 'm', ?)`).run(key, `t-${key}`, dismissed ? '2026-01-01' : null);
    add('a'); add('b', true);
    expect(takeAlertsToNotify(db).map(a => a.title)).toEqual(['t-a']);
    expect(takeAlertsToNotify(db)).toEqual([]);
    add('c');
    expect(takeAlertsToNotify(db).map(a => a.title)).toEqual(['t-c']);
  });
});

describe('daily backup', () => {
  it('one file per day, keeping the latest N', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcfo-backup-'));
    const db = openDb(join(dir, 'bank.db'));
    const backups = join(dir, 'backups');
    mkdirSync(backups);
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-03']) writeFileSync(join(backups, `bank-${d}.db`), '');
    writeFileSync(join(backups, 'keep-me.txt'), '');
    expect(await dailyBackup(db, backups, 2)).toMatch(/bank-\d{4}-\d{2}-\d{2}\.db$/);
    expect(await dailyBackup(db, backups, 2)).toBeNull();
    const files = readdirSync(backups).sort();
    expect(files).toHaveLength(3);
    expect(files).toContain('keep-me.txt');
    expect(files).toContain('bank-2026-01-03.db');
  });
});

describe('local-only API and the built UI', () => {
  const dist = mkdtempSync(join(tmpdir(), 'fcfo-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<html>app</html>');
  writeFileSync(join(dist, 'assets', 'main-abc.js'), 'console.log(1)');
  writeFileSync(join(tmpdir(), 'fcfo-secret.txt'), 'secret');
  const app = Fastify();
  localOnly(app);
  app.get('/api/ping', async () => ({ ok: true }));
  serveWeb(app, dist);
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ url, headers: { host: '127.0.0.1:4330', ...headers } });

  it('serves assets, and index.html for client routes', async () => {
    const asset = await get('/assets/main-abc.js');
    expect(asset.body).toBe('console.log(1)');
    expect(asset.headers['cache-control']).toContain('immutable');
    const route = await get('/transactions');
    expect(route.body).toBe('<html>app</html>');
    expect(route.headers['content-security-policy']).toContain("script-src 'self'");
    expect((await get('/assets/missing.js')).statusCode).toBe(404);
    expect((await get('/api/nope')).statusCode).toBe(404);
  });

  it('never serves files outside the build', async () => {
    const res = await get('/..%2Ffcfo-secret.txt');
    expect(res.body).not.toBe('secret');
  });

  it('rejects other hosts (DNS rebinding) and other sites (CSRF)', async () => {
    expect((await get('/api/ping')).statusCode).toBe(200);
    expect((await get('/api/ping', { host: 'evil.example:4330' })).statusCode).toBe(403);
    expect((await get('/api/ping', { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await get('/api/ping', { origin: 'http://localhost:5180' })).statusCode).toBe(200);
  });
});

describe('bank logins provider', () => {
  it('the desktop app replaces the accounts file', async () => {
    setConfigProvider(async () => ({ accounts: [{ companyId: 'max', credentials: { username: 'u', password: 'p' } }] }));
    expect((await loadConfig()).accounts[0].companyId).toBe('max');
  });
});

describe('master-password vault (Linux without a keyring)', async () => {
  const { aesDecrypt, aesEncrypt, deriveKey } = await import('../desktop/vault.js');
  const kdf = { salt: Buffer.alloc(16, 7).toString('base64'), N: 2 ** 10, r: 8, p: 1 }; // small N: fast test

  it('round-trips, and a wrong password or a changed file fails', async () => {
    const key = await deriveKey('correct horse', kdf);
    const secret = aesEncrypt(key, '{"logins":[]}');
    expect(aesDecrypt(await deriveKey('correct horse', kdf), secret)).toBe('{"logins":[]}');
    expect(() => aesDecrypt(Buffer.alloc(32), secret)).toThrow();
    const tampered = Buffer.from(secret, 'base64');
    tampered[tampered.length - 1] ^= 1;
    expect(() => aesDecrypt(key, tampered.toString('base64'))).toThrow();
  });
});
