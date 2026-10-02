import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { isLoopbackHost, isLoopbackOrigin, registerRequestGuard } from '../src/server/requestGuard.js';

function setup() {
  const app = Fastify();
  registerRequestGuard(app);
  app.get('/api/data', async () => ({ secret: 1 }));
  app.post('/api/scrape', async () => ({ started: true }));
  app.put('/api/thing', async req => ({ got: req.body }));
  app.delete('/api/thing', async () => ({ ok: true }));
  return app;
}
const host = { host: '127.0.0.1:4310' };

describe('request guard: Host header (DNS rebinding)', () => {
  it('allows loopback hosts, with and without a port', async () => {
    const app = setup();
    for (const h of ['127.0.0.1:4310', 'localhost:4310', 'localhost', '[::1]:4310', 'LOCALHOST:5180']) {
      const res = await app.inject({ method: 'GET', url: '/api/data', headers: { host: h } });
      expect(res.statusCode, h).toBe(200);
    }
  });

  it('rejects a foreign Host with 403, for reads too', async () => {
    const app = setup();
    for (const h of ['evil.example:4310', 'evil.example', '127.0.0.1.evil.example:4310', 'localhost.evil.example', '192.168.1.5:4310', '0.0.0.0:4310']) {
      const res = await app.inject({ method: 'GET', url: '/api/data', headers: { host: h } });
      expect(res.statusCode, h).toBe(403);
      expect(res.body).not.toContain('secret');
    }
  });

  it('rejects a Host with userinfo or other tricks', async () => {
    const app = setup();
    for (const h of ['127.0.0.1@evil.example', 'evil.example#127.0.0.1', 'evil.example/127.0.0.1', '127.1', 'evil@127.0.0.1', '127.0.0.1:4310/x', 'localhost:0', 'localhost:65536', 'localhost:4310\n']) {
      const res = await app.inject({ method: 'GET', url: '/api/data', headers: { host: h } });
      expect(res.statusCode, h).toBe(403);
    }
  });
});

describe('request guard: Origin and content type (cross-site writes)', () => {
  it('rejects a write from another site with 403 and does not run the handler', async () => {
    const app = setup();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const url = method === 'POST' ? '/api/scrape' : '/api/thing';
      const res = await app.inject({ method, url, headers: { ...host, origin: 'https://evil.example' } });
      expect(res.statusCode, method).toBe(403);
    }
  });

  it('rejects the opaque and malformed origins, and a https page pretending to be local', async () => {
    const app = setup();
    for (const origin of ['null', 'not a url', 'https://127.0.0.1:4310', 'http://127.0.0.1.evil.example', 'http://evil@127.0.0.1', 'http://127.1', 'http://localhost:5180/', 'http://localhost:5180/x', 'http://localhost:5180?x=1', 'http://localhost:5180#x']) {
      const res = await app.inject({ method: 'POST', url: '/api/scrape', headers: { ...host, origin } });
      expect(res.statusCode, origin).toBe(403);
    }
  });

  it('allows the app\'s own web UI (loopback origin, any port) and clients that send no Origin', async () => {
    const app = setup();
    for (const origin of ['http://127.0.0.1:5180', 'http://localhost:5180', 'http://localhost:3000', undefined]) {
      const res = await app.inject({ method: 'POST', url: '/api/scrape', headers: { ...host, ...(origin ? { origin } : {}) } });
      expect(res.statusCode, String(origin)).toBe(200);
    }
    const json = await app.inject({ method: 'PUT', url: '/api/thing', headers: { ...host, origin: 'http://127.0.0.1:5180' }, payload: { a: 1 } });
    expect(json.json()).toEqual({ got: { a: 1 } });
  });

  it('does not check Origin on reads', async () => {
    const res = await setup().inject({ method: 'GET', url: '/api/data', headers: { ...host, origin: 'http://127.0.0.1:5180' } });
    expect(res.statusCode).toBe(200);
  });

  it('rejects form content types, which a web page can send without a preflight', async () => {
    const app = setup();
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'Text/Plain; charset=utf-8']) {
      const res = await app.inject({ method: 'POST', url: '/api/scrape', headers: { ...host, 'content-type': type }, payload: 'a=1' });
      expect(res.statusCode, type).toBe(415);
    }
  });
});

describe('loopback helpers', () => {
  it('parses hosts and origins strictly', () => {
    expect(isLoopbackHost('127.0.0.1:4310')).toBe(true);
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackOrigin('http://localhost:5180')).toBe(true);
    expect(isLoopbackOrigin('http://example.com')).toBe(false);
  });
});

describe('request guard with the real insurance upload route', () => {
  it('still accepts a PDF upload from the web UI, and the file is stored owner-only', async () => {
    const { mkdtempSync, statSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'cfo-ins-'));
    vi.stubEnv('POLICIES_DIR', join(dir, 'policies'));
    vi.resetModules();
    try {
    const { insuranceRoutes } = await import('../src/server/routes/insurance.js');
    const { testDb } = await import('./helpers.js');
    const db = testDb();
    const policyId = Number(db.prepare(`INSERT INTO insurance_policies (name, type) VALUES ('Test', 'health')`).run().lastInsertRowid);
    const app = Fastify();
    registerRequestGuard(app);
    insuranceRoutes(app, db);
    const url = `/api/insurance/${policyId}/documents?name=p`;
    const ok = await app.inject({ method: 'POST', url, headers: { ...host, origin: 'http://127.0.0.1:5180', 'content-type': 'application/pdf' }, payload: Buffer.from('%PDF-1.4') });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url, headers: { ...host, origin: 'https://evil.example', 'content-type': 'application/pdf' }, payload: Buffer.from('%PDF-1.4') });
    expect(bad.statusCode).toBe(403);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'policies', String(policyId))).mode & 0o777).toBe(0o700);
    await app.close();
    db.close();
    } finally { vi.unstubAllEnvs(); vi.resetModules(); rmSync(dir, { recursive: true, force: true }); }
  });
});

// Import through the real entry point: no listen(), getDb(), or production data access.
describe('production buildApp guard registration', () => {
  it('blocks foreign hosts on every real route module, before handlers run', async () => {
    const { buildApp } = await import('../src/server/index.js');
    const { testDb } = await import('./helpers.js');
    const db = testDb();
    const app = buildApp(db);
    try {
      for (const url of ['/api/members', '/api/meta', '/api/transactions', '/api/cashflow',
        '/api/events', '/api/categories', '/api/insurance', '/api/pension', '/api/investments']) {
        // A 404 would also be guarded, so prove the route exists independently.
        expect(app.hasRoute({ method: 'GET', url }), url).toBe(true);
        const res = await app.inject({ method: 'GET', url, headers: { host: 'foreign.example' } });
        expect(res.statusCode, url).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden host' });
      }
      expect(app.hasRoute({ method: 'POST', url: '/api/agent/chat' })).toBe(true);
      expect((await app.inject({ method: 'POST', url: '/api/agent/chat', headers: { host: 'foreign.example' }, payload: { message: 'test' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/meta', headers: host })).statusCode).toBe(200);
    } finally { await app.close(); db.close(); }
  });
});
