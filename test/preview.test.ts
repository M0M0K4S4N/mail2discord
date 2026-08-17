import { describe, expect, it } from 'vitest';
import { emailViewHandler } from '../src/handler/fetch';
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

const mail: EmailCache = {
  id: '11111111-2222-3333-4444-555555555555',
  messageId: '<evil@x>',
  from: 'attacker@example.com',
  to: 'victim@my.domain',
  subject: 'Click <b>me</b> <script>alert(1)</script>',
  text: 'Hello\n\n<script>alert("xss")</script> & <img src=x onerror=alert(1)> "quoted"',
  html: '<html><body><script>alert(1)</script></body></html>',
};

const env: Environment = { DB: new FakeKV() as unknown as Environment['DB'] };

async function seed() {
  await env.DB.put(`Mail:${mail.id}`, JSON.stringify(mail));
}

describe('email view modes', () => {
  it('preview page renders headers and body with everything escaped', async () => {
    await seed();
    const res = await emailViewHandler(
      new Request(`http://x/email/${mail.id}?mode=preview`),
      env,
      mail.id,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    // subject escaped in title and h1
    expect(html).toContain('&lt;b&gt;me&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;');
    // body escaped — no live tags
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // meta present
    expect(html).toContain('attacker@example.com');
    // links to other modes
    expect(html).toContain('?mode=text');
    expect(html).toContain('?mode=html');
    // noindex
    expect(html).toContain('noindex');
  });

  it('returns 404 for an unknown mail id', async () => {
    const res = await emailViewHandler(
      new Request('http://x/email/99999999-9999-9999-9999-999999999999?mode=preview'),
      env,
      '99999999-9999-9999-9999-999999999999',
    );
    expect(res.status).toBe(404);
  });
});
