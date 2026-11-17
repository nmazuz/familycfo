import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

const SESSION_MS = 12 * 60 * 60_000;
const COOKIE = '__Host-familycfo';
const MAX_FAILED_ATTEMPTS = 20;
const secureEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const loginHtml = `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FamilyCFO · חיבור לנייד</title><style>body{font:18px system-ui;max-width:360px;margin:15vh auto;padding:24px;background:#f5f6fa;color:#162238}input,button{font:inherit;box-sizing:border-box;width:100%;padding:12px;margin:8px 0}input{direction:ltr}button{background:#243c8c;color:white;border:0;border-radius:8px}#error{color:#a11}</style>
<h1>FamilyCFO</h1><p>הזינו את קוד הגישה שמופיע בהגדרות במחשב.</p><form id="login"><label for="code">קוד גישה</label><input id="code" type="text" inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="one-time-code" placeholder="6 ספרות" required><button>התחברות</button><p id="error" role="alert"></p></form><script src="/mobile-login.js" defer></script></html>`;
const loginScript = `document.getElementById('login').addEventListener('submit',async e=>{e.preventDefault();try{const r=await fetch('/mobile-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:document.getElementById('code').value.trim()})});if(r.ok)location.replace('/');else{const error=await r.json().catch(()=>null);document.getElementById('error').textContent=error?.error||(r.status===429?'יותר מדי ניסיונות. נסו שוב בעוד דקה.':'קוד שגוי או חיבור שפג תוקפו');}}catch{document.getElementById('error').textContent='החיבור אינו זמין';}});`;

export interface GatewayOptions {
  targetPort: number;
  publicHost: () => string | null;
  code: string;
  session: string;
  expiresAt: number;
  quickTunnel?: boolean;
}

/** A separate authenticated gateway. The local API keeps its loopback Host/Origin restrictions. */
export function buildMobileGateway(opts: GatewayOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });
  let attempts = 0, failedAttempts = 0, windowStart = Date.now();
  app.addHook('onRequest', async (req, reply) => {
    reply.headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'" });
    const host = opts.publicHost();
    if (!host || req.headers.host !== host || Date.now() >= opts.expiresAt) return reply.code(403).send({ error: 'connection unavailable' });
    const origin = `https://${host}`;
    if ((req.headers.origin && req.headers.origin !== origin)
      || (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin)) {
      return reply.code(403).send({ error: 'same-origin requests only' });
    }
    let path: string;
    try { path = decodeURIComponent(new URL(req.url, origin).pathname); }
    catch { return reply.code(400).send({ error: 'invalid path' }); }
    // Tunnel controls are available only at the computer. Never forward them, including encoded paths.
    if (/^\/api\/mobile(?:\/|$)/i.test(path)) return reply.code(403).send({ error: 'manage this connection on the computer' });
    if (path === '/mobile-login' && req.method === 'POST') return;
    if (path === '/mobile-login.js' && req.method === 'GET') return;
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
    if (!secureEqual(cookie, opts.session)) {
      if (req.method === 'GET' && !path.startsWith('/api/')) return reply.type('text/html').send(loginHtml);
      return reply.code(401).send({ error: 'יש להתחבר עם קוד הגישה שמופיע במחשב' });
    }
    if (opts.quickTunnel && path.startsWith('/api/agent')) return reply.code(409).send({ error: 'הצ׳אט דורש Named Tunnel; חיבור זמני של Cloudflare אינו תומך ב־SSE' });
  });
  app.post('/mobile-login', async (req, reply) => {
    if (failedAttempts >= MAX_FAILED_ATTEMPTS) return reply.code(429).send({ error: 'יותר מדי קודים שגויים. נתקו את חיבור הנייד במחשב והפעילו אותו מחדש לקבלת קוד חדש.' });
    if (Date.now() - windowStart >= 60_000) { attempts = 0; windowStart = Date.now(); }
    if (++attempts > 5) return reply.code(429).send({ error: 'יותר מדי ניסיונות. נסו שוב בעוד דקה.' });
    const code = (req.body as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !secureEqual(code, opts.code)) {
      failedAttempts++;
      return reply.code(401).send({ error: 'קוד שגוי. הזינו את 6 הספרות שמופיעות במחשב.' });
    }
    reply.header('set-cookie', `${COOKIE}=${opts.session}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor((opts.expiresAt - Date.now()) / 1000))}`);
    return { ok: true };
  });
  app.get('/mobile-login.js', async (_req, reply) => reply.type('application/javascript').send(loginScript));
  // Keep upload bytes intact; the gateway does not interpret household API payloads.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (req.url.split('?')[0] === '/mobile-login') {
      try { done(null, JSON.parse(String(body))); } catch { done(Object.assign(new Error('invalid JSON'), { statusCode: 400 })); }
    } else done(null, Buffer.from(body));
  });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  app.all('/*', async (req, reply) => {
    const port = opts.targetPort;
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    // Drop external Host, Origin, forwarding headers and the gateway's session cookie.
    for (const key of ['content-type', 'accept', 'range', 'if-none-match']) {
      const value = req.headers[key];
      if (typeof value === 'string') headers[key] = value;
    }
    const body = Buffer.isBuffer(req.body) ? req.body : undefined;
    if (body) headers['content-length'] = String(body.length);
    const upstream = request({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers });
    const response = new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      upstream.once('response', resolve);
      upstream.once('error', reject);
    });
    reply.raw.once('close', () => upstream.destroy());
    upstream.end(body);
    try {
      const res = await response;
      reply.code(res.statusCode ?? 502);
      for (const [key, value] of Object.entries(res.headers)) {
        if (value != null && !['connection', 'transfer-encoding', 'set-cookie', 'cache-control'].includes(key)) reply.header(key, value);
      }
      return reply.send(res);
    } catch {
      return reply.code(502).send({ error: 'המחשב אינו זמין' });
    }
  });
  return app;
}

