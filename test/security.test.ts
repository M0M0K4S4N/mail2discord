import { describe, expect, it } from 'vitest';
import { fetchHandler } from '../src/handler';
import type { Environment } from '../src/types';

const baseEnv: Environment = {
  DB: {} as Environment['DB'],
};

function ctxStub(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

describe('security hardening', () => {
  it('closes /discord entirely when no DISCORD_PUBLIC_KEY is set (webhook mode)', async () => {
    const res = await fetchHandler(
      new Request('http://x/discord', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 1 }),
      }),
      baseEnv,
      ctxStub(),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('DISCORD_PUBLIC_KEY') });
  });

  it('rejects /discord with an invalid signature when the public key is configured', async () => {
    const env: Environment = {
      ...baseEnv,
      DISCORD_PUBLIC_KEY: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
    };
    const res = await fetchHandler(
      new Request('http://x/discord', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-signature-ed25519': 'deadbeef',
          'x-signature-timestamp': '1',
        },
        body: JSON.stringify({ type: 1 }),
      }),
      env,
      ctxStub(),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'Invalid request signature' });
  });

  it('disables /init when INIT_SECRET is unset', async () => {
    const res = await fetchHandler(new Request('http://x/init'), baseEnv, ctxStub());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('INIT_SECRET') });
  });

  it('rejects /init with a wrong secret', async () => {
    const env: Environment = { ...baseEnv, INIT_SECRET: 's3cret', DISCORD_TOKEN: 'x' };
    const res = await fetchHandler(new Request('http://x/init?secret=nope'), env, ctxStub());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'Invalid secret' });
  });

  it('keeps /health open for monitoring', async () => {
    const res = await fetchHandler(new Request('http://x/health'), baseEnv, ctxStub());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
