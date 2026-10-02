# Testing

Tests use invented household data only. Never point them at a real bank database, credentials file,
insurance document directory or scraped account. No real bank or Claude login is needed.

## Commands

```sh
npm ci
npm test                    # unit + in-process integration + subprocess safety tests
npm run test:integration    # integration files only
npm run test:coverage       # V8 coverage, with regression thresholds
npm run typecheck
npm run typecheck:tests     # tests and configuration are typechecked too
npm --prefix web run typecheck
npx playwright install chromium
npm run test:e2e            # real Chromium + Vite proxy + API + temporary SQLite
```

On a minimal Linux host, `npx playwright install --with-deps chromium` installs the browser's system
libraries too (requires privileges for the system packages). E2E uses ports 14310 and 15180. They must
be free. It does not reuse an existing server. The harness deletes its temporary database and
policy/report directories on shutdown. Reports go into ignored `test-results/` and `playwright-report/`.

`npm run check` runs the unit/integration suite, coverage gates and all typechecks. Browser E2E
is a separate required pre-merge step after installing Chromium.

## Layers and boundaries

- Pure accounting and date logic: household/business shares, incoming money, card installments,
  recurrence, payback windows, forecasts, savings capacity, planned expenses, FX and valuation.
- SQLite integration: migrations, imports, idempotent reprocessing, manual-edit preservation,
  rollback and foreign-key integrity. New fixtures close their database in `afterEach` or `finally`.
- HTTP integration: analytics endpoint enumeration is an empty-household smoke test, not proof
  of each calculation (the accounting tests assert numeric outcomes). Other tests use real Fastify route handlers and SQLite via `inject`, including category merge,
  budget replacement, event tagging, manual/planned transaction lifecycle, insurance uploads and
  downloads, pension reports and manual holdings. No actual network is needed.
- External adapters: deterministic mock responses for BOI, Yahoo and categorization. The scraper
  adapter is mocked, not the ingest repository. OTP/job tests control completion and failures.
- Data chat: real subprocess tests for MCP SELECT-only SQL, API allowlisting and file-read guard
  symlink containment. SSE tests control the CLI process and filesystem writes without invoking a paid model; they
  do not prove real document copying.
- Browser E2E: Hebrew UI manual-expense create/edit/delete, persistence after reload, settings through
  Vite's actual proxy and smoke tests of seven empty-household screens. Third-party browser requests
  are blocked. E2E is deliberately serial because the flows share one disposable database.

## Coverage scope

`vitest.config.ts` includes every `src/**/*.ts` file, including unloaded files, and the web transport
and formatting helpers. Only the synthetic demo generator is excluded. React pages/components and
`guard-read.mjs` are not part of the V8 percentage; browser flows and subprocess tests exercise them
separately. Subprocess coverage is not merged, so MCP and server entry points still show zero in
this report even though they are exercised through their real process boundaries.

Original baseline measured with Node 22 and Vitest 4.1.11. Current measured percentages
are generated in `coverage/coverage-summary.json`; the table lists the enforced gates so it cannot drift:

| Metric | Original 48 tests | Expanded suite |
| --- | ---: | ---: |
| Statements | 41.16% | >=85% gate |
| Lines | 42.53% | >=85% gate |
| Functions | 42.57% | >=85% gate |
| Branches | 36.31% | >=75% gate |

Coverage gates are 85% statements, lines and functions, and 75% branches. The target is not a claim
of 85% branch coverage or whole-React-app coverage. HTML, LCOV and JSON summary output is generated
under `coverage/` for inspection. The real-bank browser login, live OTP behavior and external service
availability remain unverified; mocked adapter tests do not prove those services work live.

## Fixed defects

`tests/regressions.test.ts` holds regression tests for four defects that were found while adding coverage and
then fixed:

1. Pension re-import duplicated a deposit whose `salary_month` is NULL (SQLite treats NULLs as distinct in a
   `UNIQUE` constraint). Migration 15 archives superseded rows in `asset_deposits_dedup_backup_v15`, logs the count,
   removes duplicates (newest row kept) and adds a unique index on
   `COALESCE(salary_month, '')`; the import upserts against it.
2. Net worth history picked the highest snapshot `id` instead of the latest snapshot date, for assets and
   liabilities.
3. Manual and planned transaction dates accepted impossible dates such as 2026-02-31 (they rolled into March).
   They now return 400, including dates outside 1900-2200.
4. Postponing a planned expense dated Jan 31 by a month skipped February. The day now clamps to the end of the
   target month. Offsets must be whole numbers between -120 and 120; invalid input or an out-of-range
   result returns 400 without writes, and a missing planned item returns 404.
