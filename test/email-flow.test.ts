import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailHandler } from '../src/handler/mail';
import type { Environment } from '../src/types';

class FakeKV {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
    });
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}

function makeMessage(mime: string): Parameters<typeof emailHandler>[0] {
  const encoder = new TextEncoder();
  const forwarded: string[] = [];
  let rejected = false;
  return {
    from: 'sender@example.com',
    to: 'inbox@mydomain.com',
    headers: new Headers({
      'Message-ID': '<test-123@example.com>',
      Subject: 'Hello from the test',
    }),
    rawSize: mime.length,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(mime));
        controller.close();
      },
    }),
    // ForwardableEmailMessage extras
    forward: async (addr: string) => {
      forwarded.push(addr);
    },
    setReject: (_reason: string) => {
      rejected = true;
    },
    __forwarded: forwarded,
    __rejected: rejected,
  } as unknown as Parameters<typeof emailHandler>[0];
}

const MIME = [
  'From: Sender <sender@example.com>',
  'To: inbox@mydomain.com',
  'Subject: Hello from the test',
  'Message-ID: <test-123@example.com>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'This is the plain text body. สวัสดีค่ะ',
  'Second line here.',
  '',
].join('\r\n');

describe('emailHandler flow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses the email, caches it, and sends a Discord notification', async () => {
    const kv = new FakeKV();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '999000111' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env: Environment = {
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
      DOMAIN: 'mail2discord.test.workers.dev',
      MAIL_TTL: '3600',
      DB: kv as unknown as KVNamespace,
    };

    const msg = makeMessage(MIME);
    await emailHandler(msg, env);

    // Discord webhook called once, with wait=true
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/webhooks/123/abc?wait=true');
    const payload = JSON.parse(init.body as string);
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0].title).toBe('Hello from the test');
    expect(payload.embeds[0].fields[0].value).toContain('sender@example.com');

    // Buttons: Preview (webhook mode has no DISCORD_TOKEN → URL buttons only) + Text
    const buttons = payload.components[0].components;
    const labels = buttons.map((b: { label: string }) => b.label);
    expect(labels).toContain('Text');
    expect(labels).not.toContain('Preview'); // interactive buttons need a bot token

    // KV cache written: Mail:<uuid> and MsgID2MailID:<discord id>
    const mailKey = kv.keys().find(k => k.startsWith('Mail:'));
    expect(mailKey).toBeTruthy();
    const cached = JSON.parse((await kv.get(mailKey!)) as string);
    expect(cached.text).toContain('plain text body');
    expect(cached.text).toContain('สวัสดี');
    expect(await kv.get('MsgID2MailID:999000111')).toBeTruthy();
  });

  it('rejects blocked senders when BLOCK_POLICY=reject', async () => {
    const kv = new FakeKV();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const env: Environment = {
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
      BLOCK_LIST: '[".*@spam\\\\.io"]',
      BLOCK_POLICY: 'reject',
      DISABLE_LOAD_REGEX_FROM_DB: 'true',
      DB: kv as unknown as KVNamespace,
    };

    const msg = makeMessage(MIME.replace('sender@example.com', 'evil@spam.io').replace('Subject: Hello from the test', 'Subject: Spammy'));
    // keep from/to consistent with headers for the check
    (msg as unknown as { from: string }).from = 'evil@spam.io';
    await emailHandler(msg, env);

    expect((msg as unknown as { setReject: (r: string) => void }).setReject).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(kv.keys().filter(k => k.startsWith('Mail:'))).toHaveLength(0);
  });

  it('forwards a copy to FORWARD_LIST backup addresses', async () => {
    const kv = new FakeKV();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '1' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env: Environment = {
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
      FORWARD_LIST: 'backup@other.com',
      DB: kv as unknown as KVNamespace,
    };

    const msg = makeMessage(MIME);
    const forwardSpy = vi.fn();
    (msg as unknown as { forward: (a: string) => Promise<void> }).forward = forwardSpy;
    await emailHandler(msg, env);

    expect(forwardSpy).toHaveBeenCalledWith('backup@other.com');
  });
});
