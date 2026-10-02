import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const tableExists = (db: Database.Database, name: string) =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);

const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);

// Category name → kind / fixed flag for the categories the external API already produced
const INCOME_PREFIX = 'הכנסה';
const CATEGORY_KIND: Record<string, string> = {
  'ויזה': 'card_payment',
  'העברות כספים': 'transfer',
  'השקעות': 'savings',
  'כרטיס נטען': 'transfer',
};
const FIXED_CATEGORIES = [
  'ביטוחים', 'חשבונות ושירותים (חשמל, מים, גז, אינטרנט, סלולר)', 'סלולר',
  'מנויים ושירותים דיגיטליים', 'דיור ושכר דירה', 'החזרי הלוואות ואשראי',
  'חינוך ולימודים', 'חוגים', 'עמלות בנקאיות',
];

const CORE_SCHEMA = `
  CREATE TABLE members (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,                 -- company:accountNumber
    company TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('bank','card')),
    display_name TEXT,
    owner_member_id INTEGER REFERENCES members(id),
    billing_bank_account_id TEXT REFERENCES accounts(id),
    card_frame REAL,
    currency TEXT DEFAULT 'ILS',
    active INTEGER NOT NULL DEFAULT 1,
    last_scraped_at TEXT
  );

  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    parent_id INTEGER REFERENCES categories(id),
    kind TEXT NOT NULL DEFAULT 'expense'
      CHECK (kind IN ('expense','income','transfer','card_payment','savings')),
    default_fixed INTEGER NOT NULL DEFAULT 0,
    discretionary INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE businesses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT NOT NULL UNIQUE,     -- dedup identity, see ingest/normalize.ts
    account_id TEXT NOT NULL,
    date TEXT NOT NULL,                  -- purchase date (ISO)
    processed_date TEXT,                 -- charge/value date (ISO)
    description TEXT NOT NULL,
    memo TEXT,
    original_amount REAL NOT NULL,
    original_currency TEXT,
    charged_amount REAL NOT NULL,
    charged_currency TEXT DEFAULT 'ILS',
    status TEXT,                         -- completed | pending
    txn_type TEXT,                       -- normal | installments
    installment_number INTEGER,
    installment_total INTEGER,
    bank_identifier TEXT,
    source_category TEXT,                -- category supplied by the scraper
    category_id INTEGER REFERENCES categories(id),
    category_source TEXT,                -- api | cache | rule | manual | scraper
    kind TEXT,                           -- expense | income | refund | transfer | card_payment | savings
    kind_source TEXT,                    -- auto | rule | manual
    member_id INTEGER REFERENCES members(id),
    business_id INTEGER REFERENCES businesses(id),
    business_share_pct REAL NOT NULL DEFAULT 100,
    fixed_override INTEGER,              -- null = auto
    excluded INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    raw_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX idx_tx_account_date ON transactions(account_id, date);
  CREATE INDEX idx_tx_processed ON transactions(processed_date);
  CREATE INDEX idx_tx_description ON transactions(description);
  CREATE INDEX idx_tx_category ON transactions(category_id);

  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT
  );
  CREATE TABLE transaction_tags (
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (transaction_id, tag_id)
  );

  CREATE TABLE category_rules (
    id INTEGER PRIMARY KEY,
    match_type TEXT NOT NULL CHECK (match_type IN ('exact','contains')),
    pattern TEXT NOT NULL,
    account_id TEXT,
    min_amount REAL,
    max_amount REAL,
    set_category_id INTEGER REFERENCES categories(id),
    set_business_id INTEGER REFERENCES businesses(id),
    set_business_share_pct REAL,
    set_member_id INTEGER REFERENCES members(id),
    set_kind TEXT,
    set_tag_ids TEXT,                    -- JSON array of tag ids
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE budgets (
    id INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    member_id INTEGER REFERENCES members(id),   -- null = household
    monthly_amount REAL NOT NULL,
    effective_from TEXT NOT NULL,               -- YYYY-MM
    UNIQUE (category_id, member_id, effective_from)
  );

  CREATE TABLE sinking_funds (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    monthly_target REAL NOT NULL DEFAULT 0,
    balance REAL NOT NULL DEFAULT 0,
    goal_amount REAL,
    goal_date TEXT
  );

  CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('bank_savings','deposit','pension','keren_hishtalmut',
      'kupat_gemel','brokerage','crypto','real_estate','other')),
    provider TEXT,
    owner_member_id INTEGER REFERENCES members(id),
    currency TEXT NOT NULL DEFAULT 'ILS',
    liquidity_date TEXT,
    management_fee TEXT,
    monthly_deposit REAL,
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE asset_snapshots (
    id INTEGER PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    value REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'ILS'
  );

  CREATE TABLE liabilities (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('loan','mortgage','other')),
    lender TEXT,
    owner_member_id INTEGER REFERENCES members(id),
    original_principal REAL,
    interest_rate REAL,
    index_type TEXT,                     -- prime | cpi | fixed | other
    start_date TEXT,
    end_date TEXT,
    monthly_payment REAL,
    payment_day INTEGER,
    bank_account_id TEXT REFERENCES accounts(id),
    match_pattern TEXT,                  -- description pattern of the repayment rows
    notes TEXT,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE liability_snapshots (
    id INTEGER PRIMARY KEY,
    liability_id INTEGER NOT NULL REFERENCES liabilities(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    balance REAL NOT NULL
  );

  CREATE TABLE fx_rates (
    date TEXT NOT NULL,
    currency TEXT NOT NULL,
    rate_to_ils REAL NOT NULL,
    source TEXT NOT NULL DEFAULT 'boi',
    PRIMARY KEY (date, currency)
  );

  CREATE TABLE recurring_series (
    id INTEGER PRIMARY KEY,
    merchant_key TEXT NOT NULL,
    account_id TEXT NOT NULL,
    kind TEXT NOT NULL,                  -- subscription | bill | salary | income | loan
    cadence TEXT NOT NULL DEFAULT 'monthly',
    typical_amount REAL NOT NULL,
    last_amount REAL NOT NULL,
    typical_day INTEGER,
    last_date TEXT,
    next_expected_date TEXT,
    occurrences INTEGER NOT NULL,
    category_id INTEGER REFERENCES categories(id),
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE (merchant_key, account_id)
  );

  CREATE TABLE scheduled_items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('income','fixed_expense','loan','mortgage','card_charge')),
    amount REAL NOT NULL,                -- signed: + income, - outflow
    amount_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (amount_mode IN ('fixed','estimated')),
    day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
    bank_account_id TEXT REFERENCES accounts(id),
    member_id INTEGER REFERENCES members(id),
    category_id INTEGER REFERENCES categories(id),
    match_pattern TEXT,                  -- description pattern used to detect it already posted
    recurring_series_id INTEGER REFERENCES recurring_series(id) ON DELETE SET NULL,
    liability_id INTEGER REFERENCES liabilities(id) ON DELETE SET NULL,
    card_account_id TEXT REFERENCES accounts(id),
    start_date TEXT,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','confirmed','dismissed')),
    UNIQUE (kind, name, bank_account_id)
  );

  CREATE TABLE transaction_links (
    id INTEGER PRIMARY KEY,
    from_txn_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,  -- the inflow
    to_txn_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,    -- the expense
    type TEXT NOT NULL CHECK (type IN ('refund','payback','reimbursement')),
    amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','confirmed','rejected')),
    UNIQUE (from_txn_id, to_txn_id)
  );

  CREATE TABLE month_closes (
    id INTEGER PRIMARY KEY,
    cycle TEXT NOT NULL UNIQUE,          -- YYYY-MM (cycle start month)
    closed_at TEXT DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    snapshot_json TEXT NOT NULL,
    allocations_json TEXT
  );

  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
    dedupe_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    txn_ids TEXT,
    data_json TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    seen_at TEXT,
    dismissed_at TEXT
  );

  CREATE TABLE recommendation_states (
    key TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('dismissed','snoozed','done')),
    until TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE scrape_runs (
    id INTEGER PRIMARY KEY,
    company TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    success INTEGER,
    error_type TEXT,
    error_message TEXT,
    new_transactions INTEGER
  );
`;

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'household core schema (rebuild legacy transactions table)',
    up(db) {
      const hasLegacy = tableExists(db, 'transactions');
      if (hasLegacy) db.exec(`ALTER TABLE transactions RENAME TO transactions_legacy`);

      db.exec(CORE_SCHEMA);
      db.exec(`CREATE TABLE IF NOT EXISTS balances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        balance REAL NOT NULL,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP
      )`);

      const insertMember = db.prepare(`INSERT INTO members (id, name, color) VALUES (?, ?, ?)`);
      insertMember.run(1, 'בן/בת זוג 1', '#2563eb');
      insertMember.run(2, 'בן/בת זוג 2', '#db2777');
      insertMember.run(3, 'משותף', '#6b7280');

      const setSetting = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
      setSetting.run('cycle_start_day', '1');
      setSetting.run('balance_buffer', '2000');

      const insertFund = db.prepare(`INSERT INTO sinking_funds (name, monthly_target) VALUES (?, 0)`);
      for (const name of ['חיסכון', 'חופשות', 'הוצאות חריגות']) insertFund.run(name);

      if (!hasLegacy) return;

      // Categories from the text labels the external API produced
      const legacyCats = db.prepare(
        `SELECT DISTINCT category FROM transactions_legacy WHERE category IS NOT NULL AND category != ''`
      ).pluck().all() as string[];
      const insertCat = db.prepare(
        `INSERT INTO categories (name, kind, default_fixed, discretionary) VALUES (?, ?, ?, ?)`
      );
      for (const name of legacyCats) {
        const kind = name.startsWith(INCOME_PREFIX) ? 'income' : CATEGORY_KIND[name] ?? 'expense';
        const fixed = FIXED_CATEGORIES.includes(name) ? 1 : 0;
        insertCat.run(name, kind, fixed, fixed || kind !== 'expense' ? 0 : 1);
      }

      const legacyCols = columns(db, 'transactions_legacy');
      const col = (name: string, fallback: string) => (legacyCols.includes(name) ? name : fallback);
      db.exec(`
        INSERT INTO transactions (id, identifier, account_id, date, description,
          original_amount, original_currency, charged_amount, charged_currency,
          category_id, category_source, created_at)
        SELECT l.id, l.identifier, l.account_id, l.date, l.description,
          COALESCE(${col('original_amount', 'NULL')}, ${col('amount', '0')}),
          COALESCE(${col('original_currency', 'NULL')}, ${col('currency', "'ILS'")}, 'ILS'),
          COALESCE(${col('charged_amount', 'NULL')}, ${col('amount', '0')}),
          COALESCE(${col('charged_currency', 'NULL')}, 'ILS'),
          c.id, CASE WHEN l.category IS NULL THEN NULL ELSE 'api' END,
          l.created_at
        FROM transactions_legacy l
        LEFT JOIN categories c ON c.name = l.category
      `);
      db.exec(`DROP TABLE transactions_legacy`);
    },
  },
  {
    version: 2,
    name: 'accounts from existing transactions and balances',
    up(db) {
      const ids = db.prepare(
        `SELECT account_id FROM transactions UNION SELECT account_id FROM balances`
      ).pluck().all() as string[];
      const insert = db.prepare(
        `INSERT OR IGNORE INTO accounts (id, company, kind, display_name) VALUES (?, ?, ?, ?)`
      );
      for (const id of ids) {
        const company = id.split(':')[0];
        insert.run(id, company, BANK_COMPANIES.has(company) ? 'bank' : 'card', friendlyAccountName(id));
      }
    },
  },
  {
    version: 3,
    name: 'savings sub-accounts and foreign-currency accounts',
    up(db) {
      db.exec(`ALTER TABLE accounts ADD COLUMN is_savings INTEGER NOT NULL DEFAULT 0`);
      // Leumi deposits come back as "<account>-ID_<n>" (the scraper marks them savingsAccount)
      db.exec(`UPDATE accounts SET is_savings = 1 WHERE id GLOB '*-ID_[0-9]*'`);
      const rows = db.prepare(`SELECT id, display_name FROM accounts`).all() as { id: string; display_name: string | null }[];
      const rename = db.prepare(`UPDATE accounts SET display_name = ? WHERE id = ?`);
      for (const r of rows) {
        // only replace names that are still the old generated default
        if (r.display_name === r.id || r.display_name === legacyFriendlyName(r.id)) rename.run(friendlyAccountName(r.id), r.id);
      }
    },
  },
  {
    version: 4,
    name: 'tags as events (dates, budget, notes)',
    up(db) {
      for (const col of ['start_date TEXT', 'end_date TEXT', 'budget REAL', 'notes TEXT', 'archived INTEGER NOT NULL DEFAULT 0']) {
        db.exec(`ALTER TABLE tags ADD COLUMN ${col}`);
      }
    },
  },
  {
    version: 5,
    name: 'immediate-debit card matching',
    up(db) {
      // bank row → the card purchase it settles (debit cards charge each purchase to the bank right away)
      db.exec(`ALTER TABLE transactions ADD COLUMN matched_txn_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL`);
      db.exec(`CREATE INDEX idx_tx_matched ON transactions(matched_txn_id)`);
      db.exec(`ALTER TABLE accounts ADD COLUMN is_debit INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    version: 6,
    name: 'category aliases',
    up(db) {
      // old / external names (categorizer API, scraper) → the category they were renamed or merged into
      db.exec(`CREATE TABLE category_aliases (
        name TEXT PRIMARY KEY,
        category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE
      )`);
    },
  },
  {
    version: 7,
    name: 'manual entries',
    up(db) {
      // expenses paid outside the scraped accounts (cash, someone else paid…) live on a 'manual' account:
      // they count as income/spend everywhere, but it's not a bank account, so it's not in the balance forecast.
      // SQLite can't alter a CHECK constraint — rebuild the table from its own definition with the wider check.
      const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'`).pluck().get() as string;
      const widened = sql.replace(/CHECK\s*\(\s*kind\s+IN\s*\(\s*'bank'\s*,\s*'card'\s*\)\s*\)/i, `CHECK (kind IN ('bank','card','manual'))`);
      if (widened === sql) throw new Error('accounts.kind CHECK not found');
      const cols = columns(db, 'accounts').join(', ');
      db.exec(widened.replace(/^CREATE TABLE\s+"?accounts"?/i, 'CREATE TABLE accounts_new'));
      db.exec(`INSERT INTO accounts_new (${cols}) SELECT ${cols} FROM accounts`);
      db.exec(`DROP TABLE accounts`);
      db.exec(`ALTER TABLE accounts_new RENAME TO accounts`);
      const broken = db.prepare(`PRAGMA foreign_key_check`).all();
      if (broken.length) throw new Error(`foreign keys broken after rebuilding accounts: ${JSON.stringify(broken.slice(0, 3))}`);
      db.prepare(`INSERT OR IGNORE INTO accounts (id, company, kind, display_name) VALUES (?, 'manual', 'manual', 'הזנה ידנית')`).run(MANUAL_ACCOUNT_ID);
    },
  },
  {
    version: 8,
    name: 'planned expenses',
    up(db) {
      // one-off expenses known in advance that the card / bank hasn't charged yet. They count in the
      // forecast and the budget until the real row arrives, then they're matched to it and stop counting.
      db.exec(`CREATE TABLE planned_items (
        id INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        amount REAL NOT NULL,                 -- positive ILS, the whole purchase
        date TEXT NOT NULL,                   -- expected purchase date YYYY-MM-DD
        account_id TEXT NOT NULL REFERENCES accounts(id),
        installments INTEGER NOT NULL DEFAULT 1,
        match_pattern TEXT,                   -- text expected on the statement (optional)
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        member_id INTEGER REFERENCES members(id),
        tag_ids TEXT,                         -- JSON array, copied to the real row when matched
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','matched','cancelled')),
        matched_txn_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec(`CREATE INDEX idx_planned_status ON planned_items(status, account_id)`);
    },
  },
  {
    version: 9,
    name: 'planned expenses: rejected matches',
    up(db) {
      // rows the user said aren't this planned expense ("לא זה") — never matched to it again
      db.exec(`ALTER TABLE planned_items ADD COLUMN rejected_txn_ids TEXT`);
    },
  },
  {
    version: 10,
    name: 'insurance policies',
    up(db) {
      // the household's insurance policies, and their documents (files under data/policies/<policy id>/)
      db.exec(`CREATE TABLE insurance_policies (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other'
          CHECK (type IN ('health','life','nursing','critical_illness','disability','car','home','travel','mortgage','pet','other')),
        insurer TEXT,
        policy_number TEXT,
        insured_member_id INTEGER REFERENCES members(id),  -- null = the whole family / shared
        insured_details TEXT,                 -- who / what is insured (people, car plate, address)
        premium REAL,                         -- ILS per premium_frequency
        premium_frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (premium_frequency IN ('monthly','yearly','one_time')),
        payment_account_id TEXT REFERENCES accounts(id),
        match_pattern TEXT,                   -- text of its charges on the statement, to find what it actually costs
        start_date TEXT,
        end_date TEXT,                        -- end / renewal date
        coverage TEXT,                        -- what it covers, in short
        deductible TEXT,
        agent_name TEXT,
        agent_phone TEXT,
        agent_email TEXT,
        notes TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec(`CREATE TABLE insurance_documents (
        id INTEGER PRIMARY KEY,
        policy_id INTEGER NOT NULL REFERENCES insurance_policies(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,              -- stored name, inside data/policies/<policy id>/
        original_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'policy' CHECK (kind IN ('policy','appendix','renewal','claim','other')),
        uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec(`CREATE INDEX idx_insurance_documents_policy ON insurance_documents(policy_id)`);
    },
  },
  {
    version: 11,
    name: 'pension & long-term savings details',
    up(db) {
      // what a pension / provident / study-fund report tells about each product (src/import/pensionReport.ts)
      for (const col of [
        'policy_number TEXT',              // policy / account number at the provider
        'employer TEXT',                   // the employer depositing into it
        "status TEXT",                     // active | inactive (deposits still coming in or not)
        'join_date TEXT',
        'fee_deposit_pct REAL',            // management fee from each deposit (%)
        'fee_balance_pct REAL',            // management fee from the balance (% a year)
        'expected_annuity REAL',           // expected monthly pension at retirement, without further deposits
        'details TEXT',                    // JSON: tracks + returns, components, insurance coverage, insured salary
      ]) db.exec(`ALTER TABLE assets ADD COLUMN ${col}`);
      // not unique: a provider can file two products under one number (e.g. comprehensive + general pension fund)
      db.exec(`CREATE INDEX idx_assets_policy ON assets(provider, policy_number)`);

      // deposits into a product, as listed in the report (one row per salary month)
      db.exec(`CREATE TABLE asset_deposits (
        id INTEGER PRIMARY KEY,
        asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        value_date TEXT NOT NULL,
        salary_month TEXT,                 -- YYYY-MM the deposit is for
        salary REAL,                       -- the insured salary of that month
        employee REAL, employer REAL, severance REAL,
        total REAL NOT NULL,
        UNIQUE (asset_id, value_date, salary_month)
      )`);

      // a whole report (e.g. the agent's quarterly summary): the overall numbers it states
      db.exec(`CREATE TABLE pension_reports (
        id INTEGER PRIMARY KEY,
        as_of TEXT NOT NULL,
        member_id INTEGER REFERENCES members(id),
        source TEXT,                       -- who produced it
        file_path TEXT,                    -- under data/reports/
        summary TEXT NOT NULL,             -- JSON: totals, breakdowns, exposures, expected pension
        imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (as_of, member_id, source)
      )`);
    },
  },
  {
    version: 12,
    name: 'assets policy index not unique',
    up(db) {
      // v11 first shipped it as UNIQUE; two products can share a policy number
      db.exec(`DROP INDEX IF EXISTS idx_assets_policy`);
      db.exec(`CREATE INDEX idx_assets_policy ON assets(provider, policy_number)`);
    },
  },
  {
    version: 13,
    name: 'stock market holdings and quotes',
    up(db) {
      // a position: a symbol and how many units; valued live from its quote (src/analytics/investments.ts)
      db.exec(`CREATE TABLE holdings (
        id INTEGER PRIMARY KEY,
        symbol TEXT NOT NULL,              -- Yahoo Finance symbol: AAPL, VOO, TEVA.TA, BTC-USD
        name TEXT,                         -- display name; the quote's name when empty
        quantity REAL NOT NULL,
        currency TEXT,                     -- the quote's currency, in major units (ILS, not agorot)
        buy_price REAL,                    -- average price paid per unit, in that currency
        buy_date TEXT,
        baseline_price REAL,               -- no buy price: the price when it was added — the yield runs from there
        baseline_date TEXT,
        manual_price REAL,                 -- something with no quote (e.g. an Israeli mutual fund): its price, set by hand
        manual_price_date TEXT,
        broker TEXT,                       -- where it's held
        owner_member_id INTEGER REFERENCES members(id),
        notes TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`);
      db.exec(`CREATE INDEX idx_holdings_symbol ON holdings(symbol)`);

      // the latest quote per symbol (only symbols are ever sent out, never quantities)
      db.exec(`CREATE TABLE quotes (
        symbol TEXT PRIMARY KEY,
        name TEXT,
        currency TEXT,                     -- major units
        price REAL,
        previous_close REAL,
        exchange TEXT,
        instrument_type TEXT,              -- EQUITY / ETF / MUTUALFUND / CRYPTOCURRENCY …
        market_time TEXT,                  -- when the price was set by the market (ISO)
        fetched_at TEXT,
        error TEXT                         -- the last fetch failed: why (the price is the previous one)
      )`);
      // daily closes, for the value-over-time chart and month-end net worth
      db.exec(`CREATE TABLE quote_history (
        symbol TEXT NOT NULL,
        date TEXT NOT NULL,
        close REAL NOT NULL,
        PRIMARY KEY (symbol, date)
      )`);
    },
  },  {
    version: 14,
    name: 'default categories for a new household',
    up(db) {
      // an existing database keeps its own categories
      if ((db.prepare(`SELECT COUNT(*) FROM categories`).pluck().get() as number) > 0) return;
      const insert = db.prepare(`INSERT INTO categories (name, parent_id, kind, default_fixed, discretionary) VALUES (?, ?, ?, ?, ?)`);
      for (const [name, kind, fixed, discretionary, children] of DEFAULT_CATEGORIES) {
        const parentId = Number(insert.run(name, null, kind, fixed, discretionary).lastInsertRowid);
        for (const [child, childFixed, childDiscretionary, childKind] of children) {
          insert.run(child, parentId, childKind ?? kind, childFixed, childDiscretionary);
        }
      }
      // the card companies' own category names → ours, so scraped rows are categorized without any rule
      const alias = db.prepare(`INSERT OR IGNORE INTO category_aliases (name, category_id) SELECT ?, id FROM categories WHERE name = ?`);
      for (const [from, to] of Object.entries(SCRAPER_CATEGORY_ALIASES)) alias.run(from, to);
    },
  },
  {
    version: 15,
    name: 'deposits: unknown salary month is unique too',
    up(db) {
      // Archive every superseded row before deduplication, in the runner's transaction.
      // NULL and empty salary months share the new key; latest import (highest id) wins.
      const superseded = `id NOT IN (SELECT MAX(id) FROM asset_deposits
        GROUP BY asset_id, value_date, COALESCE(salary_month, ''))`;
      db.exec('CREATE TABLE asset_deposits_dedup_backup_v15 AS SELECT * FROM asset_deposits WHERE 0');
      const archived = db.prepare(`INSERT INTO asset_deposits_dedup_backup_v15 SELECT * FROM asset_deposits WHERE ${superseded}`).run().changes;
      const removed = db.prepare(`DELETE FROM asset_deposits WHERE ${superseded}`).run().changes;
      db.exec(`CREATE UNIQUE INDEX idx_asset_deposits_unique ON asset_deposits (asset_id, value_date, COALESCE(salary_month, ''))`);
      if (removed > 0) console.info(`Migration 15: archived ${archived} superseded deposit rows in asset_deposits_dedup_backup_v15; removed ${removed} duplicates`);

    },
  },
];

type CategoryKind = 'expense' | 'income' | 'transfer' | 'card_payment' | 'savings';
/** [name, kind, fixed by default, discretionary, children: [name, fixed, discretionary, kind if not the parent's]] */
const DEFAULT_CATEGORIES: [string, CategoryKind, number, number, [string, number, number, CategoryKind?][]][] = [
  ['אופנה ביגוד והנעלה', 'expense', 0, 1, []],
  ['אחר', 'expense', 0, 1, [['כרטיסים נטענים', 0, 0, 'transfer'], ['לא ידוע', 0, 1], ['קניות בחו"ל', 0, 1]]],
  ['ביטוחים', 'expense', 1, 1, []],
  ['בילוי ומסעדות', 'expense', 0, 1, [['אוכל מהיר', 0, 1], ['מסעדות ובילויים', 0, 1]]],
  ['בעלי חיים', 'expense', 0, 1, []],
  ['בריאות', 'expense', 0, 0, []],
  ['הכנסות', 'income', 0, 0, [['דיבידנדים', 0, 0], ['העברות חיצוניות', 0, 0], ['משכורת', 0, 0], ['עסק', 0, 0]]],
  ['הלוואות ומשכנתא', 'expense', 1, 0, []],
  ['העברות כספים', 'transfer', 0, 0, []],
  ['השקעות וחסכונות', 'savings', 0, 0, [['חסכון חודשי', 1, 0], ['תיק השקעות', 0, 0]]],
  ['תשלום כרטיס אשראי', 'card_payment', 0, 0, []],
  ['חינוך ומשפחה', 'expense', 0, 1, [['בתי ספר וגנים', 1, 0], ['חוגים', 1, 0], ['תרבות ופנאי', 0, 1]]],
  ['חשבונות', 'expense', 1, 0, [['אינטרנט', 1, 0], ['ארנונה', 1, 0], ['גז', 1, 0], ['ועד בית', 1, 0], ['חשמל', 1, 0], ['טלויזיה ובידור', 1, 0], ['מים', 1, 0], ['סלולר', 1, 0]]],
  ['חשמל ואלקטרוניקה', 'expense', 0, 1, []],
  ['מזומן', 'expense', 0, 1, []],
  ['מזון וטואלטיקה', 'expense', 0, 0, [['חד פעמי', 0, 0], ['סופרמרקט', 0, 0], ['פארם', 0, 0], ['פירות וירקות', 0, 0]]],
  ['מיסים, דוחות ועמלות', 'expense', 0, 0, [['עמלות אשראי', 1, 0], ['עמלות בנק', 1, 0], ['תשלום דוחות', 0, 0]]],
  ['מנויים ושירותים דיגיטליים', 'expense', 1, 0, []],
  ['נופש', 'expense', 0, 1, [['אטרקציות', 0, 1], ['טיסות', 0, 1], ['כסף מזומן', 0, 1], ['מחייה ומזון', 0, 1], ['מלונות', 0, 1], ['שופינג', 0, 1], ['תחבורה', 0, 1], ['תקשורת', 0, 1]]],
  ['ספורט וטיפוח', 'expense', 0, 1, [['מנוי כושר', 1, 1], ['מספרה', 0, 1], ['קוסמטיקה ואביזרי טיפוח', 0, 1]]],
  ['רכב ותחבורה', 'expense', 0, 0, [['ביטוח רכב', 1, 0], ['דלק וחשמל', 0, 0], ['הלוואת רכב', 1, 0], ['חניונים', 0, 1], ['תחבורה ציבורית', 0, 0], ['תחזוקת רכב', 0, 0]]],
  ['שיפוץ, תחזוקה וריהוט הבית', 'expense', 0, 1, [['ניקיון', 0, 1], ['ריהוט', 0, 1], ['שיפוץ ואביזרים לבית', 0, 1], ['תיקונים', 0, 0]]],
  ['תרומות ומתנות', 'expense', 0, 1, [['מתנות ואירועים', 0, 1], ['תרומה', 0, 1]]],
];

/** Category names Max / Isracard / Cal put on their rows → the default category they mean. */
const SCRAPER_CATEGORY_ALIASES: Record<string, string> = {
  'מזון וצריכה': 'סופרמרקט', 'מזון ומשקאות': 'סופרמרקט', 'מסעדות, קפה וברים': 'מסעדות ובילויים', 'מסעדות': 'מסעדות ובילויים',
  'מזון מהיר': 'אוכל מהיר', 'אופנה': 'אופנה ביגוד והנעלה', 'רפואה ובתי מרקחת': 'פארם', 'רפואה ובריאות': 'בריאות',
  'שירותי תקשורת': 'סלולר', 'ביטוח': 'ביטוחים', 'דלק, חשמל וגז': 'דלק וחשמל', 'אנרגיה': 'דלק וחשמל',
  'תחבורה ורכבים': 'רכב ותחבורה', 'חיות מחמד': 'בעלי חיים', 'קוסמטיקה וטיפוח': 'קוסמטיקה ואביזרי טיפוח',
  'מלונאות ואירוח': 'מלונות', 'טיסות ותיירות': 'טיסות', 'תיירות': 'נופש', 'תקשורת ומחשבים': 'חשמל ואלקטרוניקה',
  'חשמל ומחשבים': 'חשמל ואלקטרוניקה', 'ריהוט ובית': 'ריהוט', 'עיצוב הבית': 'שיפוץ ואביזרים לבית', 'ספרים ודפוס': 'תרבות ופנאי',
  'אירועים': 'מתנות ואירועים', 'ילדים': 'חינוך ומשפחה', 'פנאי, בידור וספורט': 'תרבות ופנאי', 'פנאי בילוי': 'מסעדות ובילויים',
};

/** The account that holds manually entered transactions. */
export const MANUAL_ACCOUNT_ID = 'manual:entries';

const COMPANY_NAMES: Record<string, string> = {
  hapoalim: 'הפועלים', leumi: 'לאומי', discount: 'דיסקונט', mizrahi: 'מזרחי טפחות', mercantile: 'מרכנתיל',
  otsarHahayal: 'אוצר החייל', union: 'איגוד', beinleumi: 'הבינלאומי', massad: 'מסד', yahav: 'יהב', oneZero: 'וואן זירו',
  pagi: 'פאגי', visaCal: 'כאל', isracard: 'ישראכרט', amex: 'אמריקן אקספרס', max: 'מקס', beyahadBishvilha: 'ביחד בשבילך',
  behatsdaa: 'בהצדעה',
};

/** "hapoalim:12-345-678901" → "הפועלים ···8901" */
export function friendlyAccountName(accountId: string): string {
  const [company, number = ''] = accountId.split(':');
  const name = COMPANY_NAMES[company] ?? company;
  const deposit = number.match(/^(.*)-ID_(\d+)$/);
  if (deposit) return `${name} חיסכון ${deposit[2]} ···${deposit[1].replace(/\D/g, '').slice(-4)}`;
  const fx = number.match(/^(.*)-([A-Z]{3})$/);
  if (fx) return `${name} מט"ח ${fx[2]}`;
  const digits = number.replace(/\D/g, '');
  return `${name} ···${digits.slice(-4) || number}`;
}

/** The name scheme used before migration 3, to recognise untouched defaults. */
function legacyFriendlyName(accountId: string): string {
  const [company, number = ''] = accountId.split(':');
  const digits = number.replace(/\D/g, '');
  return `${COMPANY_NAMES[company] ?? company} ···${digits.slice(-4) || number}`;
}

/** israeli-bank-scrapers company ids that are bank accounts (the rest are credit cards). */
export const BANK_COMPANIES = new Set([
  'hapoalim', 'leumi', 'discount', 'mercantile', 'mizrahi', 'otsarHahayal', 'union',
  'beinleumi', 'massad', 'yahav', 'oneZero', 'pagi',
]);
