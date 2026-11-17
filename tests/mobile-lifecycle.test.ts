import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { MobileConnection } from '../src/server/mobile.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
const connections: MobileConnection[] = [];
afterEach(async () => { for (const c of connections.splice(0)) await c.stop(); vi.unstubAllEnvs(); mocks.spawn.mockReset(); });
function setup() {
  vi.stubEnv('CLOUDFLARED_TUNNEL_TOKEN', '');
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  mocks.spawn.mockReturnValue(child);
  const connection = new MobileConnection();
  connections.push(connection);
  return { child, connection };
}

describe('mobile connector lifecycle', () => {
  it('serializes concurrent starts, revokes on stop, and ignores output from a stopped process', async () => {
    const { child, connection } = setup();
    const [a, b] = await Promise.all([connection.start(4310, tmpdir()), connection.start(4310, tmpdir())]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(a.code).toBe(b.code);
    expect(a.code).toMatch(/^[1-9][0-9]{5}$/);
    expect(a.status).toBe('starting');
    child.stderr.write('https://synthetic-tunnel.trycloudflare.com');
    expect(connection.getState().status).toBe('ready');
    await connection.stop();
    expect(child.kill).toHaveBeenCalled();
    child.stderr.write('https://stale-tunnel.trycloudflare.com');
    expect(connection.getState()).toMatchObject({ status: 'off', code: null, url: null });
  });

  it('clears codes and closes the gateway if cloudflared is unavailable', async () => {
    const { child, connection } = setup();
    await connection.start(4310, tmpdir());
    child.emit('error', new Error('ENOENT'));
    await vi.waitFor(() => expect(connection.getState().status).toBe('failed'));
    expect(connection.getState()).toMatchObject({ code: null, url: null });
  });

  it('requires a built UI and validates Named Tunnel configuration before spawning', async () => {
    const { connection } = setup();
    await expect(connection.start(4310)).rejects.toThrow('web');
    vi.stubEnv('CLOUDFLARED_TUNNEL_TOKEN', 'synthetic-token');
    vi.stubEnv('MOBILE_PUBLIC_URL', 'http://insecure.example');
    await expect(connection.start(4310, tmpdir())).rejects.toThrow('MOBILE_PUBLIC_URL');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
