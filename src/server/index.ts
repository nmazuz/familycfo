import { startServer } from './app.js';

// npm run server / npm run dev: the API only (Vite serves the UI and proxies /api)
const { app, port } = await startServer({ webDist: process.env.HOUSEHOLD_WEB_DIST });
console.log(`Household API on http://127.0.0.1:${port}`);

// Close the authenticated mobile gateway and its connector on normal CLI/watch shutdown.
const shutdown = () => { void app.close().finally(() => process.exit(0)); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
