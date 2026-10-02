import Fastify, { type FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { testDb } from './helpers.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), cpSync: vi.fn(), mkdirSync: vi.fn(), rmSync: vi.fn(), writeFileSync: vi.fn(), existsSync: vi.fn(() => false) }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof import('fs')>(), cpSync: mocks.cpSync, mkdirSync: mocks.mkdirSync, rmSync: mocks.rmSync, writeFileSync: mocks.writeFileSync, existsSync: mocks.existsSync }));
import { agentRoutes } from '../src/server/agent.js';
let db: DB; let app: FastifyInstance;
beforeEach(() => { vi.clearAllMocks(); db = testDb(); app = Fastify(); agentRoutes(app, db); });
afterEach(async () => { await app.close(); db.close(); vi.unstubAllEnvs(); });

function child(events: string[], stderr = '', spawnError?: Error) {
  const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, kill: vi.fn() });
  c.stdin.once('finish', () => setImmediate(() => {
    if (spawnError) c.emit('error', spawnError);
    else {
      if (stderr) c.stderr.write(stderr);
      const bytes = events.join('\n') + '\n';
      // Split a JSON event across chunks to exercise the real stream buffering.
      c.stdout.write(bytes.slice(0, 17)); c.stdout.write(bytes.slice(17));
      c.exitCode = 0; c.emit('close', 0);
    }
  }));
  mocks.spawn.mockReturnValue(c); return c;
}
const message = (event: object) => JSON.stringify(event);
const payload = { message: 'Summarize this synthetic empty household', sessionId: 'test-session-123' };

describe('data chat SSE adapter with a controlled local child process', () => {
  it('emits session, block, text, tool and done events in order from chunked lines', async () => {
    child(['invalid json', '', message({ type: 'system', subtype: 'init', session_id: 'test-session' }),
      message({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }),
      message({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Synthetic result' } } }),
      message({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__household__sql', input: { query: 'SELECT 1' } }] } }),
      message({ type: 'result', session_id: 'test-session', is_error: false })]);
    const r = await app.inject({ method: 'POST', url: '/api/agent/chat', payload });
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toContain('text/event-stream');
    const events = r.body.split('\n\n').filter(Boolean).map(line => JSON.parse(line.replace(/^data: /, '')));
    expect(events).toEqual([{ type: 'session', sessionId: 'test-session' }, { type: 'block' }, { type: 'text', text: 'Synthetic result' }, { type: 'tool', name: 'sql', input: { query: 'SELECT 1' } }, { type: 'done', sessionId: 'test-session', error: null }]);
  });
  it('launches only restricted tools, resumes validated sessions and removes API-key environment variables', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-do-not-send'); vi.stubEnv('CLAUDECODE', 'synthetic'); vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'synthetic');
    child([message({ type: 'result', is_error: false })]);
    await app.inject({ method: 'POST', url: '/api/agent/chat', payload });
    const [command, args, options] = mocks.spawn.mock.calls[0];
    expect(command).toBe('claude'); expect(args).toContain('--strict-mcp-config'); expect(args[args.indexOf('--tools') + 1]).toBe('Skill,Read');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project'); expect(args.slice(-2)).toEqual(['--resume', 'test-session-123']);
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined(); expect(options.env.CLAUDECODE).toBeUndefined(); expect(options.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    const settings = JSON.parse(mocks.writeFileSync.mock.calls[0][1]); expect(settings.hooks.PreToolUse[0].matcher).toBe('Read');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('guard-read.mjs');
  });
  it.each([{ message: '' }, { message: ' ' }, { message: 'Valid', sessionId: '../invalid' }])('rejects malformed chat input without launching a child', async body => {
    expect((await app.inject({ method: 'POST', url: '/api/agent/chat', payload: body })).statusCode).toBe(400); expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it('returns a clear error when the CLI is missing', async () => {
    child([], '', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
    const r = await app.inject({ method: 'POST', url: '/api/agent/chat', payload }); expect(r.body).toContain('not installed or not on PATH');
  });
  it('handles premature close with bounded diagnostic text, and result errors', async () => {
    child([], 'x'.repeat(1000)); const r = await app.inject({ method: 'POST', url: '/api/agent/chat', payload });
    const event = JSON.parse(r.body.replace(/^data: /, '').trim()); expect(event.type).toBe('done'); expect(event.error).toHaveLength(600);
    child([message({ type: 'result', is_error: true, result: 'Synthetic error' })]);
    expect((await app.inject({ method: 'POST', url: '/api/agent/chat', payload })).body).toContain('Synthetic error');
  });
});
