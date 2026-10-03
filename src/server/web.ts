import { createReadStream, existsSync, statSync } from 'fs';
import { extname, join, resolve, sep } from 'path';
import type { FastifyInstance } from 'fastify';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const hostnameOf = (value: string | undefined): string | null => {
  if (!value) return null;
  try { return new URL(value.includes('://') ? value : `http://${value}`).hostname; } catch { return null; }
};

/**
 * The API listens on 127.0.0.1 only, but any web page open in a browser on this computer can still send requests to
 * it. Two checks stop that. The Host must be a loopback name, which blocks DNS rebinding. Any Origin must be a
 * loopback page too, which blocks another site posting e.g. /api/scrape. The Vite dev proxy keeps Host and Origin
 * as 127.0.0.1:5180, so it passes.
 */
export function localOnly(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const host = hostnameOf(req.headers.host);
    const origin = req.headers.origin;
    const originOk = !origin || LOCAL_HOSTNAMES.has(hostnameOf(origin) ?? '');
    if (!host || !LOCAL_HOSTNAMES.has(host) || !originOk) return reply.code(403).send({ error: 'local requests only' });
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

// the built UI loads only its own scripts; inline styles are used by the charts
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'",
].join('; ');

/** Serve the built web UI (web/dist) for every GET that isn't /api; unknown routes get index.html (client routing). */
export function serveWeb(app: FastifyInstance, distDir: string): void {
  const root = resolve(distDir);
  const index = join(root, 'index.html');
  app.setNotFoundHandler((req, reply) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if ((req.method !== 'GET' && req.method !== 'HEAD') || path.startsWith('/api/')) {
      return reply.code(404).send({ error: `${req.method} ${path} not found` });
    }
    let file = resolve(root, `.${path}`);
    const found = file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile();
    if (!found) {
      // a missing asset is a 404; anything else is a client-side route
      if (extname(path)) return reply.code(404).send({ error: 'not found' });
      file = index;
    }
    const ext = extname(file);
    reply.header('content-type', MIME[ext] ?? 'application/octet-stream');
    // Vite's hashed assets never change; index.html must be re-read after an update
    reply.header('cache-control', file.startsWith(join(root, 'assets') + sep) ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (ext === '.html') reply.header('content-security-policy', CSP);
    return reply.send(createReadStream(file));
  });
}
