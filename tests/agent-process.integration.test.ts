import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/connection.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'familycfo-agent-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const guard = resolve('src/agent/guard-read.mjs');
function runGuard(input: unknown, allowed: string) {
  return spawnSync(process.execPath, [guard, allowed], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
}

describe('read-file guard subprocess', () => {
  it('allows a nested document, including a relative path from the message cwd', () => {
    const allowed = join(dir, 'docs'); mkdirSync(join(allowed, 'nested'), { recursive: true }); writeFileSync(join(allowed, 'nested', 'test.txt'), 'invented');
    expect(runGuard({ tool_input: { file_path: 'docs/nested/test.txt' }, cwd: dir }, allowed).status).toBe(0);
    expect(runGuard({ tool_input: { file_path: join(allowed, 'nested', 'test.txt') } }, allowed).status).toBe(0);
  });
  it('blocks traversal, prefix-lookalike directories and symlink escapes', () => {
    const allowed = join(dir, 'docs'); mkdirSync(allowed); mkdirSync(join(dir, 'docs-other')); writeFileSync(join(dir, 'outside.txt'), 'invented'); writeFileSync(join(dir, 'docs-other', 'test.txt'), 'invented'); symlinkSync(join(dir, 'outside.txt'), join(allowed, 'link.txt'));
    for (const file of [join(dir, 'outside.txt'), join(dir, 'docs-other', 'test.txt'), join(allowed, 'link.txt'), allowed]) {
      const result = runGuard({ tool_input: { file_path: file } }, allowed); expect(result.status).toBe(2); expect(result.stderr).toContain('blocked');
    }
  });
  it.each(['not json', '{}', '{"tool_input":{"file_path":42}}'])('fails closed on malformed input %s', raw => {
    mkdirSync(join(dir, 'docs')); expect(runGuard(raw, join(dir, 'docs')).status).toBe(2);
  });
  it('blocks missing roots and missing files', () => {
    expect(runGuard({ tool_input: { file_path: '/not-a-real-test-file' } }, join(dir, 'missing')).status).toBe(2);
    mkdirSync(join(dir, 'docs')); expect(runGuard({ tool_input: { file_path: join(dir, 'docs', 'missing') } }, join(dir, 'docs')).status).toBe(2);
  });
});

describe('real MCP stdio transport and read-only database', () => {
  let child: ChildProcessWithoutNullStreams;
  let seq: number;
  let pending: Map<number, { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  beforeEach(() => {
    const path = join(dir, 'household.db'); const db = openDb(path); db.close(); seq = 0; pending = new Map();
    child = spawn(process.execPath, ['--import', 'tsx', 'src/agent/mcp.ts'], { env: { ...process.env, BANK_DB: path }, stdio: 'pipe' });
    createInterface({ input: child.stdout }).on('line', line => {
      const response = JSON.parse(line); const p = pending.get(response.id); if (p) { clearTimeout(p.timer); pending.delete(response.id); p.resolve(response); }
    });
    child.on('exit', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('MCP exited')); } pending.clear(); });
  });
  afterEach(async () => {
    child.stdin.end();
    if (child.exitCode === null) await new Promise<void>(resolve => { const timeout = setTimeout(() => child.kill('SIGKILL'), 2000); child.once('exit', () => { clearTimeout(timeout); resolve(); }); });
  });
  function call(method: string, params: object = {}) {
    const id = ++seq;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP reply timeout')); }, 5000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async function sql(query: string) { return (await call('tools/call', { name: 'sql', arguments: { query } })).result; }
  it('initializes, lists only allowed tools and correlates protocol replies', async () => {
    expect((await call('initialize')).result.serverInfo.name).toBe('household');
    expect((await call('tools/list')).result.tools.map((t: { name: string }) => t.name)).toEqual(['api', 'sql']);
    expect((await call('ping')).result).toEqual({}); expect((await call('unknown')).error.code).toBe(-32601);
  });
  it('executes SELECT and WITH SELECT but rejects writes, pragmas, attachment and stacked statements', async () => {
    expect(JSON.parse((await sql('SELECT COUNT(*) AS n FROM members')).content[0].text).rows[0].n).toBe(3);
    expect((await sql('WITH x AS (SELECT 42 AS n) SELECT n FROM x;')).isError).toBeUndefined();
    for (const query of ["DELETE FROM members", "WITH x AS (SELECT 1) DELETE FROM members RETURNING id", "PRAGMA user_version", "ATTACH DATABASE ':memory:' AS other", 'SELECT 1; DELETE FROM members', "SELECT load_extension('bad')"]) expect((await sql(query)).isError).toBe(true);
    expect(JSON.parse((await sql('SELECT COUNT(*) AS n FROM members')).content[0].text).rows[0].n).toBe(3);
  });
  it('caps row output and blocks non-whitelisted API destinations without fetching them', async () => {
    const result = await sql('WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<500) SELECT x FROM n');
    const body = JSON.parse(result.content[0].text); expect(body.rows).toHaveLength(300); expect(body.truncated).toBe(true);
    for (const path of ['/scrape', '/pipeline', '/insurance/documents/1/file', 'https://example.invalid', '/../settings']) {
      const r = (await call('tools/call', { name: 'api', arguments: { path } })).result; expect(r.isError).toBe(true); expect(r.content[0].text).toContain('path not allowed');
    }
    expect((await call('tools/call', { name: 'unknown' })).result.isError).toBe(true);
  });
});
