import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openDb } from '../../src/db/connection.js';

// Each run gets an empty, migrated household. No real credentials, documents or DB are read.
const dir = mkdtempSync(join(tmpdir(), 'familycfo-e2e-'));
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/e2e-directory.txt', dir);
const path = join(dir, 'household.db');
const db = openDb(path);
db.prepare("UPDATE members SET name = 'Test member' WHERE id = 1").run();
db.close();
const env = { ...process.env, BANK_DB: path, POLICIES_DIR: join(dir, 'policies'), REPORTS_DIR: join(dir, 'reports'),
  ACCOUNTS_FILE: join(dir, 'missing-accounts.json'), PORT: '14310', WEB_PORT: '15180' };
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { env, stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { cwd: process.cwd() + '/web', env, stdio: 'inherit' }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const force = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); }, 5000);
  force.unref();
  Promise.all(children.map(child => child.exitCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()))))
    .then(() => { clearTimeout(force); rmSync(dir, { recursive: true, force: true }); process.exit(code); });
}
for (const child of children) { child.on('error', () => stop(1)); child.on('exit', () => { if (!stopping) stop(1); }); }
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop());
