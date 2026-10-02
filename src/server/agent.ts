import { spawn } from 'child_process';
import { getAgentWorkdir } from '../permissions.js';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../db/connection.js';
import { cycleStartDay, today } from '../analytics/common.js';
import { POLICIES_DIR, REPORTS_DIR } from './routes/insurance.js';

/**
 * The data chat: each message runs the user's own Claude Code (`claude -p`, their subscription) with
 * no built-in tools — only the read-only `household` MCP server (src/agent/mcp.ts) — and streams the
 * answer back as server-sent events. A conversation continues with `--resume <sessionId>`.
 */

const ROOT = resolve('.');
const AGENT_DIR = join(ROOT, 'agent');
// outside the repo, so the project's files, settings and CLAUDE.md aren't part of the agent's context

function schemaText(db: DB): string {
  const tables = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT IN ('sqlite_sequence', 'schema_version')
    AND sql IS NOT NULL ORDER BY name`).pluck().all() as string[];
  return tables.join(';\n');
}

/** Only what changes: the standing instructions and the skills live in agent/ (CLAUDE.md, .claude/skills). */
function systemPrompt(db: DB): string {
  const members = (db.prepare(`SELECT id, name FROM members ORDER BY id`).all() as { id: number; name: string }[])
    .map(m => `${m.id}=${m.name}`).join(', ');
  return `You are the household data assistant of "הכספים של הבית". Follow the instructions in CLAUDE.md and use a skill when the question fits one.
Your only tools are the read-only household tools (api, sql), Skill, and Read for the documents in ./docs/: insurance policies
(./docs/policies, paths from api /insurance) and imported pension / insurance reports (./docs/reports, the file from api /pension).

Today is ${today()}. A month ("cycle", key YYYY-MM) starts on day ${cycleStartDay(db)} of the month. Members: ${members}.

Database schema (bank.db):
${schemaText(db)}`;
}

/**
 * Prepare the work dir (outside the repo, so the developer CLAUDE.md isn't loaded): agent/'s instructions
 * and skills, a copy of the policy files, and a settings file whose hook lets Read open only that copy.
 */
function syncAgentFiles(WORKDIR: string): void {
  rmSync(join(WORKDIR, '.claude'), { recursive: true, force: true });
  cpSync(AGENT_DIR, WORKDIR, { recursive: true, force: true });

  // docs/policies (insurance documents) and docs/reports (pension / insurance reports)
  const docs = join(WORKDIR, 'docs');
  rmSync(docs, { recursive: true, force: true });
  rmSync(join(WORKDIR, 'policies'), { recursive: true, force: true }); // the layout before docs/
  mkdirSync(docs);
  for (const [from, name] of [[POLICIES_DIR, 'policies'], [REPORTS_DIR, 'reports']] as const) {
    // symlinks are copied as links (not their targets), so the guard sees — and blocks — where they point
    if (existsSync(from)) cpSync(from, join(docs, name), { recursive: true, verbatimSymlinks: true });
    else mkdirSync(join(docs, name));
  }

  const guard = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'src', 'agent', 'guard-read.mjs'))} ${JSON.stringify(docs)}`;
  writeFileSync(join(WORKDIR, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: guard }] }] },
  }, null, 2));
}

function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // use the user's Claude subscription login, not an API key that may be set for other tools
  delete env.ANTHROPIC_API_KEY;
  // the API may itself be started from a Claude Code session
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

export function agentRoutes(app: FastifyInstance, db: DB): void {
  app.post('/api/agent/chat', async (req, reply) => {
    const { message, sessionId } = (req.body ?? {}) as { message?: string; sessionId?: string };
    if (!message?.trim()) return reply.code(400).send({ error: 'message is required' });
    if (sessionId && !/^[\w-]{8,64}$/.test(sessionId)) return reply.code(400).send({ error: 'bad sessionId' });

    const WORKDIR = getAgentWorkdir(); // unique, owner-only, checked before every copy
    syncAgentFiles(WORKDIR);
    const mcpConfig = {
      mcpServers: {
        household: {
          command: join(ROOT, 'node_modules', '.bin', 'tsx'),
          args: [join(ROOT, 'src', 'agent', 'mcp.ts')],
          env: {
            BANK_DB: resolve(process.env.BANK_DB ?? 'bank.db'),
            HOUSEHOLD_API: `http://127.0.0.1:${process.env.PORT ?? 4310}`,
          },
        },
      },
    };
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      // of the built-in tools only Skill (the skills in agent/) and Read — which the hook limits to the
      // copied documents (docs/): no other files, no shell, no web
      '--tools', 'Skill,Read',
      // only the work dir's own settings (the Read guard) and skills, not the user's global ones
      '--setting-sources', 'project',
      '--strict-mcp-config', '--mcp-config', JSON.stringify(mcpConfig),
      '--allowedTools', 'mcp__household__api,mcp__household__sql,Skill,Read(./docs/**)',
      '--system-prompt', systemPrompt(db),
      ...(sessionId ? ['--resume', sessionId] : []),
    ];
    const child = spawn('claude', args, { cwd: WORKDIR, env: claudeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end(message);

    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const emit = (event: object) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    // the browser went away (closed the drawer, new chat) — stop the agent
    reply.raw.on('close', () => { if (child.exitCode == null) child.kill('SIGTERM'); });

    let buffer = '', stderr = '', finished = false;
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let ev: Record<string, any>;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init') emit({ type: 'session', sessionId: ev.session_id });
        else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
          emit({ type: 'text', text: ev.event.delta.text });
        } else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_start' && ev.event.content_block?.type === 'text') {
          emit({ type: 'block' });
        } else if (ev.type === 'assistant') {
          for (const c of ev.message?.content ?? []) {
            if (c.type === 'tool_use') emit({ type: 'tool', name: String(c.name).replace(/^mcp__household__/, ''), input: c.input });
          }
        } else if (ev.type === 'result') {
          finished = true;
          emit({ type: 'done', sessionId: ev.session_id, error: ev.is_error ? String(ev.result ?? ev.subtype) : null });
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', err => {
      emit({ type: 'done', error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'Claude Code (claude) is not installed or not on PATH' : err.message });
      finished = true;
      reply.raw.end();
    });
    child.on('close', code => {
      if (!finished) emit({ type: 'done', error: stderr.trim().slice(-600) || `claude exited with code ${code}` });
      reply.raw.end();
    });
  });
}
