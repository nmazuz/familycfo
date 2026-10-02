import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '../src/db/connection.js';
import type { ScrapeHooks, ScrapeSummary } from '../src/scraper.js';
import { testDb } from './helpers.js';
const mocks = vi.hoisted(() => ({ scrapeAll: vi.fn(), runPipeline: vi.fn(), loadConfig: vi.fn() }));
vi.mock('../src/scraper.js', () => ({ scrapeAll: mocks.scrapeAll }));
vi.mock('../src/pipeline.js', () => ({ runPipeline: mocks.runPipeline }));
vi.mock('../src/config.js', () => ({ loadConfig: mocks.loadConfig }));
let db: DB; let job: typeof import('../src/server/scrapeJob.js');
beforeEach(async () => { vi.resetModules(); vi.clearAllMocks(); db = testDb(); mocks.loadConfig.mockReturnValue({ accounts: [{ companyId: 'leumi', credentials: {} }] }); mocks.runPipeline.mockResolvedValue({}); job = await import('../src/server/scrapeJob.js'); });
afterEach(() => { db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function settled() { await vi.waitFor(() => expect(job.scrapeRunning()).toBe(false)); }

describe('scrape job lifecycle and OTP', () => {
  it('prevents concurrent scrapes and transitions running -> pipeline -> done', async () => {
    let finish!: (results: ScrapeSummary[]) => void;
    mocks.scrapeAll.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    expect(job.startScrape(db).status).toBe('running'); expect(job.scrapeRunning()).toBe(true);
    expect(() => job.startScrape(db)).toThrow('already running');
    finish([{ company: 'leumi', success: true, newTransactionIds: [1, 2] }]); await settled();
    expect(job.scrapeState()).toMatchObject({ status: 'done', newTransactions: 2, otp: null }); expect(job.scrapeState().finishedAt).not.toBeNull();
    expect(mocks.runPipeline).toHaveBeenCalledWith(db, { txIds: [1, 2], categoryApiUrl: undefined });
  });
  it('answers OTP only with 4-8 digits and clears the pending request', async () => {
    let code: string | undefined;
    mocks.scrapeAll.mockImplementation(async (_config, _db, hooks: ScrapeHooks) => {
      hooks.onProgress?.({ type: 'start', company: 'leumi' }); code = await hooks.requestOtp!('leumi');
      hooks.onProgress?.({ type: 'done', company: 'leumi', success: true, newTransactions: 0 });
      return [{ company: 'leumi', success: true, newTransactionIds: [] }];
    });
    job.startScrape(db); expect(job.scrapeState().otp?.company).toBe('leumi');
    for (const invalid of ['', '123', '123456789', 'abcd']) expect(() => job.submitOtp(invalid)).toThrow('4–8 digits');
    expect(job.scrapeState().otp).not.toBeNull(); job.submitOtp('123456'); await settled();
    expect(code).toBe('123456'); expect(job.scrapeState().otp).toBeNull(); expect(() => job.submitOtp('1234')).toThrow('no bank');
  });
  it('a bank completing while waiting for OTP resolves its prompt with an empty code', async () => {
    let code!: Promise<string>;
    mocks.scrapeAll.mockImplementation(async (_config, _db, hooks: ScrapeHooks) => {
      code = hooks.requestOtp!('leumi'); hooks.onProgress?.({ type: 'done', company: 'leumi', success: false, newTransactions: 0, errorType: 'TIMEOUT' }); return [];
    });
    job.startScrape(db); await settled(); expect(await code).toBe(''); expect(job.scrapeState()).toMatchObject({ status: 'failed', otp: null, error: 'no bank was scraped' });
  });
  it('missing config gives a safe 400 and leaves the idle job unchanged', () => {
    mocks.loadConfig.mockImplementation(() => { throw new Error('secret-shaped detail must not escape'); });
    try { job.startScrape(db); throw new Error('should reject'); } catch (e) { expect(e).toMatchObject({ statusCode: 400 }); expect((e as Error).message).not.toContain('secret-shaped'); }
    expect(job.scrapeState().status).toBe('idle'); expect(mocks.scrapeAll).not.toHaveBeenCalled();
  });
  it('pipeline exceptions terminate the job and set finishedAt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); mocks.scrapeAll.mockResolvedValue([{ company: 'leumi', success: true, newTransactionIds: [] }]); mocks.runPipeline.mockRejectedValue(new Error('pipeline failure'));
    job.startScrape(db); await settled(); expect(job.scrapeState()).toMatchObject({ status: 'failed', error: 'pipeline failure', otp: null }); expect(job.scrapeState().finishedAt).not.toBeNull();
  });
});
