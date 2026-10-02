/**
 * Import a pension / long-term savings report (e.g. the insurance agent's periodic report), extracted to JSON:
 *   npm run import:pension -- data/reports/2026-08-pension-report.json
 *
 * Products become assets (value snapshot on the report date, fees, tracks, deposits), the insurance in it becomes
 * insurance policies, and the report's own totals are kept in pension_reports. Re-running updates, never duplicates.
 */
import { readFileSync } from 'fs';
import { getDb, type DB } from '../db/connection.js';

type Returns = [number | null, number | null, number | null, number | null, number | null, number | null, number | null];
interface Product {
  type: 'pension' | 'keren_hishtalmut' | 'kupat_gemel';
  name: string; provider: string; policyNumber: string; balance: number;
  feeDeposit?: number | null; feeBalance?: number | null; employer?: string | null; status: 'active' | 'inactive'; joinDate?: string | null;
  lastDeposit?: string | null; regularDeposit?: number | null; insuredSalary?: number | null;
  expectedAnnuity?: number | null; expectedAnnuityWithDeposits?: number | null; agentOfRecord?: string | null;
  tracks?: { name: string; share: number; balance: number; returns: Returns }[];
  components?: { pitzuyim: number; tagmulim: number; capital: number };
  coverages?: { name: string; pct: number; monthly: number }[];
  coverageCost?: { disability: number; survivors: number };
  /** [value date, salary month, salary, employee, employer, severance, total] */
  deposits?: [string, string | null, number | null, number | null, number | null, number | null, number][];
}
interface Policy {
  name: string; type: string; insurer: string; policyNumber: string; premium: number; premiumFrequency: string;
  startDate?: string | null; matchPattern?: string | null; coverage?: string | null; notes?: string | null;
}
interface Report {
  asOf: string; member: string; source: string; file?: string; issuedAt?: string;
  agent?: { name: string; agency?: string; phone?: string; email?: string };
  summary: Record<string, unknown> & { totalSavings: number };
  products: Product[];
  insurance?: Policy[];
}

const addYears = (date: string, years: number) => `${Number(date.slice(0, 4)) + years}${date.slice(4, 10)}`;

