import cron from 'node-cron';
import { scrapeAll, type Config } from './scraper.js';
import { runPipeline } from './pipeline.js';
import { getDb } from './db/connection.js';
import { loadConfig } from './config.js';
import { warnBroadPermissions } from './permissions.js';

const config = loadConfig();
warnBroadPermissions();

async function run(cfg: Config): Promise<void> {
  const db = getDb();
  const results = await scrapeAll(cfg, db);
  const newIds = results.flatMap(r => r.newTransactionIds);
  console.log(`\nScrape done: ${results.map(r => `${r.company} ${r.success ? '✓' : `✗ ${r.errorType}`}`).join(', ')}`);
  const summary = await runPipeline(db, { txIds: newIds, categoryApiUrl: cfg.categoryApiUrl });
  console.log('Pipeline:', summary);
}

// SCHEDULE="0 7 * * *" keeps the process running and scrapes on that cron schedule
const schedule = process.env.SCHEDULE;
if (schedule) {
  console.log(`Bank scraper scheduled: ${schedule}`);
  cron.schedule(schedule, () => {
    console.log(`\n[${new Date().toISOString()}] Running scrape...`);
    run(config).catch(console.error);
  });
} else {
  run(config).catch(err => { console.error(err); process.exitCode = 1; });
}
