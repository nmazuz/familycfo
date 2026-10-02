import { mkdirPrivate, PRIVATE_FILE_MODE } from '../../permissions.js';
import { createReadStream, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { addDays, today } from '../../analytics/common.js';
import { pickColumns, snake, toApi } from '../crud.js';

/**
 * Insurance policies and their documents. Files live in data/policies/<policy id>/ (git-ignored);
 * the data chat reads them from there (src/server/agent.ts).
 */
export const POLICIES_DIR = resolve(process.env.POLICIES_DIR ?? join('data', 'policies'));
/** Imported reports (pension / insurance summaries) and their extracted JSON. */
export const REPORTS_DIR = resolve(process.env.REPORTS_DIR ?? join('data', 'reports'));

const COLUMNS = ['name', 'type', 'insurer', 'policyNumber', 'insuredMemberId', 'insuredDetails', 'premium', 'premiumFrequency',
  'paymentAccountId', 'matchPattern', 'startDate', 'endDate', 'coverage', 'deductible', 'agentName', 'agentPhone', 'agentEmail',
  'notes', 'archived'].map(snake);

const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
};
const DOC_KINDS = ['policy', 'appendix', 'renewal', 'claim', 'other'];
const MAX_FILE = 40 * 1024 * 1024;

type Row = Record<string, any>;

/** Keep the name readable (Hebrew too) but safe as a file name. */
const safeName = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'document';

/** Insurance-looking charges of the last year: by category ("ביטוח…") or by a policy's pattern. */
function insuranceCharges(db: DB): Row[] {
  return db.prepare(`
    SELECT t.id, t.description, t.date, t.account_id, -t.charged_amount AS amount, t.category_id
    FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN categories p ON p.id = c.parent_id
    WHERE t.excluded = 0 AND t.kind IN ('expense', 'refund') AND t.date >= ? AND t.date <= ?
      AND (c.name LIKE '%ביטוח%' OR p.name LIKE '%ביטוח%' OR EXISTS (
        SELECT 1 FROM insurance_policies ip WHERE ip.archived = 0 AND ip.match_pattern IS NOT NULL AND ip.match_pattern <> ''
          AND instr(lower(t.description), lower(ip.match_pattern)) > 0))
    ORDER BY t.date`).all(addDays(today(), -365), `${today()}T23:59:59`) as Row[];
}

/** A charge is the policy's when its text matches — and it's from the paying account, if one is set. */
const matches = (policy: Row, charge: Row) =>
  !!policy.match_pattern?.trim() && charge.description.toLowerCase().includes(String(policy.match_pattern).trim().toLowerCase())
  && (!policy.payment_account_id || charge.account_id === policy.payment_account_id);

/** Normalized monthly cost of a policy's premium. */
const monthlyPremium = (p: Row) => (p.premium == null ? 0 : p.premium_frequency === 'yearly' ? p.premium / 12 : p.premium_frequency === 'one_time' ? 0 : p.premium);

function documentsOf(db: DB, policyId?: number): Row[] {
  const rows = (policyId == null
    ? db.prepare(`SELECT * FROM insurance_documents ORDER BY uploaded_at DESC`).all()
    : db.prepare(`SELECT * FROM insurance_documents WHERE policy_id = ? ORDER BY uploaded_at DESC`).all(policyId)) as Row[];
  // the path is what the data chat opens (relative to its work dir)
  return rows.map(d => ({ ...toApi(d), path: `docs/policies/${d.policy_id}/${d.file_name}` }));
}

