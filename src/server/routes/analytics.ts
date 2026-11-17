import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { addDays, cycleByKey, cycleFor, cycleStartDay, filterTx, loadTransactions, today } from '../../analytics/common.js';
import { cashflowHistory, cycleSummary, expectedIncome, monthIncome } from '../../analytics/cashflow.js';
import { budgetStatus } from '../../analytics/budgets.js';
import { buildForecast, bankBalances, planningPeriod } from '../../analytics/forecast.js';
import { installmentPlans, upcomingCardCharges } from '../../analytics/cards.js';
import { savingsCapacity, tightMonthPlan } from '../../analytics/planning.js';
import { buildRecommendations } from '../../analytics/recommendations.js';
import { netWorth } from '../../analytics/networth.js';
import { refreshPrices } from './investments.js';
import { runPipeline } from '../../pipeline.js';
import { SCRAPERS } from 'israeli-bank-scrapers';
import { scrapeState, startScrape, submitOtp } from '../scrapeJob.js';
import { downloadState, findBrowser, startBrowserDownload } from '../../browser.js';
import { toApi } from '../crud.js';
import { monthPlan } from '../../analytics/commitments.js';
import { parseFilter } from './transactions.js';

type Q = Record<string, string | undefined>;

export function analyticsRoutes(app: FastifyInstance, db: DB): void {
  app.get('/api/summary', async req => {
    const q = req.query as Q;
    const filter = parseFilter(q);
    const forecast = buildForecast(db, { memberId: filter.memberId });
    const windowEnd = [forecast.period.end, addDays(today(), 30)].sort()[1];
    const txs = loadTransactions(db);
    const periodCycle = cycleByKey(forecast.period.key, cycleStartDay(db));
    return {
      cycle: cycleSummary(db, q.cycle, filter),
      balances: bankBalances(db),
      forecast: {
        cycle: forecast.cycle,
        period: forecast.period,
        // at least the next 30 days, even near the end of a cycle
        total: { ...forecast.total, points: forecast.total.points.filter(p => p.date <= windowEnd) },
        // what is charged / paid in on each day of the chart (hover or click a day on the dashboard)
        events: forecast.events.filter(e => e.source !== 'dynamic' && e.date <= windowEnd),
        accounts: forecast.accounts.map(a => ({ ...a, points: undefined })),
        remaining: forecast.remaining,
        warnings: forecast.warnings,
        buffer: forecast.buffer,
      },
      cardCharges: upcomingCardCharges(db, txs).slice(0, 8),
      budgets: budgetStatus(db, { cycleKey: q.cycle, memberId: filter.memberId }).filter(b => b.budget != null).slice(0, 10),
      alerts: (db.prepare(`SELECT * FROM alerts WHERE dismissed_at IS NULL ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC LIMIT 6`).all() as Record<string, unknown>[]).map(toApi),
      capacity: savingsCapacity(db, filter),
      income: expectedIncome(db, filter),
      // the income of the month being planned (arrived + recurring still expected)
      monthIncome: monthIncome(db, filter, periodCycle),
    };
  });

  app.get('/api/income', async req => {
    const q = req.query as Q;
    const startDay = cycleStartDay(db);
    return monthIncome(db, parseFilter(q), q.cycle ? cycleByKey(q.cycle, startDay) : cycleFor(today(), startDay));
  });

  app.get('/api/cashflow', async req => {
    const q = req.query as Q;
    return cashflowHistory(db, { ...parseFilter(q), cycles: Number(q.cycles ?? 6) });
  });

  app.get('/api/forecast', async req => {
    const q = req.query as Q;
    return buildForecast(db, { memberId: q.member ? Number(q.member) : undefined, horizonDays: Number(q.days ?? 60) });
  });

  app.get('/api/cards/upcoming', async () => upcomingCardCharges(db, loadTransactions(db)));
  app.get('/api/month-plan', async req => monthPlan(db, parseFilter(req.query as Q), { cycleKey: (req.query as Q).cycle || undefined }));
  app.get('/api/installments', async req => installmentPlans(filterTx(loadTransactions(db), parseFilter(req.query as Q))));

  app.get('/api/recurring', async () => (db.prepare(`
    SELECT s.*, c.name AS category_name,
      (SELECT description FROM transactions t WHERE t.account_id = s.account_id ORDER BY t.date DESC LIMIT 1) AS sample
    FROM recurring_series s LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.active = 1 ORDER BY s.kind, s.typical_amount DESC
  `).all() as Record<string, unknown>[]).map(toApi));

  app.get('/api/budgets', async req => {
    const q = req.query as Q;
    return budgetStatus(db, { cycleKey: q.cycle, memberId: q.member ? Number(q.member) : undefined });
  });

  app.put('/api/budgets', async req => {
    const b = req.body as { categoryId: number; memberId?: number | null; monthlyAmount: number | null; effectiveFrom?: string };
    const from = b.effectiveFrom ?? cycleFor(today(), cycleStartDay(db)).key;
    if (b.monthlyAmount == null) {
      db.prepare(`DELETE FROM budgets WHERE category_id = ? AND member_id IS ? AND effective_from >= ?`).run(b.categoryId, b.memberId ?? null, from);
    } else {
      db.prepare(`DELETE FROM budgets WHERE category_id = ? AND member_id IS ? AND effective_from = ?`).run(b.categoryId, b.memberId ?? null, from);
      db.prepare(`INSERT INTO budgets (category_id, member_id, monthly_amount, effective_from) VALUES (?, ?, ?, ?)`)
        .run(b.categoryId, b.memberId ?? null, b.monthlyAmount, from);
    }
    return { ok: true };
  });

  app.get('/api/planning', async req => {
    const filter = parseFilter(req.query as Q);
    const period = planningPeriod(today(), cycleStartDay(db));
    return { capacity: savingsCapacity(db, filter), tight: tightMonthPlan(db), income: expectedIncome(db, filter), monthIncome: monthIncome(db, filter, period) };
  });

  app.get('/api/alerts', async req => {
    const all = (req.query as Q).all === '1';
    return (db.prepare(`SELECT * FROM alerts ${all ? '' : 'WHERE dismissed_at IS NULL'} ORDER BY created_at DESC, id DESC LIMIT 300`)
      .all() as Record<string, unknown>[]).map(toApi);
  });

  app.patch('/api/alerts/:id', async req => {
    const b = req.body as { seen?: boolean; dismissed?: boolean };
    const id = Number((req.params as { id: string }).id);
    if (b.seen) db.prepare(`UPDATE alerts SET seen_at = COALESCE(seen_at, CURRENT_TIMESTAMP) WHERE id = ?`).run(id);
    if (b.dismissed != null) db.prepare(`UPDATE alerts SET dismissed_at = ${b.dismissed ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = ?`).run(id);
    return { ok: true };
  });

  app.get('/api/recommendations', async () => buildRecommendations(db));
  app.post('/api/recommendations/state', async req => {
    const b = req.body as { key: string; state: 'dismissed' | 'snoozed' | 'done' | null; until?: string };
    if (!b.state) db.prepare(`DELETE FROM recommendation_states WHERE key = ?`).run(b.key);
    else db.prepare(`INSERT INTO recommendation_states (key, state, until) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET state = excluded.state, until = excluded.until, updated_at = CURRENT_TIMESTAMP`).run(b.key, b.state, b.until ?? null);
    return { ok: true };
  });

  app.get('/api/networth', async () => {
    await refreshPrices(db, 5 * 60_000);
    return netWorth(db);
  });

  // ---- businesses ---------------------------------------------------------------------------
  app.get('/api/businesses/:id/report', async req => {
    const id = Number((req.params as { id: string }).id);
    const q = req.query as Q;
    const txs = loadTransactions(db, { from: q.from, to: q.to }).filter(t => t.businessId === id);
    const months = new Map<string, { income: number; expenses: number }>();
    for (const t of txs) {
      const m = months.get(t.effectiveDate.slice(0, 7)) ?? { income: 0, expenses: 0 };
      if (t.businessAmount > 0) m.income += t.businessAmount; else m.expenses += -t.businessAmount;
      months.set(t.effectiveDate.slice(0, 7), m);
    }
    return {
      transactions: txs.sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate)),
      months: [...months.entries()].sort().map(([month, v]) => ({ month, ...v })),
      totals: {
        income: txs.filter(t => t.businessAmount > 0).reduce((s, t) => s + t.businessAmount, 0),
        expenses: txs.filter(t => t.businessAmount < 0).reduce((s, t) => s - t.businessAmount, 0),
      },
    };
  });

  app.get('/api/businesses/:id/export.csv', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const q = req.query as Q;
    const rows = loadTransactions(db, { from: q.from, to: q.to }).filter(t => t.businessId === id);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['date,charge_date,description,category,amount_ils,business_amount_ils,notes',
      ...rows.map(t => [t.date, t.processedDate, t.description, t.categoryName, t.amount.toFixed(2), t.businessAmount.toFixed(2), t.notes].map(esc).join(','))];
    reply.header('content-type', 'text/csv; charset=utf-8');
    return '﻿' + csv.join('\n');
  });

  // ---- operations -------------------------------------------------------------------------
  app.post('/api/pipeline', async () => runPipeline(db, { txIds: [] }));

  // the scrape started from the UI: progress, and the bank's OTP request
  app.get('/api/scrape', async () => ({
    ...scrapeState(),
    lastSuccessAt: db.prepare(`SELECT MAX(finished_at) FROM scrape_runs WHERE success = 1`).pluck().get() as string | null,
  }));
  app.post('/api/scrape', async req => {
    const showBrowser = (req.body as { showBrowser?: unknown } | null)?.showBrowser;
    return startScrape(db, { showBrowser: typeof showBrowser === 'boolean' ? showBrowser : undefined });
  });
  // the browser the scraper drives: an installed one, or Chrome for Testing downloaded into the data folder
  app.get('/api/browser', async () => ({ found: await findBrowser(), download: downloadState() }));
  app.post('/api/browser/download', async () => startBrowserDownload());

  // the banks / card companies the scraper supports and the names of their login fields (no values) — for the
  // desktop app's bank-accounts form
  app.get('/api/scrape/companies', async () => Object.entries(SCRAPERS)
    .map(([id, s]) => ({ id, name: s.name, loginFields: s.loginFields.map(String) })));
  // the desktop app checks a login right after it is saved: log in, read a few days, save nothing
  app.post('/api/scrape/check', async (req, reply) => {
    const loginId = String((req.body as { loginId?: unknown })?.loginId ?? '');
    if (!/^[\w-]{8,64}$/.test(loginId)) return reply.code(400).send({ error: 'loginId is required' });
    return startScrape(db, { loginIds: [loginId], checkOnly: true });
  });
  app.post('/api/scrape/otp', async req => {
    submitOtp(String((req.body as { code?: unknown })?.code ?? '').trim());
    return { ok: true };
  });

  app.get('/api/sync-status', async () => (db.prepare(`
    SELECT r.company, r.started_at, r.finished_at, r.success, r.error_type, r.error_message, r.new_transactions,
      (SELECT MAX(started_at) FROM scrape_runs WHERE company = r.company AND success = 1) AS last_success
    FROM scrape_runs r WHERE r.id = (SELECT MAX(id) FROM scrape_runs WHERE company = r.company)
    ORDER BY r.company
  `).all() as Record<string, unknown>[]).map(toApi));
}
