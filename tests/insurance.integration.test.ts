import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import { addAccount, addTx, testDb } from './helpers.js';

let db: DB; let app: FastifyInstance; let dir: string;
let importInsurance: typeof import('../src/import/insurancePolicies.js').importInsurance;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'familycfo-insurance-')); vi.stubEnv('POLICIES_DIR', join(dir, 'policies')); vi.stubEnv('REPORTS_DIR', join(dir, 'reports'));
  vi.resetModules(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  const insurance = await import('../src/server/routes/insurance.js');
  importInsurance = (await import('../src/import/insurancePolicies.js')).importInsurance;
  db = testDb(); app = Fastify(); insurance.insuranceRoutes(app, db); addAccount(db, 'card:test', 'card');
});
afterEach(async () => { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.useRealTimers(); });
const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
async function policy(extra = {}) { const r = await post('/api/insurance', { name: 'Invented policy', type: 'health', ...extra }); expect(r.statusCode).toBe(200); return r.json().id as number; }

describe('policy costs and document lifecycle', () => {
  it('annual and one-time premiums, refunds and matching paying account use distinct accounting rules', async () => {
    const id = await policy({ premium: 1200, premiumFrequency: 'yearly', matchPattern: 'Test insurer', paymentAccountId: 'card:test', endDate: '2026-10-01' });
    await policy({ premium: 900, premiumFrequency: 'one_time' });
    addAccount(db, 'card:other', 'card');
    addTx(db, { account: 'card:test', date: '2026-09-01', description: 'Test insurer', amount: -100, kind: 'expense' });
    addTx(db, { account: 'card:test', date: '2026-09-02', description: 'Test insurer', amount: 20, kind: 'refund' });
    addTx(db, { account: 'card:other', date: '2026-09-02', description: 'Test insurer', amount: -200, kind: 'expense' });
    const result = (await app.inject('/api/insurance')).json();
    expect(result.policies.find((p: { id: number }) => p.id === id)).toMatchObject({ monthlyPremium: 100, renewalSoon: true, payments: { last12: 80, count: 2 } });
    expect(result.totals).toMatchObject({ count: 2, monthly: 100, paidLast12: 80, renewalsSoon: 1 });
    expect(result.unlinked).toEqual([expect.objectContaining({ accountId: 'card:other', total: 200 })]);
  });
  it('uploads, sanitizes, downloads, changes kind and deletes a synthetic PDF', async () => {
    const id = await policy(); const body = Buffer.from('%PDF-1.4\n% synthetic test fixture\n%%EOF');
    const upload = await app.inject({ method: 'POST', url: `/api/insurance/${id}/documents?name=${encodeURIComponent('../../Invented report.pdf')}&kind=appendix`, headers: { 'content-type': 'application/pdf' }, payload: body });
    expect(upload.statusCode).toBe(200); const doc = upload.json();
    expect(doc.kind).toBe('appendix'); expect(doc.fileName).not.toContain('/');
    expect(readFileSync(join(dir, 'policies', String(id), doc.fileName))).toEqual(body);
    const download = await app.inject(`/api/insurance/documents/${doc.id}/file`); expect(download.statusCode).toBe(200); expect(download.rawPayload).toEqual(body); expect(download.headers['content-type']).toBe('application/pdf');
    expect((await app.inject({ method: 'PATCH', url: `/api/insurance/documents/${doc.id}`, payload: { kind: 'claim' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: `/api/insurance/documents/${doc.id}`, payload: { kind: 'invalid' } })).statusCode).toBe(400);
    await app.inject({ method: 'DELETE', url: `/api/insurance/documents/${doc.id}` });
    expect((await app.inject(`/api/insurance/documents/${doc.id}/file`)).statusCode).toBe(404);
    expect(db.prepare('SELECT COUNT(*) FROM insurance_documents').pluck().get()).toBe(0);
  });
  it('rejects unsupported and empty uploads and missing policies', async () => {
    const id = await policy();
    expect((await app.inject({ method: 'POST', url: `/api/insurance/${id}/documents`, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('test') })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: `/api/insurance/${id}/documents`, headers: { 'content-type': 'application/pdf' }, payload: Buffer.alloc(0) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/insurance/999/documents', headers: { 'content-type': 'application/pdf' }, payload: Buffer.from('test') })).statusCode).toBe(404);
  });
  it('CRUD validates required name, missing records and empty updates; delete cascades documents', async () => {
    expect((await post('/api/insurance', {})).statusCode).toBe(400);
    const id = await policy();
    expect((await app.inject({ method: 'PATCH', url: `/api/insurance/${id}`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/insurance/999', payload: { name: 'Missing' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PATCH', url: `/api/insurance/${id}`, payload: { premium: 0 } })).json().premium).toBe(0);
    await app.inject({ method: 'POST', url: `/api/insurance/${id}/documents`, headers: { 'content-type': 'application/pdf' }, payload: Buffer.from('synthetic') });
    await app.inject({ method: 'DELETE', url: `/api/insurance/${id}` });
    expect(db.prepare('SELECT COUNT(*) FROM insurance_documents').pluck().get()).toBe(0);
  });
});

describe('insurance import with real throwaway files', () => {
  it('re-imports idempotently with a document, member and asset snapshot', () => {
    db.prepare("UPDATE members SET name='Invented member' WHERE id=1").run();
    const assetId = Number(db.prepare("INSERT INTO assets (name, type, provider, policy_number) VALUES ('Invented', 'deposit', 'Provider', 'TEST-A')").run().lastInsertRowid);
    writeFileSync(join(dir, 'synthetic.pdf'), 'synthetic test bytes');
    const spec = { policies: [{ insured: 'Invented member', set: { name: 'Invented cover', insurer: 'Provider', policyNumber: 'TEST-P', premium: 10 }, documents: [{ file: 'synthetic.pdf' }] }], assetSnapshots: [{ provider: 'Provider', policyNumber: 'TEST-A', date: '2026-09-01', value: 500 }] };
    expect(importInsurance(db, spec, dir)).toEqual({ created: 1, updated: 0, documents: 1, snapshots: 1 });
    expect(importInsurance(db, spec, dir)).toEqual({ created: 0, updated: 1, documents: 0, snapshots: 0 });
    expect(db.prepare('SELECT insured_member_id FROM insurance_policies').pluck().get()).toBe(1);
    expect(db.prepare('SELECT value FROM asset_snapshots WHERE asset_id=?').pluck().get(assetId)).toBe(500);
  });
  it('rolls back earlier policies when a later entry fails member validation', () => {
    expect(() => importInsurance(db, { policies: [{ set: { name: 'First', insurer: 'P', policyNumber: 'A' } }, { insured: 'Missing', set: { name: 'Second' } }] }, dir)).toThrow('member not found');
    expect(db.prepare('SELECT COUNT(*) FROM insurance_policies').pluck().get()).toBe(0);
  });
  it('rejects ambiguous policy identities and unsupported documents without writes', () => {
    for (const name of ['A', 'B']) db.prepare('INSERT INTO insurance_policies (name, insurer, policy_number) VALUES (?, ?, ?)').run(name, 'P', 'TEST');
    expect(() => importInsurance(db, { policies: [{ set: { insurer: 'P', policyNumber: 'TEST', premium: 999 } }] }, dir)).toThrow('several policies match');
    expect(() => importInsurance(db, { policies: [{ set: { name: 'New', insurer: 'P', policyNumber: 'NEW' }, documents: [{ file: 'bad.exe' }] }] }, dir)).toThrow('unsupported document type');
    expect(db.prepare('SELECT COUNT(*) FROM insurance_policies').pluck().get()).toBe(2);
  });
});
