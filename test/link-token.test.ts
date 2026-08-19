import { describe, expect, it } from 'vitest';
import { emailViewHandler } from '../src/handler/fetch';
import { signMailToken, verifyMailToken } from '../src/mail/link-token';
import type { EmailCache, Environment } from '../src/types';

class FakeKV {
  private store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
}

const SECRET = 'test-secret';
const mail: EmailCache = {
  id: '11111111-2222-3333-4444-555555555555',
  messageId: '<x@y>',
  from: 'a@b.c',
  to: 'd@e.f',
  subject: 'OTP inside',
  text: 'Your code is 123456',
};

function makeEnv(secret?: string): Environment {
  return {
    DB: new FakeKV() as unknown as Environment['DB'],
    LINK_TOKEN_SECRET: secret,
  };
}

async function seed(env: Environment) {
  await env.DB.put(`Mail:${mail.id}`, JSON.stringify(mail));
}

describe('link-token sign/verify', () => {
  it('round-trips a valid token', async () => {
    const token = await signMailToken(SECRET, mail.id);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyMailToken(SECRET, mail.id, token)).toBe(true);
  });

  it('rejects a token signed for another mail id', async () => {
    const token = await signMailToken(SECRET, 'other-id');
    expect(await verifyMailToken(SECRET, mail.id, token)).toBe(false);
  });

  it('rejects wrong secret / missing token', async () => {
    const token = await signMailToken(SECRET, mail.id);
    expect(await verifyMailToken('other-secret', mail.id, token)).toBe(false);
    expect(await verifyMailToken(SECRET, mail.id, null)).toBe(false);
    expect(await verifyMailToken(SECRET, mail.id, '')).toBe(false);
  });
});

describe('signed-link gate on /email/:id', () => {
  it('404s a valid mail id when the secret is set but no token is given', async () => {
    const env = makeEnv(SECRET);
    await seed(env);
    const res = await emailViewHandler(new Request(`http://x/email/${mail.id}?mode=text`), env, mail.id);
    expect(res.status).toBe(404);
  });

  it('404s a wrong token, 200s a correct token', async () => {
    const env = makeEnv(SECRET);
    await seed(env);
    const bad = await emailViewHandler(new Request(`http://x/email/${mail.id}?t=${'0'.repeat(64)}`), env, mail.id);
    expect(bad.status).toBe(404);

    const token = await signMailToken(SECRET, mail.id);
    const good = await emailViewHandler(new Request(`http://x/email/${mail.id}?t=${token}`), env, mail.id);
    expect(good.status).toBe(200);
    expect(await good.text()).toContain('123456');
  });

  it('preview mode-switch links keep the token', async () => {
    const env = makeEnv(SECRET);
    await seed(env);
    const token = await signMailToken(SECRET, mail.id);
    const res = await emailViewHandler(
      new Request(`http://x/email/${mail.id}?mode=preview&t=${token}`),
      env,
      mail.id,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`?mode=text&t=${token}`);
  });

  it('stays open when no secret is configured (back-compat)', async () => {
    const env = makeEnv(undefined);
    await seed(env);
    const res = await emailViewHandler(new Request(`http://x/email/${mail.id}?mode=text`), env, mail.id);
    expect(res.status).toBe(200);
  });
});