export function insuranceRoutes(app: FastifyInstance, db: DB): void {
  app.addContentTypeParser(Object.keys(MIME_EXT).concat('application/octet-stream'), { parseAs: 'buffer', bodyLimit: MAX_FILE },
    (_req, body, done) => done(null, body));

  app.get('/api/insurance', async () => {
    const policies = db.prepare(`SELECT * FROM insurance_policies ORDER BY archived, type, name`).all() as Row[];
    const docs = documentsOf(db);
    const charges = insuranceCharges(db);
    const soon = addDays(today(), 60);

    const list = policies.map(p => {
      const paid = charges.filter(c => matches(p, c));
      const last = paid[paid.length - 1];
      return {
        ...toApi(p),
        archived: Number(p.archived),
        monthlyPremium: monthlyPremium(p),
        documents: docs.filter(d => d.policyId === p.id),
        payments: {
          last12: paid.reduce((s, c) => s + c.amount, 0),
          count: paid.length,
          lastDate: last?.date?.slice(0, 10) ?? null,
          lastAmount: last?.amount ?? null,
        },
        renewalSoon: !!p.end_date && !p.archived && p.end_date >= today() && p.end_date <= soon,
      };
    });

    // charges no policy explains yet — "add a policy for it"
    const active = policies.filter(p => !p.archived);
    const unlinked = new Map<string, { description: string; accountId: string; count: number; total: number; lastDate: string; lastAmount: number }>();
    for (const c of charges) {
      if (active.some(p => matches(p, c))) continue;
      // the same text on two cards is two different things (e.g. his and her policy at one insurer)
      const key = `${c.description}|${c.account_id}`;
      const g = unlinked.get(key) ?? { description: c.description, accountId: c.account_id, count: 0, total: 0, lastDate: '', lastAmount: 0 };
      g.count++;
      g.total += c.amount;
      g.lastDate = c.date.slice(0, 10);
      g.lastAmount = c.amount;
      unlinked.set(key, g);
    }

    const current = list.filter(p => !p.archived);
    return {
      policies: list,
      unlinked: [...unlinked.values()].filter(u => u.total > 0).sort((a, b) => b.total - a.total),
      totals: {
        count: current.length,
        monthly: current.reduce((s, p) => s + p.monthlyPremium, 0),
        paidLast12: current.reduce((s, p) => s + p.payments.last12, 0),
        renewalsSoon: current.filter(p => p.renewalSoon).length,
        documents: docs.length,
      },
    };
  });

  app.post('/api/insurance', async (req, reply) => {
    const values = pickColumns(req.body as Row, COLUMNS);
    if (!values.name) return reply.code(400).send({ error: 'name is required' });
    const keys = Object.keys(values);
    const res = db.prepare(`INSERT INTO insurance_policies (${keys.join(', ')}) VALUES (${keys.map(k => `@${k}`).join(', ')})`).run(values);
    return toApi(db.prepare(`SELECT * FROM insurance_policies WHERE id = ?`).get(res.lastInsertRowid) as Row);
  });

  app.patch('/api/insurance/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const values = pickColumns(req.body as Row, COLUMNS);
    const keys = Object.keys(values);
    if (!keys.length) return reply.code(400).send({ error: 'no fields' });
    const res = db.prepare(`UPDATE insurance_policies SET ${keys.map(k => `${k} = @${k}`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = @__id`)
      .run({ ...values, __id: id });
    if (!res.changes) return reply.code(404).send({ error: 'not found' });
    return toApi(db.prepare(`SELECT * FROM insurance_policies WHERE id = ?`).get(id) as Row);
  });

  app.delete('/api/insurance/:id', async req => {
    const id = Number((req.params as { id: string }).id);
    db.prepare(`DELETE FROM insurance_policies WHERE id = ?`).run(id);
    rmSync(join(POLICIES_DIR, String(id)), { recursive: true, force: true });
    return { ok: true };
  });

  // upload: the raw file as the body, its name in ?name=
  app.post('/api/insurance/:id/documents', async (req, reply) => {
    const policyId = Number((req.params as { id: string }).id);
    const q = req.query as { name?: string; kind?: string };
    const mime = String(req.headers['content-type'] ?? '').split(';')[0];
    const body = req.body as Buffer;
    if (!db.prepare(`SELECT 1 FROM insurance_policies WHERE id = ?`).get(policyId)) return reply.code(404).send({ error: 'policy not found' });
    if (!MIME_EXT[mime]) return reply.code(415).send({ error: 'only PDF or image files' });
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: 'empty file' });
    const original = String(q.name ?? `document.${MIME_EXT[mime]}`);
    const kind = DOC_KINDS.includes(String(q.kind)) ? String(q.kind) : 'policy';

    const res = db.prepare(`INSERT INTO insurance_documents (policy_id, file_name, original_name, mime, size, kind) VALUES (?, '', ?, ?, ?, ?)`)
      .run(policyId, original, mime, body.length, kind);
    const fileName = `${res.lastInsertRowid}-${safeName(original)}.${MIME_EXT[mime]}`;
    mkdirPrivate(join(POLICIES_DIR, String(policyId)));
    writeFileSync(join(POLICIES_DIR, String(policyId), fileName), body, { mode: PRIVATE_FILE_MODE });
    db.prepare(`UPDATE insurance_documents SET file_name = ? WHERE id = ?`).run(fileName, res.lastInsertRowid);
    return documentsOf(db, policyId).find(d => d.id === Number(res.lastInsertRowid));
  });

  app.get('/api/insurance/documents/:docId/file', async (req, reply) => {
    const doc = db.prepare(`SELECT * FROM insurance_documents WHERE id = ?`).get(Number((req.params as { docId: string }).docId)) as Row | undefined;
    if (!doc) return reply.code(404).send({ error: 'not found' });
    const path = join(POLICIES_DIR, String(doc.policy_id), doc.file_name);
    try { statSync(path); } catch { return reply.code(404).send({ error: 'file is missing' }); }
    reply.header('content-type', doc.mime);
    reply.header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.original_name)}`);
    return reply.send(createReadStream(path));
  });

  app.patch('/api/insurance/documents/:docId', async (req, reply) => {
    const kind = String((req.body as { kind?: string })?.kind);
    if (!DOC_KINDS.includes(kind)) return reply.code(400).send({ error: 'bad kind' });
    db.prepare(`UPDATE insurance_documents SET kind = ? WHERE id = ?`).run(kind, Number((req.params as { docId: string }).docId));
    return { ok: true };
  });

  app.delete('/api/insurance/documents/:docId', async req => {
    const doc = db.prepare(`SELECT * FROM insurance_documents WHERE id = ?`).get(Number((req.params as { docId: string }).docId)) as Row | undefined;
    if (doc) {
      db.prepare(`DELETE FROM insurance_documents WHERE id = ?`).run(doc.id);
      rmSync(join(POLICIES_DIR, String(doc.policy_id), doc.file_name), { force: true });
    }
    return { ok: true };
  });
}