export interface MobileState {
  status: 'off' | 'starting' | 'ready' | 'failed';
  url: string | null;
  code: string | null;
  expiresAt: string | null;
  error: string | null;
  quickTunnel: boolean;
}

export class MobileConnection {
  private state: MobileState = { status: 'off', url: null, code: null, expiresAt: null, error: null, quickTunnel: true };
  private gateway: FastifyInstance | null = null;
  private child: ChildProcess | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }
  getState = () => ({ ...this.state });

  stop(): Promise<void> { return this.enqueue(() => this.stopInternal()); }
  private async stopInternal(): Promise<void> {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child?.kill();
    this.child = null;
    const gateway = this.gateway;
    this.gateway = null;
    this.state = { status: 'off', url: null, code: null, expiresAt: null, error: null, quickTunnel: true };
    // Revoke credentials before waiting for active HTTP requests to finish.
    if (gateway) { gateway.server.closeAllConnections(); await gateway.close(); }
  }

  start(targetPort: number, webDist?: string): Promise<MobileState> {
    return this.enqueue(() => this.startInternal(targetPort, webDist));
  }
  private async startInternal(targetPort: number, webDist?: string): Promise<MobileState> {
    if (this.state.status === 'starting' || this.state.status === 'ready') return this.getState();
    if (!webDist || !existsSync(webDist)) throw Object.assign(new Error('לחיבור נייד נדרשת גרסת web בנויה; הריצו npm run mobile או השתמשו באפליקציית הדסקטופ'), { statusCode: 400 });
    await this.stopInternal();
    const token = process.env.CLOUDFLARED_TUNNEL_TOKEN;
    const configuredUrl = process.env.MOBILE_PUBLIC_URL;
    if (token && (!configuredUrl || !/^https:\/\/[a-z0-9.-]+\/?$/i.test(configuredUrl))) {
      throw Object.assign(new Error('Named Tunnel requires MOBILE_PUBLIC_URL=https://your-domain'), { statusCode: 400 });
    }
    const expiresAt = Date.now() + SESSION_MS;
    this.state = { status: 'starting', url: token ? configuredUrl!.replace(/\/$/, '') : null,
      code: String(randomInt(100000, 1000000)), expiresAt: new Date(expiresAt).toISOString(), error: null, quickTunnel: !token };
    this.gateway = buildMobileGateway({ targetPort, publicHost: () => this.state.url ? new URL(this.state.url).host : null,
      code: this.state.code!, session: randomBytes(32).toString('base64url'), expiresAt, quickTunnel: !token });
    try {
      const port = token ? Number(process.env.MOBILE_GATEWAY_PORT ?? 4311) : 0;
      if (!Number.isInteger(port) || port < 0 || port > 65535 || (token && port === 0)) throw new Error('invalid MOBILE_GATEWAY_PORT');
      await this.gateway.listen({ host: '127.0.0.1', port });
      const address = this.gateway.server.address();
      if (!address || typeof address === 'string') throw new Error('gateway did not start');
      // A remotely managed Named Tunnel must route to MOBILE_GATEWAY_PORT (see docs/mobile.md).
      const args = token
        ? ['tunnel', '--no-autoupdate', 'run']
        : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${address.port}`];
      const child = spawn(process.env.CLOUDFLARED_PATH || 'cloudflared', args, {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(token ? { TUNNEL_TOKEN: token } : {}) },
      });
      this.child = child;
      let tail = '';
      const read = (data: Buffer) => {
        if (this.child !== child) return;
        tail = (tail + data.toString()).slice(-8192);
        const url = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0];
        if (url && !token) { this.state.url = url; this.state.status = 'ready'; }
        if (token && /Registered tunnel connection/.test(tail)) this.state.status = 'ready';
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      const failed = (error: string) => {
        if (this.child !== child) return;
        void this.enqueue(async () => {
          if (this.child !== child) return;
          await this.stopInternal();
          this.state.status = 'failed'; this.state.error = error;
        });
      };
      child.once('error', () => failed('לא ניתן להפעיל cloudflared. התקינו אותו במחשב או הגדירו CLOUDFLARED_PATH.'));
      child.once('exit', () => failed('חיבור cloudflared נסגר. אפשר להתחבר שוב.'));
      this.readyTimer = setTimeout(() => { if (this.state.status === 'starting') failed('לא התקבלה כתובת מ־cloudflared. בדקו את החיבור לרשת ואת הגדרות ה־Tunnel.'); }, 60_000);
      this.readyTimer.unref();
      this.timer = setTimeout(() => { void this.stop(); }, SESSION_MS);
      this.timer.unref();
    } catch (err) {
      await this.stopInternal();
      throw err;
    }
    return this.getState();
  }
}

export function mobileRoutes(app: FastifyInstance, webDist?: string): void {
  const connection = new MobileConnection();
  app.get('/api/mobile', async () => connection.getState());
  app.post('/api/mobile/start', async () => {
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server is not listening');
    return connection.start(address.port, webDist);
  });
  app.post('/api/mobile/stop', async () => { await connection.stop(); return connection.getState(); });
  app.addHook('onClose', async () => { await connection.stop(); });
}
