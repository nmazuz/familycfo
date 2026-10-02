# Security

This app holds a household's complete financial picture and the logins to its banks, so please read this before
running it.

## The model

- It is meant to run on **one trusted computer**, for the people who live with that data. The API binds to
  `127.0.0.1` and has **no authentication** — anything that can reach that port can read everything. Don't expose it
  through a reverse proxy, a tunnel, port forwarding, or a `0.0.0.0` bind.
- The API rejects requests with a non-local `Host` header and writes with a non-local `Origin`, so a web page you
  visit cannot drive it (cross-site POSTs, DNS rebinding). Other programs on the same computer still can.
  Loopback HTTP origins are allowed on any valid port so custom Vite/API ports work without a shared secret.
  This trusts other web apps on this computer; it is not protection against a malicious local process.
- The scraper's Chrome runs with its sandbox. `CHROME_NO_SANDBOX=1` removes it and is only for Docker / CI.
- Bank logins are read from `accounts.json` (git-ignored). Treat that file like a password vault: keep the computer's
  disk encrypted and its user account locked. Where your bank supports it, use a read-only / viewing user for scraping.
- `bank.db`, `backups/` and `data/` hold the data itself. New databases and imported documents are `0600`,
  new data folders are `0700`, and an existing database is tightened to `0600`. Startup warns about the database
  and its WAL/SHM sidecars, credentials, backups, data and `POLICIES_DIR` / `REPORTS_DIR` overrides. Existing user
  files and folders are only warned about, not changed: run `chmod 600` for files and `chmod 700` for folders.
  Folder checks do not recursively audit old documents or backups. Keep these paths out of git, shared cloud
  folders and bug reports.
- The chat workspace is a unique `household-agent-*` directory outside the repo, created `0700`. Before each
  use the app rejects symlinks / foreign owners and re-applies `0700`; it is included in permission diagnostics
  once created. Copies remain in the temp directory until removed by the user or OS. This is not a defense
  against a malicious process running as your own user.
- The data chat runs your own Claude Code CLI with only read access to the database and to `data/`. What it reads is
  sent to Anthropic under your account to answer you.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting
(**Security → Report a vulnerability** on the repository) and include the steps to reproduce. Never attach real
credentials or financial data.
