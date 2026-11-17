import { existsSync, readFileSync } from 'fs';
import type { Config } from './scraper.js';
import { dataPath } from './paths.js';

/** The bank logins file (git-ignored) — read on demand by whoever scrapes. `ACCOUNTS_FILE` overrides the path. */
export const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || dataPath('accounts.json');

export function readAccountsFile(file = ACCOUNTS_FILE): Config {
  if (!existsSync(file)) {
    throw new Error(`${file} not found — copy accounts.example.json to ${file} and fill in your bank logins`);
  }
  return JSON.parse(readFileSync(file, 'utf-8'));
}

/**
 * Where the bank logins come from. The CLI and `npm run dev` read accounts.json; the desktop app replaces this with
 * a request to its main process, which keeps them encrypted in the OS credential store (desktop/credentials.ts).
 */
/** loginIds: only these logins (the desktop app's login check); the accounts file has no ids and returns all */
type ConfigProvider = (loginIds?: string[]) => Config | Promise<Config>;
let provider: ConfigProvider = () => readAccountsFile();

export function setConfigProvider(p: ConfigProvider): void {
  provider = p;
}

export const loadConfig = async (loginIds?: string[]): Promise<Config> => provider(loginIds);
