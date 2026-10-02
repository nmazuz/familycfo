import Fastify from 'fastify';
import { pathToFileURL } from 'url';
import type { DB } from '../db/connection.js';
import { getDb } from '../db/connection.js';
import { registerCrud, toApi } from './crud.js';
import { transactionRoutes } from './routes/transactions.js';
import { analyticsRoutes } from './routes/analytics.js';
import { eventRoutes } from './routes/events.js';
import { categoryRoutes } from './routes/categories.js';
import { agentRoutes } from './agent.js';
import { insuranceRoutes } from './routes/insurance.js';
import { pensionRoutes } from './routes/pension.js';
import { investmentRoutes } from './routes/investments.js';
import { setRate } from '../analytics/fx.js';
import { registerRequestGuard } from './requestGuard.js';
import { warnBroadPermissions } from '../permissions.js';

// Local-only: this API exposes the household's full financial data and has no login
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 4310);

/** Build the same guarded app used in production, without opening a socket or database. */
export function buildApp(db: DB) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' } });
  // Host / Origin checks against DNS rebinding and cross-site writes; before the routes so it covers all of them
  registerRequestGuard(app);

  registerCrud(app, db, { table: 'members', path: 'members', columns: ['name', 'color'], allowDelete: false });
  registerCrud(app, db, {
    table: 'accounts', path: 'accounts', idType: 'text', allowCreate: false, allowDelete: false,
    columns: ['displayName', 'ownerMemberId', 'billingBankAccountId', 'active'], orderBy: 'kind, id',
  });
  registerCrud(app, db, { table: 'businesses', path: 'businesses', columns: ['name', 'color', 'archived'], orderBy: 'name' });
  registerCrud(app, db, { table: 'tags', path: 'tags', columns: ['name', 'color', 'startDate', 'endDate', 'budget', 'notes', 'archived'], orderBy: 'name' });
  registerCrud(app, db, { table: 'sinking_funds', path: 'funds', columns: ['name', 'monthlyTarget', 'balance', 'goalAmount', 'goalDate'] });
  registerCrud(app, db, {
    table: 'assets', path: 'assets', orderBy: 'type, name',
    columns: ['name', 'type', 'provider', 'ownerMemberId', 'currency', 'liquidityDate', 'managementFee', 'monthlyDeposit', 'notes', 'archived'],
  });
  registerCrud(app, db, { table: 'asset_snapshots', path: 'asset-snapshots', columns: ['assetId', 'date', 'value', 'currency'], orderBy: 'date DESC' });
  registerCrud(app, db, {
    table: 'liabilities', path: 'liabilities', orderBy: 'type, name',
    columns: ['name', 'type', 'lender', 'ownerMemberId', 'originalPrincipal', 'interestRate', 'indexType', 'startDate',
      'endDate', 'monthlyPayment', 'paymentDay', 'bankAccountId', 'matchPattern', 'notes', 'archived'],
  });
  registerCrud(app, db, { table: 'liability_snapshots', path: 'liability-snapshots', columns: ['liabilityId', 'date', 'balance'], orderBy: 'date DESC' });
  registerCrud(app, db, {
    table: 'scheduled_items', path: 'scheduled', orderBy: 'day_of_month, name',
    columns: ['name', 'kind', 'amount', 'amountMode', 'dayOfMonth', 'bankAccountId', 'memberId', 'categoryId', 'matchPattern',
      'liabilityId', 'cardAccountId', 'startDate', 'endDate', 'status'],
  });

  app.get('/api/meta', async () => ({
    members: (db.prepare(`SELECT * FROM members ORDER BY id`).all() as Record<string, unknown>[]).map(toApi),
    accounts: (db.prepare(`SELECT * FROM accounts ORDER BY kind, id`).all() as Record<string, unknown>[]).map(toApi),
    categories: (db.prepare(`SELECT * FROM categories ORDER BY name`).all() as Record<string, unknown>[]).map(toApi),
    businesses: (db.prepare(`SELECT * FROM businesses ORDER BY name`).all() as Record<string, unknown>[]).map(toApi),
    tags: (db.prepare(`SELECT * FROM tags ORDER BY name`).all() as Record<string, unknown>[]).map(toApi),
    funds: (db.prepare(`SELECT * FROM sinking_funds ORDER BY id`).all() as Record<string, unknown>[]).map(toApi),
    settings: Object.fromEntries((db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[]).map(s => [s.key, s.value])),
  }));

  app.put('/api/settings', async req => {
    const body = req.body as Record<string, string | number>;
    const allowed = ['cycle_start_day', 'balance_buffer'];
    const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    for (const [k, v] of Object.entries(body)) if (allowed.includes(k)) upsert.run(k, String(v));
    return { ok: true };
  });

  app.get('/api/fx', async () => db.prepare(`
    SELECT currency, rate_to_ils, date, source FROM fx_rates f
    WHERE date = (SELECT MAX(date) FROM fx_rates WHERE currency = f.currency) ORDER BY currency
  `).all());
  app.put('/api/fx', async req => {
    const b = req.body as { currency: string; rate: number; date?: string };
    setRate(db, b.date ?? new Date().toISOString().slice(0, 10), b.currency, b.rate);
    return { ok: true };
  });

  transactionRoutes(app, db);
  analyticsRoutes(app, db);
  eventRoutes(app, db);
  categoryRoutes(app, db);
  agentRoutes(app, db);
  insuranceRoutes(app, db);
  pensionRoutes(app, db);
  investmentRoutes(app, db);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    app.log.error(err);
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });
  return app;
}

// Importing buildApp in tests must not start a server or touch the household database.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = buildApp(getDb());
  warnBroadPermissions();
  await app.listen({ host: HOST, port: PORT });
  console.log(`Household API on http://${HOST}:${PORT}`);
}
