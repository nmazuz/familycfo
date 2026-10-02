/**
 * Import insurance policies (and their documents) described in a JSON file — e.g. what was collected from
 * Har HaBituach and the insurers' personal areas:
 *   npm run import:insurance -- data/reports/insurance.json
 *
 * A policy is found by insurer + policy number (+ name when given in `match`): found → the listed fields are
 * updated; not found → created. Documents are copied into data/policies/<policy id>/ (once per file name).
 * Asset snapshots (e.g. a savings balance seen on a portal) are added too. Re-running changes nothing new.
 */
import { chmodPrivate, mkdirPrivate } from '../permissions.js';
import { copyFileSync, readFileSync, statSync } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { getDb, type DB } from '../db/connection.js';
import { pickColumns, snake } from '../server/crud.js';
import { POLICIES_DIR } from '../server/routes/insurance.js';

const COLUMNS = ['name', 'type', 'insurer', 'policyNumber', 'insuredMemberId', 'insuredDetails', 'premium', 'premiumFrequency',
  'paymentAccountId', 'matchPattern', 'startDate', 'endDate', 'coverage', 'deductible', 'agentName', 'agentPhone', 'agentEmail',
  'notes', 'archived'].map(snake);
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.md': 'text/markdown', '.txt': 'text/plain',
};

interface PolicyEntry {
  /** how to find an existing policy; defaults to the policy's own insurer + policyNumber */
  match?: { insurer: string; policyNumber: string; name?: string };
  /** member name of the insured (instead of insuredMemberId) */
  insured?: string | null;
  /** fields to set (camelCase, as in the API) */
  set: Record<string, unknown>;
  documents?: { file: string; name?: string; kind?: 'policy' | 'appendix' | 'renewal' | 'claim' | 'other' }[];
}
interface InsuranceImport {
  /** document paths are relative to this folder (relative to the JSON file) */
  documentsRoot?: string;
  policies: PolicyEntry[];
  assetSnapshots?: { provider: string; policyNumber: string; date: string; value: number }[];
}

const safeName = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80) || 'document';

export function importInsurance(db: DB, spec: InsuranceImport, baseDir: string) {
  const root = resolve(baseDir, spec.documentsRoot ?? '.');
  const memberId = (name: string) => {
    const id = db.prepare(`SELECT id FROM members WHERE name = ?`).pluck().get(name) as number | undefined;
    if (id == null) throw new Error(`member not found: ${name}`);
    return id;
  };
  let created = 0, updated = 0, documents = 0, snapshots = 0;
  const copies: { from: string; to: string }[] = [];

  db.transaction(() => {
    for (const entry of spec.policies) {
      const body = { ...entry.set, ...(entry.insured !== undefined ? { insuredMemberId: entry.insured == null ? null : memberId(entry.insured) } : {}) };
      const values = pickColumns(body, COLUMNS);
      const m = entry.match ?? { insurer: String(entry.set.insurer), policyNumber: String(entry.set.policyNumber) };
      const found = db.prepare(`SELECT id FROM insurance_policies WHERE insurer = ? AND policy_number = ?${m.name ? ' AND name = ?' : ''}`)
        .all(...[m.insurer, m.policyNumber, ...(m.name ? [m.name] : [])]) as { id: number }[];
      if (found.length > 1) throw new Error(`several policies match ${m.insurer} ${m.policyNumber} — add match.name`);

      let policyId: number;
      const keys = Object.keys(values);
      if (found.length) {
        policyId = found[0].id;
        if (keys.length) {
          db.prepare(`UPDATE insurance_policies SET ${keys.map(k => `${k} = @${k}`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = @__id`)
            .run({ ...values, __id: policyId });
        }
        updated++;
      } else {
        if (!values.name) throw new Error(`a new policy needs a name (${m.insurer} ${m.policyNumber})`);
        policyId = Number(db.prepare(`INSERT INTO insurance_policies (${keys.join(', ')}) VALUES (${keys.map(k => `@${k}`).join(', ')})`)
          .run(values).lastInsertRowid);
        created++;
      }

      for (const doc of entry.documents ?? []) {
        const from = join(root, doc.file);
        const original = doc.name ?? basename(doc.file);
        const mime = MIME[extname(doc.file).toLowerCase()];
        if (!mime) throw new Error(`unsupported document type: ${doc.file}`);
        const size = statSync(from).size;
        if (db.prepare(`SELECT 1 FROM insurance_documents WHERE policy_id = ? AND original_name = ?`).get(policyId, original)) continue;
        const res = db.prepare(`INSERT INTO insurance_documents (policy_id, file_name, original_name, mime, size, kind) VALUES (?, '', ?, ?, ?, ?)`)
          .run(policyId, original, mime, size, doc.kind ?? 'policy');
        const fileName = `${res.lastInsertRowid}-${safeName(original)}${extname(doc.file).toLowerCase()}`;
        db.prepare(`UPDATE insurance_documents SET file_name = ? WHERE id = ?`).run(fileName, res.lastInsertRowid);
        copies.push({ from, to: join(POLICIES_DIR, String(policyId), fileName) });
        documents++;
      }
    }

    for (const s of spec.assetSnapshots ?? []) {
      const assetId = db.prepare(`SELECT id FROM assets WHERE provider = ? AND policy_number = ?`).pluck().get(s.provider, s.policyNumber) as number | undefined;
      if (assetId == null) throw new Error(`asset not found: ${s.provider} ${s.policyNumber}`);
      if (db.prepare(`SELECT 1 FROM asset_snapshots WHERE asset_id = ? AND date = ?`).get(assetId, s.date)) continue;
      db.prepare(`INSERT INTO asset_snapshots (asset_id, date, value, currency) VALUES (?, ?, ?, 'ILS')`).run(assetId, s.date, s.value);
      snapshots++;
    }
  })();

  // files only after the rows are committed
  for (const c of copies) {
    mkdirPrivate(dirname(c.to));
    copyFileSync(c.from, c.to);
    chmodPrivate(c.to);
  }
  return { created, updated, documents, snapshots };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npm run import:insurance -- <policies.json>');
    process.exit(1);
  }
  const r = importInsurance(getDb(), JSON.parse(readFileSync(file, 'utf-8')) as InsuranceImport, dirname(resolve(file)));
  console.log(`Policies: ${r.created} new, ${r.updated} updated · ${r.documents} documents attached · ${r.snapshots} asset values`);
}
