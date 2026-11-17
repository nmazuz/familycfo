# FamilyCFO

[![Latest release](https://img.shields.io/github/v/release/nmazuz/familycfo?label=release)](https://github.com/nmazuz/familycfo/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/nmazuz/familycfo/total?label=downloads)](https://github.com/nmazuz/familycfo/releases)
[![Stars](https://img.shields.io/github/stars/nmazuz/familycfo?style=flat)](https://github.com/nmazuz/familycfo/stargazers)
[![License: MIT](https://img.shields.io/github/license/nmazuz/familycfo)](LICENSE)
[![desktop](https://github.com/nmazuz/familycfo/actions/workflows/desktop.yml/badge.svg)](https://github.com/nmazuz/familycfo/actions/workflows/desktop.yml)

**The CFO of your family — local-first, Hebrew, open source.** Every shekel, policy, pension and stock in one place;
it sees what's coming, warns before there's a problem, and answers your questions about it.

A local-first household finance app. It scrapes your Israeli bank accounts and credit cards
(via [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers)), keeps everything in a SQLite file
on your own computer, and gives you a Hebrew (RTL) web app on top of it: where the money goes, what's still going to
be charged this month, whether the bank account will dip below zero, what you're worth — plus insurance, pension and
a live stock portfolio, and an optional AI chat that answers questions about your own data.

> **בעברית:** FamilyCFO — סמנכ״ל הכספים של המשפחה. אפליקציה מקומית לניהול הכספים של הבית. סורקת את חשבונות הבנק וכרטיסי האשראי, שומרת הכול אצלכם במחשב
> (SQLite), ומציגה תזרים, תקציב, תחזית יתרה, הוצאות קבועות ומנויים, שווי נקי, ביטוחים, פנסיה ותיק מניות בזמן אמת —
> ועוזר AI (אופציונלי) שעונה על שאלות על הנתונים שלכם. אין שרת בענן ואין התחברות: הכול רץ על `127.0.0.1`.

---

## Contents

- [What it does](#what-it-does)
- [Privacy and security](#privacy-and-security)
- [Quick start — try the demo](#quick-start--try-the-demo)
- [Setup with your own banks](#setup-with-your-own-banks)
- [Everyday use](#everyday-use)
- [The AI data chat (optional)](#the-ai-data-chat-optional)
- [Importing pension and insurance reports](#importing-pension-and-insurance-reports)
- [Configuration reference](#configuration-reference)
- [Project structure](#project-structure)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## What it does

| Page | What you get |
|---|---|
| **סקירה** (Overview) | Bank balances now, the expected balance at the end of the month and its lowest point, this month's spend vs. your average, card charges still to come, budget status, alerts. A **scrape button** that runs the bank scrape from the browser — including entering an SMS / OTP code when the bank asks. |
| **תנועות** (Transactions) | Every bank and card row, searchable and filterable. Edit category, member, tags, business share; "apply to similar" turns an edit into a rule. Add manual rows (cash, something paid by someone else). |
| **קבועות החודש** (Fixed this month) | Salaries, standing orders, loans, subscriptions and card estimates for the month — which already arrived and which are still expected. |
| **תקציב** (Budget) | Monthly budgets per category with progress, plus planned one-off expenses before they're charged. |
| **מגמות הוצאות** (Spending trends) | Per-category spend over months, drill-down into merchants. |
| **תזרים ותחזית** (Cash flow & forecast) | Income vs. fixed vs. variable spend per month; a day-by-day balance forecast per bank account that knows your card statement dates, installments and recurring payments. |
| **תובנות והתראות** (Insights) | Detected subscriptions and price changes, unusual charges, savings capacity, a plan for a tight month. |
| **אירועים ותגיות** (Events & tags) | Tag a trip, a wedding or a renovation and see what it really cost. |
| **עסקים** (Businesses) | Mark expenses as (partly) business — they're excluded from household totals and reported per business. |
| **חסכונות והון** (Savings & net worth) | Bank savings, deposits, pension, study funds, brokerage, real estate, minus loans and open card charges = net worth, over time. Sinking funds with goals. |
| **השקעות** (Investments) | Stock-market holdings at **live prices** (Yahoo Finance — US, TASE, London, crypto…). Value in ₪, gain vs. the buy price (including the exchange-rate effect), today's change, allocation and value history. Holdings without a buy price start from today's price. Counts in net worth. |
| **פנסיה וגמל** (Pension) | Pension funds, managers' insurance, study funds (קרנות השתלמות) and provident funds (קופות גמל): balance, fees, tracks and returns, deposits per month, expected pension, which study funds are already liquid. |
| **הלוואות ומשכנתא** (Loans) | Loans and mortgage tracks, balances and repayments matched from the bank rows. |
| **ביטוחים** (Insurance) | Every policy with premium, coverage, renewal date and documents (PDF / images). What each policy *actually* cost in the last 12 months (matched from card / bank charges), and insurance charges with no policy yet. |
| **✨ data chat** | Ask in Hebrew: "כמה הוצאנו על סופר החודש?", "מה מכסה ביטוח הבריאות שלי?", "תן לי סקירה של התיק". Answers come from your own database and documents — see [below](#the-ai-data-chat-optional). |

It understands how Israeli money actually moves:

- **Card bills aren't spend twice.** The "ויזה / ישראכרט / מקס" row on the bank is reconciled against the card's own
  purchases; only the purchases count. A card debit with no scraped card behind it stays an expense.
- **Transfers between your own accounts** are paired and ignored in income / spend.
- **Installments (תשלומים)** count on the month they're charged, and future installments feed the forecast.
- **Monthly cycle** can start on any day (e.g. the 10th, when the salary lands).
- **Bit / PayBox paybacks** can be linked to the expense they repay, so splitting a dinner doesn't inflate spend.
- **Household members**: every account and row belongs to a member or to the shared household; filter the whole app by member.

## Privacy and security

- **Everything stays on your machine.** The API binds to `127.0.0.1` only and has **no login** — anyone who can reach
  the port sees everything, so never expose it to a network or the internet.
- Your bank logins live in `accounts.json` (git-ignored). The database `bank.db`, its backups and imported documents
  (`data/`) are git-ignored too. **Never commit them.** Prefer full-disk encryption on the computer that runs this.
- Outgoing network calls, and what they send:
  - your banks / card companies (the scraper logs in as you, in a local Chrome);
  - Bank of Israel exchange rates (nothing personal);
  - Yahoo Finance quotes — **only ticker symbols**, never quantities or values;
  - the data chat, if you use it: your questions and the data it reads go to Anthropic through your own Claude Code login;
  - an optional categorization endpoint you configure (`categoryApiUrl`) receives transaction descriptions.
- The data chat can only read: a read-only SQL connection, whitelisted GET endpoints of the local API, and the files in
  `data/` (enforced by a hook that blocks reading anything else).

## Quick start — try the demo

Requirements: **Node.js 20+** and npm. macOS or Linux (Windows works via WSL).

```bash
git clone https://github.com/nmazuz/familycfo.git && cd familycfo
npm install            # also installs the web app's packages
npm run demo           # builds demo.db with a made-up household (no bank login needed)
npm run dev:demo       # API on 127.0.0.1:4310 + web app on http://127.0.0.1:5180
```

Open <http://127.0.0.1:5180>. The demo is a two-person household with five months of invented transactions, two bank
accounts, two cards, a mortgage, savings and a small stock portfolio. Delete `demo.db` whenever you like.

## Setup with your own banks

1. **Install** (if you haven't): `npm install`. The scraper drives a real Chrome — it uses Google Chrome / Chromium if
   installed, otherwise the one Puppeteer downloads.

2. **Add your logins.** Copy the example and fill it in:

   ```bash
   cp accounts.example.json accounts.json
   ```

   `accounts.json` lists one entry per bank or card company. `companyId` is a company id of `israeli-bank-scrapers`;
   `credentials` are the fields that company's login needs:

   | Company | `companyId` | `credentials` |
   |---|---|---|
   | בנק הפועלים | `hapoalim` | `userCode`, `password` |
   | בנק לאומי | `leumi` | `username`, `password` |
   | דיסקונט / מרכנתיל | `discount` / `mercantile` | `id`, `password`, `num` |
   | מזרחי טפחות | `mizrahi` | `username`, `password` |
   | הבינלאומי / מסד / אוצר החייל / איגוד | `beinleumi` / `massad` / `otsarHahayal` / `union` | `username`, `password` |
   | יהב | `yahav` | `username`, `nationalID`, `password` |
   | ישראכרט / אמריקן אקספרס | `isracard` / `amex` | `id`, `card6Digits`, `password` |
   | מקס | `max` | `username`, `password` |
   | כאל | `visaCal` | `username`, `password` |

   The full and current list (and any extra fields) is in the
   [israeli-bank-scrapers docs](https://github.com/eshaham/israeli-bank-scrapers#specific-definitions-per-scraper).
   Bank accounts and cards are told apart automatically.

3. **First scrape** (fetches the last 3 months, plus upcoming card charges):

   ```bash
   npm run scrape
   ```

   A Chrome window opens for each company (`SHOW_BROWSER=0` for headless). If Bank Hapoalim asks for an SMS code,
   type it in the terminal. To fetch more history: `SCRAPE_FROM=2025-01-01 npm run scrape`.

4. **Start the app:**

   ```bash
   npm run dev
   ```

   Open <http://127.0.0.1:5180>, then go to **הגדרות** (Settings):
   - **בני הבית** — rename the members (they start as "בן/בת זוג 1 / 2" and "משותף") and pick colors; add more if needed.
   - **חשבונות וכרטיסים** — give each account a name, assign it to a member, and set which bank account pays each card.
   - **כללי** — the day your monthly cycle starts and the minimum balance you want to keep.

5. **Categories.** A new database starts with a default Hebrew category tree, and the card companies' own category
   names (e.g. "מזון וצריכה") are mapped to it, so most card rows are categorized right away. Fix the rest on the
   transactions page; "החל על תנועות דומות" saves a rule for next time.

## Everyday use

- **Scrape from the browser:** the refresh button at the top of the overview runs the same scrape, shows progress
  per company and asks for the OTP code in the page when the bank wants one.
- **Or on a schedule:** `SCHEDULE="0 7 * * *" npm run scrape` keeps running and scrapes every morning at 7.
- Re-scraping is safe: rows are de-duplicated, and anything you edited by hand (category, kind, member) is never overwritten.
- `npm run pipeline` re-runs classification, recurring-payment detection, suggestions and alerts without scraping.

## The AI data chat (optional)

The ✨ button next to the notifications bell opens a chat (text or push-to-talk, Hebrew) that answers questions from
your data. It runs your own [Claude Code](https://claude.com/claude-code) CLI on your machine, using your Claude
subscription — no API key is stored in the app (`ANTHROPIC_API_KEY` is removed from its environment on purpose).

1. Install Claude Code and log in once: `npm install -g @anthropic-ai/claude-code`, then run `claude` and sign in.
2. Make sure `claude` is on the `PATH` of the shell that runs `npm run dev`.

Each question starts `claude -p` in a temporary folder with:

- **no built-in tools** except reading documents, limited by a hook to a copy of `data/`;
- a read-only MCP server (`src/agent/mcp.ts`) with two tools: `api` (whitelisted GET endpoints — the same numbers the
  screens show) and `sql` (`SELECT` only, on a read-only connection);
- its instructions in [`agent/CLAUDE.md`](agent/CLAUDE.md) and skills in [`agent/.claude/skills/`](agent/.claude/skills)
  (monthly review, subscriptions audit, category deep-dive, trip cost, insurance questions, pension and portfolio
  reviews). Edit them to change how it answers.

The chat never changes data; it tells you where in the app to do it. It gives facts, not investment advice.

## Importing pension and insurance reports

Pension / study / provident fund reports and insurance summaries (e.g. from your agent, the pension clearing house
or הר הביטוח) come as PDFs. Extract them to JSON (by hand, or ask an AI assistant to), keep the files in the
git-ignored `data/reports/` folder, and import:

```bash
npm run import:pension   -- data/reports/2026-08-pension-report.json
npm run import:insurance -- data/reports/insurance.json
```

Both are idempotent — re-running updates, never duplicates. Policy documents can also be uploaded in the app
(drag a PDF onto a policy). The formats are described in [docs/importing.md](docs/importing.md).

## Configuration reference

| Setting | Where | Default | What |
|---|---|---|---|
| Bank logins | `accounts.json` | — | `{ "accounts": [{ "companyId", "credentials" }], "categoryApiUrl"? }` |
| `categoryApiUrl` | `accounts.json` | none | Optional endpoint for categorizing rows no rule / cache / card category explains: receives `POST {"description"}`, answers `{"category": "<category name>"}`. |
| `ACCOUNTS_FILE` | env | `accounts.json` | Path of the logins file. |
| `BANK_DB` | env | `bank.db` | Database file. Use a copy for experiments. |
| `PORT` / `WEB_PORT` | env | `4310` / `5180` | API and web app ports (both bind to 127.0.0.1). |
| `SCRAPE_ONLY` | env | all | `SCRAPE_ONLY=isracard,max` scrapes only these companies. |
| `SCRAPE_FROM` | env | 3 months back | Start date of the scrape (`YYYY-MM-DD`), for backfilling. |
| `SHOW_BROWSER` | env | shown | `SHOW_BROWSER=0` runs Chrome headless. |
| `SCHEDULE` | env | none | Cron expression; keeps `npm run scrape` running on a schedule. |
| `POLICIES_DIR` / `REPORTS_DIR` | env | `data/policies` / `data/reports` | Where insurance documents and imported reports are kept. |
| `CATEGORY_API_URL` | env | none | `categoryApiUrl` for `npm run pipeline`. |
| Cycle start day, minimum balance | Settings page | 1, ₪2,000 | |

## Project structure

```
src/
  scraper.ts            israeli-bank-scrapers runner (OTP, progress hooks)
  index.ts              `npm run scrape` entry (once or on a cron schedule)
  pipeline.ts           what runs after every scrape: FX → categorize → kinds → card bills → transfers → recurring → alerts
  db/                   SQLite connection, numbered migrations, saving scraped accounts
  ingest/               normalize & de-duplicate rows, classification rules, card-bill / transfer reconciliation
  analytics/            pure functions: cash flow, budgets, forecast, recurring, net worth, investments, alerts …
  server/               Fastify API (127.0.0.1) + the data chat runner
  agent/                read-only MCP server and the document-read guard for the chat
  import/               pension and insurance report importers
  demo.ts               the demo household
web/                    Vite + React + Tailwind, Hebrew RTL
agent/                  the data chat's instructions (CLAUDE.md) and skills
tests/                  Vitest, in-memory SQLite
```

Architecture notes and the key accounting rules are in [CLAUDE.md](CLAUDE.md) (also handy if you develop with an AI assistant).

## Development

```bash
npm test                      # unit tests (in-memory SQLite, no network)
npm run typecheck             # API
npm --prefix web run typecheck
npm run migrate               # apply migrations (also automatic whenever the database is opened)
```

- The API restarts on save (`tsx watch`) and **migrates the database automatically** — back up `bank.db` before
  changing the schema, and experiment on a copy (`BANK_DB=copy.db`).
- Schema changes go in a new numbered migration in `src/db/migrations.ts`; never edit an old one.
- UI building blocks are in `web/src/components/ui.tsx` and the design tokens in `web/src/index.css`.

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Troubleshooting

- **A login fails / times out:** run with the browser shown (the default) to see where it stops; banks change their
  sites, so update `israeli-bank-scrapers` (`npm update israeli-bank-scrapers`). Some banks block headless logins.
- **The OTP prompt never appears:** OTP entry is wired for Bank Hapoalim. Other banks that ask for a code may need
  `SHOW_BROWSER=1` and typing it in the Chrome window.
- **A card bill shows as an expense:** that card isn't scraped (or isn't linked). Add the card company to
  `accounts.json`, or set "משולם מ-" for the card in Settings.
- **The chat says it can't start:** check that `claude` runs in the same terminal and that you're logged in.
- **No stock prices:** Yahoo Finance needs internet; the last known price is kept and the page says which symbols failed.
  Tel Aviv symbols end in `.TA` (e.g. `LUMI.TA`); a fund with no quote can use a manual price.

## Disclaimer

This is a personal-finance tool, not financial, tax, insurance or investment advice. Numbers can be wrong: scrapers
miss rows, categories are guesses, prices can lag. Using scrapers with your own credentials may be subject to your
bank's terms of use — that's your call. No warranty; see the license.

## License

[MIT](LICENSE)
