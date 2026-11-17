# Security

This app holds a household's complete financial picture and the logins to its banks, so please read this before
running it.

## The model

- It is meant to run on **one trusted computer**, for the people who live with that data. The API binds to
  `127.0.0.1` and has **no authentication** — anything that can reach that port can read everything. Don't expose it
  directly through a reverse proxy, a tunnel, port forwarding, or a `0.0.0.0` bind. For optional phone access, use
  **Settings → Mobile connection**, which puts a separate authenticated gateway in front of the local API. See
  [mobile access](docs/mobile.md) for access codes, expiration, Cloudflare routing and Named Tunnel configuration.
- Bank logins are read from `accounts.json` (git-ignored). Treat that file like a password vault: keep the computer's
  disk encrypted and its user account locked. Where your bank supports it, use a read-only / viewing user for scraping.
- `bank.db`, `backups/` and `data/` hold the data itself — keep them out of git, cloud-synced folders you share, and
  bug reports.
- The data chat runs your own Claude Code CLI with only read access to the database and to `data/`. What it reads is
  sent to Anthropic under your account to answer you.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's private vulnerability reporting
(**Security → Report a vulnerability** on the repository) and include the steps to reproduce. Never attach real
credentials or financial data.
