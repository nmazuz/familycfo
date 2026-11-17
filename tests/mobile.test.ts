import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildMobileGateway, type GatewayOptions } from '../src/server/mobile.js';
import { localOnly } from '../src/server/web.js';

const host = 'family.example.com';
const headers = { host, origin: `https://${host}` };
const cookie = '__Host-familycfo=session-secret';
const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
function gateway(overrides: Partial<GatewayOptions> = {}) {
  const app = buildMobileGateway({ targetPort: 1, publicHost: () => host, code: '123456', session: 'session-secret',
    expiresAt: Date.now() + 60_000, ...overrides });
  apps.push(app);
  return app;
}

describe('mobile authentication gateway', () => {
  it('requires authentication before serving financial data or files', async () => {
    const app = gateway();
    const page = await app.inject({ url: '/insurance', headers: { host } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('קוד גישה');
    expect(page.body).not.toContain('123456');
    expect((await app.inject({ url: '/api/transactions', headers: { host } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/scrape', headers, payload: {} })).statusCode).toBe(401);
  });

  it('checks Host and Origin and blocks tunnel controls even after login', async () => {
    const app = gateway();
    for (const path of ['/api/mobile', '/api/mobile/start', '/api/%6dobile/stop']) {
      expect((await app.inject({ method: 'POST', url: path, headers: { ...headers, cookie }, payload: {} })).statusCode).toBe(403);
    }
    expect((await app.inject({ url: '/', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/', headers: { host, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/mobile-login', headers: { host }, payload: { code: '123456' } })).statusCode).toBe(403);
  });

  it('sets a secure session cookie only for a correct code and limits login attempts', async () => {
    const app = gateway();
    expect((await app.inject({ method: 'POST', url: '/mobile-login', headers, payload: { code: 'wrong' } })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/mobile-login', headers, payload: { code: '123456' } });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain(`${cookie}; Secure; HttpOnly; SameSite=Strict; Path=/`);
    for (let i = 0; i < 3; i++) await app.inject({ method: 'POST', url: '/mobile-login', headers, payload: { code: 'wrong' } });
    expect((await app.inject({ method: 'POST', url: '/mobile-login', headers, payload: { code: '123456' } })).statusCode).toBe(429);
  });

  it('locks further pairing attempts after 20 wrong codes even across rate-limit windows', async () => {
    const clock = vi.spyOn(Date, 'now');
    let now = Date.now();
    clock.mockImplementation(() => now);
    try {
      const app = gateway({ expiresAt: now + 12 * 60 * 60_000 });
      for (let window = 0; window < 4; window++) {
        now += 60_001;
        for (let i = 0; i < 5; i++) {
          expect((await app.inject({ method: 'POST', url: '/mobile-login', headers, payload: { code: '000000' } })).statusCode).toBe(401);
        }
      }
      now += 60_001;
      const locked = await app.inject({ method: 'POST', url: '/mobile-login', headers, payload: { code: '123456' } });
      expect(locked.statusCode).toBe(429);
      expect(locked.json().error).toContain('מחדש');
    } finally { clock.mockRestore(); }
  });

  it('rejects expired or revoked sessions and explains the Quick Tunnel chat limitation', async () => {
    expect((await gateway({ expiresAt: Date.now() - 1 }).inject({ url: '/', headers: { ...headers, cookie } })).statusCode).toBe(403);
    expect((await gateway({ publicHost: () => null }).inject({ url: '/', headers: { ...headers, cookie } })).statusCode).toBe(403);
    const chat = await gateway({ quickTunnel: true }).inject({ method: 'POST', url: '/api/agent/chat', headers: { ...headers, cookie }, payload: {} });
    expect(chat.statusCode).toBe(409);
  });

  it('proxies authenticated JSON, binary uploads and SSE while keeping the local API protected', async () => {
    const backend = Fastify();
    apps.push(backend);
    localOnly(backend);
    backend.post('/api/echo', async req => ({ body: req.body, cookie: req.headers.cookie ?? null, host: req.headers.host }));
    backend.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    backend.post('/api/file', async (req, reply) => reply.type('application/octet-stream').send(req.body));
    backend.get('/api/stream', async (_req, reply) => reply.type('text/event-stream').send('data: hello\n\n'));
    await backend.listen({ host: '127.0.0.1', port: 0 });
    const address = backend.server.address() as import('node:net').AddressInfo;
    const app = gateway({ targetPort: address.port });
    const res = await app.inject({ method: 'POST', url: '/api/echo', headers: { ...headers, cookie }, payload: { amount: 42, description: 'בדיקה' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: { amount: 42, description: 'בדיקה' }, cookie: null, host: `127.0.0.1:${address.port}` });
    const bytes = Buffer.from([0, 255, 1, 128, 42]);
    const file = await app.inject({ method: 'POST', url: '/api/file', headers: { ...headers, cookie, 'content-type': 'application/octet-stream' }, payload: bytes });
    expect(file.rawPayload).toEqual(bytes);
    const stream = await app.inject({ url: '/api/stream', headers: { ...headers, cookie } });
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toBe('data: hello\n\n');
    expect((await backend.inject({ url: '/api/stream', headers: { host } })).statusCode).toBe(403);
  });
});
