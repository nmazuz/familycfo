# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run scrape     # Scrape all banks once, then run the pipeline (SCRAPE_ONLY=isracard,max to limit; SCRAPE_FROM=2026-01-01 to backfill; SHOW_BROWSER=0 headless; SCHEDULE="0 7 * * *" to keep running on cron)
npm run dev        # Household app: API (127.0.0.1:4310) + web UI (http://127.0.0.1:5180)
npm run pipeline   # Re-run classification / recurring / suggestions / alerts without scraping
npm run migrate    # Apply DB migrations (also runs automatically on open)
npm test           # Vitest unit tests (in-memory SQLite)
npm run typecheck  # API typecheck; web: npm --prefix web run typecheck
npm run demo       # Build demo.db with made-up data; npm run dev:demo runs the app on it
```

## Architecture

Israeli bank scraper + local household-finance app for a family (members are configurable in Settings). Everything runs locally; the API binds to 127.0.0.1 only and has no login.

- `src/scraper.ts` — `israeli-bank-scrapers` (npm release). Fetches 3 months back + 2 future months (upcoming card charges/installments), raw data, and scraper categories. Hapoalim OTP is prompted in the terminal.
- `src/db/` — `connection.ts` (opens + migrates), `migrations.ts` (numbered, `schema_version`), `ingestRepo.ts` (saves scraped accounts; never overwrites user-edited fields).
- `src/ingest/` — `normalize.ts` (identity: bank reference + installment number, else legacy md5 + an occurrence suffix so identical same-day purchases are kept), `classify.ts` (rules → description cache → scraper category → external API; derives `kind`), `transfers.ts` (card-bill reconciliation, own-account transfer pairing).
- `src/analytics/` — pure functions over `loadTransactions()` in `common.ts`: cash flow, budgets, recurring detection, scheduled-item suggestions, day-by-day forecast per bank account, card charges & installments, paybacks (Bit/refund links), savings capacity & tight-month plan, net worth (FX via Bank of Israel), alerts, recommendations.
- `src/pipeline.ts` — runs after every scrape: FX → categorize → kinds → card bills → transfers → recurring → scheduled suggestions → paybacks → alerts.
- `src/server/` — Fastify API (`crud.ts` generic routes + `routes/transactions.ts`, `routes/analytics.ts`).
- `src/server/requestGuard.ts` — `onRequest` hook registered before every route: 403 for a non-loopback `Host` (DNS rebinding) or a write with a non-loopback `Origin`, 415 for form content types. Keep it first; new routes inherit it. `src/permissions.ts` — sensitive files/folders are created owner-only (`0600`/`0700`; use `mkdirPrivate` for new data dirs) and `warnBroadPermissions` warns at start. The scraper's Chrome keeps its sandbox unless `CHROME_NO_SANDBOX=1` (`chromeArgs()` in `scraper.ts`).
- `src/server/agent.ts` + `src/agent/mcp.ts` — the data chat (✨ in the header): each message runs the user's own `claude -p` (subscription, `ANTHROPIC_API_KEY` removed) with all built-in tools disabled and only the read-only `household` MCP server (`api`: whitelisted GET endpoints, `sql`: SELECT on a read-only connection). Streams to the UI as SSE; `--resume` continues a conversation. Its instructions (`agent/CLAUDE.md`) and skills (`agent/.claude/skills/`) are copied to a temp work dir per message (outside the repo, so this file isn't loaded); `--tools Skill --setting-sources project`.
- Insurance (`src/server/routes/insurance.ts`, page `/insurance`): policies + documents; files in `data/policies/<policy id>/` (git-ignored, `POLICIES_DIR` overrides). Actual cost = charges matching the policy's `match_pattern` (and `payment_account_id`, when set) in the last 12 months. Bulk import from a JSON spec (fields + documents + asset values): `npm run import:insurance -- data/reports/<file>.json` (idempotent). The chat reads documents with `Read`, limited to a `docs/` copy of `data/policies` + `data/reports` by a PreToolUse hook (`src/agent/guard-read.mjs`, symlinks resolved).
- Pension & long-term savings (`/pension`, `src/server/routes/pension.ts`): pension / study / provident funds are `assets` (types `pension`, `keren_hishtalmut`, `kupat_gemel`) with report fields (status, employer, fees, `details` JSON: tracks + returns, components, coverages), `asset_deposits` and `pension_reports` (the report's own totals). Imported from a report extracted to JSON: `npm run import:pension -- data/reports/<file>.json` (idempotent; the PDF and JSON stay in git-ignored `data/reports/`). A study fund is liquid 6 years from joining; a provident fund without a liquidity date isn't liquid.
- Stock-market investments (`/investments`, `src/server/routes/investments.ts`): `holdings` (symbol, quantity, optional buy price / date; no buy price → `baseline_price` = the price when added, the yield runs from it; `manual_price` for something with no quote). Live prices from Yahoo Finance (`src/analytics/quotes.ts`, only symbols are sent; TASE quotes in agorot → stored in ₪) cached in `quotes` (refreshed when older than a minute on page load, 5 min for `/networth`, and in the pipeline), daily closes in `quote_history` (from each holding's start; Yahoo FX rates fill days BOI hasn't published, never replace them). Valuation in `src/analytics/investments.ts`; net worth adds one `brokerage` item per broker + owner, and the closes to its month-end history.
- `src/server/scrapeJob.ts` — scrape started from the overview button (one at a time, in memory); the Hapoalim OTP is answered via `POST /api/scrape/otp`.
- `web/` — Vite + React + Tailwind, Hebrew RTL. Global filter (member / business / tags) in `state.tsx`. Its TS config is `web/tsconfig.app.json`.

**Key rules:**
- Transaction `kind` decides what counts: `transfer`, `card_payment` and `savings` are never income/spend. A bank row like `ויזה`/`כאל` is a `card_payment` only when a scraped card's charges explain it; otherwise it is a debit purchase (expense).
- Installments count on their charge date (`processed_date`); other spend on the purchase date. Business share (`business_share_pct`) is excluded from household totals.
- `category_source`/`kind_source = 'manual'` means the user set it — rules and re-scrapes must not change it.
- Member of a row = `transactions.member_id` ?? account owner ?? shared.
- Manually entered rows (cash, paid by someone else) live on the `manual:entries` account (`kind = 'manual'`): they count as income/spend everywhere but are never a bank balance, so the forecast ignores them. Only these rows can be edited in full or deleted (`/api/transactions/manual`, `PUT /:id/manual`, `DELETE /:id`).
- Planned expenses (`planned_items`, `src/analytics/planned.ts`): one-offs entered before the card/bank charges them. While `status = 'planned'` they count in the forecast (card: added to the statement they land in; bank: an event), the budget and the month plan — never as actual spend. `matchPlanned` (pipeline + after edits) links them to the real row when exactly one candidate fits (same account, amount ±10%, purchase date −7..+30 days); several candidates → the user picks. "לא זה" stores the row in `rejected_txn_ids`.
- "Income of a month" is always `monthIncome()` (arrived + recurring still expected). `expectedIncome()` is only the typical-month average for savings capacity.
- Hebrew regexes can't use `\b` (JS word boundaries are ASCII-only) — use explicit lookaheads.

**Configuration:**
- Bank logins: copy `accounts.example.json` to `accounts.json` (git-ignored; `ACCOUNTS_FILE` overrides the path) — `accounts[]` with `companyId` (an israeli-bank-scrapers company id) and `credentials`; optional `categoryApiUrl` (POST `{description}` → `{category}`).
- Ports: `PORT` (API, 4310) and `WEB_PORT` (web, 5180).

**Database:**
- SQLite file: `bank.db` (auto-created and migrated on open; `BANK_DB` env overrides the path — use a copy for experiments). A new database gets default members and a default category tree (migration 14, with the card companies' category names as aliases).
- `npm run demo` builds `demo.db` with an invented household (`src/demo.ts`); `npm run dev:demo` runs the app on it.
