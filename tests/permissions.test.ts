import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDb } from '../src/db/connection.js';
import { broadPermissions, chmodPrivate, mkdirPrivate, warnBroadPermissions, createAgentWorkdir, ensureAgentWorkdir, getAgentWorkdir, sensitivePaths } from '../src/permissions.js';
import { chromeArgs } from '../src/scraper.js';

const posix = process.platform !== 'win32';
const mode = (p: string) => statSync(p).mode & 0o777;

describe.skipIf(!posix)('owner-only files', () => {
  let dir: string;
  const saved = { db: process.env.BANK_DB, accounts: process.env.ACCOUNTS_FILE };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cfo-perm-')); });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('creates a new database and its WAL files owner-only, even with a permissive umask', () => {
    const old = process.umask(0o000);
    try {
      const path = join(dir, 'new.db');
      const db = openDb(path);
      db.prepare(`INSERT INTO settings (key, value) VALUES ('k', 'v')`).run();
      expect(mode(path)).toBe(0o600);
      for (const ext of ['-wal', '-shm']) expect(mode(path + ext)).toBe(0o600);
      db.close();
    } finally { process.umask(old); }
  });

  it('tightens an existing database that was group/world readable, without losing its data', () => {
    const path = join(dir, 'old.db');
    const first = openDb(path);
    first.prepare(`INSERT INTO settings (key, value) VALUES ('k', 'v')`).run();
    first.close();
    chmodSync(path, 0o644);
    const again = openDb(path);
    expect(mode(path)).toBe(0o600);
    expect(again.prepare(`SELECT value FROM settings WHERE key = 'k'`).pluck().get()).toBe('v');
    again.close();
  });

  it('creates directories owner-only, parents included', () => {
    const old = process.umask(0o000);
    try {
      const leaf = join(dir, 'data', 'policies', '7');
      mkdirPrivate(leaf);
      expect(mode(leaf)).toBe(0o700);
      expect(mode(join(dir, 'data'))).toBe(0o700);
    } finally { process.umask(old); }
  });

  it('uses unique owner-only work dirs despite a pre-existing broad legacy directory', () => {
    const legacy = join(dir, 'household-agent');
    mkdirSync(legacy); chmodSync(legacy, 0o755);
    const work = createAgentWorkdir(dir);
    expect(work).not.toBe(legacy);
    expect(mode(work)).toBe(0o700);
    chmodSync(work, 0o755); ensureAgentWorkdir(work);
    expect(mode(work)).toBe(0o700);
    expect(mode(legacy)).toBe(0o755);
    const link = join(dir, 'planted'); symlinkSync(work, link);
    expect(() => ensureAgentWorkdir(link)).toThrow('owned by the current user');
  });

  it('includes directory overrides, sidecars, backups and active chat workspace in warnings', () => {
    vi.stubEnv('BANK_DB', join(dir, 'bank.db'));
    vi.stubEnv('POLICIES_DIR', join(dir, 'policies'));
    vi.stubEnv('REPORTS_DIR', join(dir, 'reports'));
    const paths = sensitivePaths();
    expect(paths).toEqual(expect.arrayContaining([join(dir, 'bank.db-wal'), join(dir, 'bank.db-shm'), join(dir, 'policies'), join(dir, 'reports')]));
    for (const file of [join(dir, 'bank.db-wal'), join(dir, 'bank.db-shm')]) {
      writeFileSync(file, ''); chmodSync(file, 0o644);
      expect(broadPermissions(file)).toContain('chmod 600');
    }
    const work = getAgentWorkdir();
    expect(sensitivePaths()).toContain(work);
    expect(mode(work)).toBe(0o700);
  });

  it('chmodPrivate ignores a missing file', () => {
    expect(() => chmodPrivate(join(dir, 'nope'))).not.toThrow();
  });

  it('reports broad modes and stays quiet for private ones or missing paths', () => {
    const file = join(dir, 'accounts.json');
    writeFileSync(file, '{}', { mode: 0o644 }); chmodSync(file, 0o644);
    expect(broadPermissions(file)).toContain('chmod 600');
    chmodSync(file, 0o600);
    expect(broadPermissions(file)).toBeUndefined();
    const folder = join(dir, 'backups');
    mkdirSync(folder); chmodSync(folder, 0o755);
    expect(broadPermissions(folder)).toContain('chmod 700');
    expect(broadPermissions(join(dir, 'missing'))).toBeUndefined();
  });

  it('warns at startup about wide sensitive paths without changing them', () => {
    const file = join(dir, 'accounts.json');
    writeFileSync(file, '{}'); chmodSync(file, 0o664);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const bankPath = join(dir, 'bank.db');
      vi.stubEnv('BANK_DB', bankPath);
      vi.stubEnv('POLICIES_DIR', join(dir, 'policies'));
      vi.stubEnv('REPORTS_DIR', join(dir, 'reports'));
      writeFileSync(bankPath, ''); chmodSync(bankPath, 0o600);
      const lines: string[] = [];
      const warnings = warnBroadPermissions(m => lines.push(m));
      expect(warnings.length).toBe(1);
      expect(lines[0]).toContain('accounts.json');
      expect(mode(file)).toBe(0o664);
    } finally { process.chdir(cwd); }
  });
});

describe('scraper Chrome flags', () => {
  it('keeps the sandbox on by default', () => {
    const args = chromeArgs({}, () => { throw new Error('should not warn'); });
    expect(args).not.toContain('--no-sandbox');
    expect(args).not.toContain('--disable-setuid-sandbox');
    expect(args).toContain('--window-size=1920,1080');
  });

  it('only CHROME_NO_SANDBOX=1 turns it off, with a warning', () => {
    for (const value of ['0', 'true', '', 'yes']) {
      expect(chromeArgs({ CHROME_NO_SANDBOX: value }, () => {})).not.toContain('--no-sandbox');
    }
    const warnings: string[] = [];
    const args = chromeArgs({ CHROME_NO_SANDBOX: '1' }, m => warnings.push(m));
    expect(args).toEqual(expect.arrayContaining(['--no-sandbox', '--disable-setuid-sandbox']));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('WITHOUT its sandbox');
  });
});
