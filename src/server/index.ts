import { startServer } from './app.js';

// npm run server / npm run dev: the API only (Vite serves the UI and proxies /api)
const { port } = await startServer();
console.log(`Household API on http://127.0.0.1:${port}`);