function feeText(p: Product): string | null {
  const parts = [p.feeDeposit ? `${p.feeDeposit.toFixed(2)}% מהפקדה` : null, p.feeBalance != null ? `${p.feeBalance.toFixed(2)}% מצבירה` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

export function importPensionReport(db: DB, report: Report): { assets: number; created: number; deposits: number; policies: number } {
  const memberId = db.prepare(`SELECT id FROM members WHERE name = ?`).pluck().get(report.member) as number | undefined;
  if (memberId == null) throw new Error(`member not found: ${report.member}`);
  const sum = report.products.reduce((s, p) => s + p.balance, 0);
  if (Math.abs(sum - report.summary.totalSavings) > 2) {
    throw new Error(`products add up to ${sum}, the report says ${report.summary.totalSavings} — check the extraction`);
  }

  let created = 0, deposits = 0, policies = 0;
  db.transaction(() => {
    for (const p of report.products) {
      // a provider can file two products under one number — the product name tells them apart
      const existing = db.prepare(`SELECT id FROM assets WHERE provider = ? AND policy_number = ? AND type = ?
        AND json_extract(details, '$.product') = ?`).pluck().get(p.provider, p.policyNumber, p.type, p.name) as number | undefined;
      const details = JSON.stringify({
        product: p.name, tracks: p.tracks ?? [], components: p.components ?? null, coverages: p.coverages ?? [],
        coverageCost: p.coverageCost ?? null, insuredSalary: p.insuredSalary ?? null, expectedAnnuityWithDeposits: p.expectedAnnuityWithDeposits ?? null,
        lastDeposit: p.lastDeposit ?? null, agentOfRecord: p.agentOfRecord ?? null, reportAsOf: report.asOf,
      });
      const values = {
        // several study funds can share a generic employer ("שכיר כללי") — the number's tail tells them apart
        name: `${p.name}${p.employer ? ` — ${p.employer}` : ''} ···${p.policyNumber.replace(/\D/g, '').slice(-4)}`,
        type: p.type, provider: p.provider, owner: memberId,
        // a study fund is free to withdraw 6 years after joining; pension and provident funds only at retirement
        liquidity: p.type === 'keren_hishtalmut' && p.joinDate ? addYears(p.joinDate, 6) : null,
        fee: feeText(p), deposit: p.status === 'active' ? p.regularDeposit ?? null : null, policy: p.policyNumber, employer: p.employer ?? null,
        status: p.status, joined: p.joinDate ?? null, feeDeposit: p.feeDeposit ?? null, feeBalance: p.feeBalance ?? null,
        annuity: p.expectedAnnuity ?? null, details,
      };
      let assetId = existing;
      if (assetId == null) {
        assetId = Number(db.prepare(`INSERT INTO assets (name, type, provider, owner_member_id, liquidity_date, management_fee, monthly_deposit, source,
          policy_number, employer, status, join_date, fee_deposit_pct, fee_balance_pct, expected_annuity, details)
          VALUES (@name, @type, @provider, @owner, @liquidity, @fee, @deposit, 'report', @policy, @employer, @status, @joined, @feeDeposit, @feeBalance, @annuity, @details)`)
          .run(values).lastInsertRowid);
        created++;
      } else {
        // the user's own name / notes / owner stay; what the report states is refreshed
        db.prepare(`UPDATE assets SET liquidity_date = @liquidity, management_fee = @fee, monthly_deposit = @deposit, employer = @employer,
          status = @status, join_date = @joined, fee_deposit_pct = @feeDeposit, fee_balance_pct = @feeBalance, expected_annuity = @annuity,
          details = @details, archived = 0 WHERE id = @id`).run({ ...values, id: assetId });
      }

      const snap = db.prepare(`SELECT id FROM asset_snapshots WHERE asset_id = ? AND date = ?`).pluck().get(assetId, report.asOf) as number | undefined;
      if (snap) db.prepare(`UPDATE asset_snapshots SET value = ? WHERE id = ?`).run(p.balance, snap);
      else db.prepare(`INSERT INTO asset_snapshots (asset_id, date, value, currency) VALUES (?, ?, ?, 'ILS')`).run(assetId, report.asOf, p.balance);

      for (const [valueDate, month, salary, employee, employer, severance, total] of p.deposits ?? []) {
        // Migration 15 supplies the NULL-safe expression index; the legacy UNIQUE rule
        // remains for schema compatibility. Regression tests cover both key shapes.
        deposits += db.prepare(`INSERT INTO asset_deposits (asset_id, value_date, salary_month, salary, employee, employer, severance, total)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (asset_id, value_date, COALESCE(salary_month, '')) DO UPDATE SET salary = excluded.salary, employee = excluded.employee,
            employer = excluded.employer, severance = excluded.severance, total = excluded.total`)
          .run(assetId, valueDate, month, salary, employee, employer, severance, total).changes;
      }
    }

    for (const ins of report.insurance ?? []) {
      const existing = db.prepare(`SELECT id, match_pattern, notes FROM insurance_policies WHERE insurer = ? AND policy_number = ? AND name = ?`)
        .get(ins.insurer, ins.policyNumber, ins.name) as { id: number; match_pattern: string | null; notes: string | null } | undefined;
      const values = {
        name: ins.name, type: ins.type, insurer: ins.insurer, policy: ins.policyNumber, member: memberId, premium: ins.premium,
        frequency: ins.premiumFrequency, start: ins.startDate ?? null, pattern: ins.matchPattern ?? null, coverage: ins.coverage ?? null,
        notes: ins.notes ?? null, agent: report.agent?.name ?? null, phone: report.agent?.phone ?? null, email: report.agent?.email ?? null,
      };
      if (!existing) {
        db.prepare(`INSERT INTO insurance_policies (name, type, insurer, policy_number, insured_member_id, premium, premium_frequency, start_date,
          match_pattern, coverage, notes, agent_name, agent_phone, agent_email)
          VALUES (@name, @type, @insurer, @policy, @member, @premium, @frequency, @start, @pattern, @coverage, @notes, @agent, @phone, @email)`).run(values);
      } else {
        // keep a match pattern / notes the user changed; refresh what the report states
        db.prepare(`UPDATE insurance_policies SET type = @type, premium = @premium, premium_frequency = @frequency, start_date = @start,
          coverage = @coverage, agent_name = COALESCE(agent_name, @agent), agent_phone = COALESCE(agent_phone, @phone),
          agent_email = COALESCE(agent_email, @email), match_pattern = COALESCE(match_pattern, @pattern), updated_at = CURRENT_TIMESTAMP
          WHERE id = @id`).run({ ...values, id: existing.id });
      }
      policies++;
    }

    db.prepare(`INSERT INTO pension_reports (as_of, member_id, source, file_path, summary) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (as_of, member_id, source) DO UPDATE SET file_path = excluded.file_path, summary = excluded.summary, imported_at = CURRENT_TIMESTAMP`)
      .run(report.asOf, memberId, report.source, report.file ? `reports/${report.file}` : null,
        JSON.stringify({ ...report.summary, agent: report.agent ?? null, issuedAt: report.issuedAt ?? null }));
  })();

  return { assets: report.products.length, created, deposits, policies };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npm run import:pension -- <report.json>');
    process.exit(1);
  }
  const result = importPensionReport(getDb(), JSON.parse(readFileSync(file, 'utf-8')) as Report);
  console.log(`Imported: ${result.assets} products (${result.created} new), ${result.deposits} deposit rows, ${result.policies} insurance policies`);
}
