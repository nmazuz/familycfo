import type { FastifyInstance } from 'fastify';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { SCRAPERS } from 'israeli-bank-scrapers';
import type { DB } from '../../db/connection.js';
import { BANK_COMPANIES, MANUAL_ACCOUNT_ID } from '../../db/migrations.js';
import { ACCOUNTS_FILE } from '../../config.js';
import { scrapeRunning } from '../scrapeJob.js';
import type { Config } from '../../scraper.js';

/**
 * First-run setup from the UI: household members, the bank / card logins (accounts.json) and a
 * "start over" reset. Credentials are written to the git-ignored logins file and never sent back:
 * the API only reports which fields are filled.
 */

// oneZero needs an OTP callback / long-term token that a JSON file can't hold
const UNSUPPORTED = new Set(['oneZero']);

// tables a reset keeps: schema, the category tree and market data (not personal)
const KEEP_TABLES = new Set(['schema_version', 'categories', 'category_aliases', 'fx_rates', 'quotes', 'quote_history']);

interface LoginInput { companyId: string; ownerMemberId?: number | null; credentials?: Record<string, string>; keepFrom?: number | null }

function readConfig(): Config | null {
  if (!existsSync(ACCOUNTS_FILE)) return null;
  return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8')) as Config;
}

function writeConfig(config: Config) {
  const tmp = `${ACCOUNTS_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, ACCOUNTS_FILE);
  chmodSync(ACCOUNTS_FILE, 0o600);
}

const fieldsOf = (companyId: string): string[] =>
  ((SCRAPERS as Record<string, { loginFields: string[] }>)[companyId]?.loginFields ?? []).filter(f => typeof f === 'string');

// values copied from accounts.example.json (YOUR_PASSWORD, 123456…) count as not filled in
const EXAMPLE_VALUES = new Set<string>(existsSync('accounts.example.json')
  ? (JSON.parse(readFileSync('accounts.example.json', 'utf-8')) as Config).accounts.flatMap(a => Object.values(a.credentials))
  : []);
const isPlaceholder = (v: unknown) => typeof v !== 'string' || !v.trim() || v.startsWith('YOUR_') || EXAMPLE_VALUES.has(v);

const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

export function setupRoutes(app: FastifyInstance, db: DB) {
  app.get('/api/setup/companies', async () =>
    Object.entries(SCRAPERS as Record<string, { name: string; loginFields: string[] }>)
      .filter(([id]) => !UNSUPPORTED.has(id))
      .map(([id, s]) => ({ id, name: s.name, kind: BANK_COMPANIES.has(id) ? 'bank' : 'card', fields: fieldsOf(id) })));

  // which logins exist and which fields are filled — never the values
  app.get('/api/setup/logins', async () => {
    const config = readConfig();
    const logins = (config?.accounts ?? []).map((a, index) => ({
      index, companyId: a.companyId, ownerMemberId: a.ownerMemberId ?? null,
      filled: Object.fromEntries(fieldsOf(a.companyId).map(f => [f, !isPlaceholder(a.credentials?.[f])])) as Record<string, boolean>,
    }));
    // ready = a scrape can run (a login is fully filled in) or data was already uploaded / scraped
    const hasData = !!db.prepare(`SELECT 1 FROM accounts WHERE kind IN ('bank', 'card') LIMIT 1`).get();
    const canScrape = logins.some(l => Object.values(l.filled).every(Boolean));
    return { exists: !!config, ready: hasData || canScrape, canScrape, logins };
  });

  // replace the whole list; an empty field keeps the saved value of the login it came from (keepFrom)
  app.put('/api/setup/logins', async req => {
    const body = req.body as { logins?: LoginInput[] };
    if (!Array.isArray(body?.logins)) throw badRequest('logins must be a list');
    const old = readConfig();
    const accounts = body.logins.map(l => {
      const fields = fieldsOf(l.companyId);
      if (!fields.length || UNSUPPORTED.has(l.companyId)) throw badRequest(`unsupported company: ${l.companyId}`);
      const prev = l.keepFrom != null ? old?.accounts[l.keepFrom] : undefined;
      if (prev && prev.companyId !== l.companyId) throw badRequest('keepFrom points at a different company');
      const credentials: Record<string, string> = {};
      for (const f of fields) {
        const typed = l.credentials?.[f];
        const value = typeof typed === 'string' && typed.trim() ? typed.trim() : prev?.credentials?.[f];
        if (isPlaceholder(value)) throw badRequest(`missing ${f} for ${l.companyId}`);
        credentials[f] = value!;
      }
      return { companyId: l.companyId as Config['accounts'][number]['companyId'], ownerMemberId: l.ownerMemberId ?? null, credentials };
    });
    writeConfig({ ...(old ?? {}), accounts });
    return { ok: true, count: accounts.length };
  });

  app.delete('/api/setup/members/:id', async req => {
    const id = Number((req.params as { id: string }).id);
    if (id === 3) throw badRequest('״משותף״ is the household default and can\'t be removed');
    try {
      db.prepare(`DELETE FROM members WHERE id = ?`).run(id);
    } catch {
      throw Object.assign(new Error('בן הבית משויך לחשבונות או לתנועות — שייכו אותם למישהו אחר קודם'), { statusCode: 409 });
    }
    const config = readConfig();
    if (config?.accounts.some(a => a.ownerMemberId === id)) {
      writeConfig({ ...config, accounts: config.accounts.map(a => (a.ownerMemberId === id ? { ...a, ownerMemberId: null } : a)) });
    }
    return { ok: true };
  });

  // start over: back up the database, then empty it back to a new household's defaults
  app.post('/api/setup/reset', async req => {
    const body = req.body as { confirm?: boolean; clearLogins?: boolean };
    if (body?.confirm !== true) throw badRequest('confirm: true is required');
    if (scrapeRunning()) throw Object.assign(new Error('a scrape is running — wait for it to finish'), { statusCode: 409 });

    mkdirSync('backups', { recursive: true });
    const backup = `backups/before-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    await db.backup(backup);

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).pluck().all() as string[])
      .filter(t => !KEEP_TABLES.has(t));
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        for (const t of tables) db.exec(`DELETE FROM "${t}"`);
        const insertMember = db.prepare(`INSERT INTO members (id, name, color) VALUES (?, ?, ?)`);
        insertMember.run(1, 'בן/בת זוג 1', '#2563eb');
        insertMember.run(2, 'בן/בת זוג 2', '#db2777');
        insertMember.run(3, 'משותף', '#6b7280');
        const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
        setSetting.run('cycle_start_day', '1');
        setSetting.run('balance_buffer', '2000');
        const insertFund = db.prepare(`INSERT INTO sinking_funds (name, monthly_target) VALUES (?, 0)`);
        for (const name of ['חיסכון', 'חופשות', 'הוצאות חריגות']) insertFund.run(name);
        db.prepare(`INSERT INTO accounts (id, company, kind, display_name) VALUES (?, 'manual', 'manual', 'הזנה ידנית')`).run(MANUAL_ACCOUNT_ID);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
    if (body.clearLogins && existsSync(ACCOUNTS_FILE)) unlinkSync(ACCOUNTS_FILE);
    return { ok: true, backup };
  });
}
