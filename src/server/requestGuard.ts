import type { FastifyInstance } from 'fastify';

/**
 * The API has no login and binds to 127.0.0.1, which keeps other computers out but not the user's own browser.
 * This guard closes the two ways a web page can still reach it:
 *  - DNS rebinding: the page's domain is switched to 127.0.0.1, so its requests carry a foreign `Host` header;
 *  - cross-site writes: a plain form POST (no preflight) from another site carries a foreign `Origin` header.
 * Requests without an `Origin` (curl, scripts, same-origin GETs) are allowed: only a browser sends one, and a
 * browser always sends it on a cross-site write.
 */
const LOOPBACK_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/i;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Types a cross-site HTML form can send without a CORS preflight — never legitimate for this API. */
const FORM_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);

/** `host` is a `Host` header value ("localhost:4310"); true when it names this computer's loopback. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const match = LOOPBACK_AUTHORITY.exec(host);
  return !!match && match[0] === host && (match[1] === undefined || (Number(match[1]) >= 1 && Number(match[1]) <= 65535));
}

/** True when an `Origin` header value is a page served from the loopback (the app's own web UI, any port). */
export function isLoopbackOrigin(origin: string): boolean {
  return origin.startsWith('http://') && isLoopbackHost(origin.slice(7));
}

/** Register before any route so the hook covers all of them. */
export function registerRequestGuard(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!isLoopbackHost(req.headers.host)) return reply.code(403).send({ error: 'forbidden host' });
    if (!WRITE_METHODS.has(req.method)) return;

    const origin = req.headers.origin;
    if (origin !== undefined && !isLoopbackOrigin(origin)) return reply.code(403).send({ error: 'forbidden origin' });

    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (FORM_TYPES.has(type)) return reply.code(415).send({ error: 'unsupported content type' });
  });
}
