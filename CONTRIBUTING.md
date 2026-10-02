# Contributing

Thanks for helping! Bug reports, bank-specific fixes, new analytics and UI improvements are all welcome.

## Before you start

- **Never include real financial data** in an issue, a PR, a test or a screenshot — no account numbers, names,
  balances, transaction descriptions or documents. Use the demo household (`npm run demo`) for screenshots and
  reproduce bugs with made-up rows in a test.
- For a larger change, open an issue first to agree on the approach.

## Setup

```bash
npm install
npm run demo && npm run dev:demo   # work against the demo household
```

Experiment on a copy of a real database, never on the original: `BANK_DB=copy.db npm run dev`.

## Checks

```bash
npm test
npm run typecheck
npm --prefix web run typecheck
```

Add or update tests in `tests/` for logic changes (they use an in-memory SQLite, see `tests/helpers.ts`).

## Conventions

- Read [CLAUDE.md](CLAUDE.md) — the architecture and the accounting rules (what counts as spend, card bills,
  transfers, installments, manual edits) that every change must keep.
- Schema changes: a new numbered migration at the end of `src/db/migrations.ts`. Never edit a released migration.
  Anything the user edited by hand (`*_source = 'manual'`) must survive re-scrapes and re-runs.
- Analytics are pure functions in `src/analytics/`; the API in `src/server/` stays thin.
- The UI is Hebrew and RTL. Reuse the components in `web/src/components/ui.tsx` and the tokens in `web/src/index.css`.
- Keep the app local-only: the API binds to 127.0.0.1, and nothing personal may be sent anywhere new without it
  being opt-in and documented in the README's privacy section.

Test layers, coverage gates, browser setup and known regression cases are documented in [docs/testing.md](docs/testing.md).
