import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailHandler } from '../src/handler/mail';
import { emailViewHandler } from '../src/handler/fetch';
import { extractAttachments, formatBytes, markdownSafeName, attachmentFilename } from '../src/mail/attachments';
import { buildMultipartBody } from '../src/discord/api';
import type { Attachment } from 'postal-mime';
import type { Environment } from '../src/types';

class FakeKV {
  private store = new Map<string, { value: string | ArrayBuffer; expiresAt?: number }>();

  async get(key: string, type?: string): Promise<string | ArrayBuffer | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      return null;
    }
    if (type === 'arrayBuffer') {
      return entry.value as ArrayBuffer;
    }
    return entry.value as string;
  }

  async put(key: string, value: string | ArrayBuffer, opts?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
    });
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
    disposition: 'attachment',
    related: false,
    content: new Uint8Array([1, 2, 3, 4]).buffer,
    ...overrides,
  };
}

function makeMessage(mime: string): Parameters<typeof emailHandler>[0] {
  const encoder = new TextEncoder();
  const forwarded: string[] = [];
  let rejected = false;
  return {
    from: 'sender@example.com',
    to: 'inbox@mydomain.com',
    headers: new Headers({
      'Message-ID': '<att-test-123@example.com>',
      Subject: 'Mail with attachments',
    }),
    rawSize: mime.length,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(mime));
        controller.close();
      },
    }),
    forward: async (_addr: string) => {
      forwarded.push(_addr);
    },
    setReject: (_reason: string) => {
      rejected = true;
    },
    __forwarded: forwarded,
    __rejected: rejected,
  } as unknown as Parameters<typeof emailHandler>[0];
}

// Base64 of "Hello attachment"
const FILE_B64 = 'SGVsbG8gYXR0YWNobWVudA==';

const MIME_WITH_ATTACHMENT = [
  'From: Sender <sender@example.com>',
  'To: inbox@mydomain.com',
  'Subject: Mail with attachments',
  'Message-ID: <att-test-123@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUND"',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Body text here.',
  '--BOUND',
  'Content-Type: application/pdf; name="invoice.pdf"',
  'Content-Disposition: attachment; filename="invoice.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  FILE_B64,
  '--BOUND--',
  '',
].join('\r\n');

describe('extractAttachments', () => {
  it('stores normal attachments with metadata', () => {
    const result = extractAttachments([makeAttachment()], 1024, 10);
    expect(result.stored).toHaveLength(1);
    expect(result.stored[0].filename).toBe('invoice.pdf');
    expect(result.stored[0].size).toBe(4);
    expect(result.skipped).toHaveLength(0);
  });

  it('skips inline / related parts (e.g. tracking pixels)', () => {
    const result = extractAttachments([
      makeAttachment({ disposition: 'inline', related: true, filename: 'pixel.png', mimeType: 'image/png', content: new Uint8Array([0]).buffer }),
    ], 1024, 10);
    expect(result.stored).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('inline');
  });

  it('skips attachments over maxSize', () => {
    const result = extractAttachments([makeAttachment({ content: new Uint8Array(2048).buffer })], 1024, 10);
    expect(result.stored).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('too_large');
  });

  it('skips beyond maxCount', () => {
    const atts = Array.from({ length: 12 }, (_, i) => makeAttachment({ filename: `file-${i}.bin` }));
    const result = extractAttachments(atts, 1024, 10);
    expect(result.stored).toHaveLength(10);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every(s => s.reason === 'too_many')).toBe(true);
  });

  it('skips empty attachments', () => {
    const result = extractAttachments([makeAttachment({ content: new ArrayBuffer(0) })], 1024, 10);
    expect(result.stored).toHaveLength(0);
    expect(result.skipped[0].reason).toBe('empty');
  });

  it('gives a fallback filename with extension from mime type', () => {
    const att = makeAttachment({ filename: null as unknown as string, mimeType: 'application/pdf' });
    expect(attachmentFilename(att, 0)).toBe('attachment-1.pdf');
  });

  it('sanitizes path separators and control characters in filenames', () => {
    const att = makeAttachment({ filename: '../evil\\name\n.pdf' });
    expect(attachmentFilename(att, 0)).toBe('.._evil_name.pdf');
  });
});

describe('formatBytes / markdownSafeName', () => {
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('escapes discord markdown characters', () => {
    expect(markdownSafeName('evil`_file[*]()~.pdf')).toBe('evil__file______.pdf');
  });
});

describe('multipart body', () => {
  it('appends payload_json and files', async () => {
    const form = buildMultipartBody(
      { content: 'hello' },
      [{ name: 'a.pdf', content: new Uint8Array([1, 2]).buffer, contentType: 'application/pdf' }],
    );
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('payload_json')).toBeTruthy();
    const parsed = JSON.parse(form.get('payload_json') as string);
    expect(parsed.content).toBe('hello');
    expect(form.get('files[0]')).toBeInstanceOf(Blob);
    const blob = form.get('files[0]') as Blob;
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBe(2);
  });
});

describe('emailHandler with attachments', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores attachments in KV and lists them in the embed', async () => {
    const kv = new FakeKV();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '888777' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env: Environment = {
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
      DOMAIN: 'mail2discord.test.workers.dev',
      MAIL_TTL: '3600',
      DB: kv as unknown as KVNamespace,
    };

    await emailHandler(makeMessage(MIME_WITH_ATTACHMENT), env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/webhooks/123/abc?wait=true');
    const payload = JSON.parse(init.body as string);
    const fields = payload.embeds[0].fields;
    const attField = fields.find((f: { name: string }) => f.name.includes('Attachments'));
    expect(attField).toBeTruthy();
    expect(attField.value).toContain('invoice.pdf');
    expect(attField.value).toContain('?att=0');

    // attachment content stored separately in KV
    const attKey = kv.keys().find(k => k.startsWith('Att:'));
    expect(attKey).toMatch(/^Att:[0-9a-f-]{36}:0$/);
  });

  it('uploads files to Discord when DISCORD_UPLOAD_ATTACHMENTS=true', async () => {
    const kv = new FakeKV();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '888778' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env: Environment = {
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
      DISCORD_UPLOAD_ATTACHMENTS: 'true',
      MAIL_TTL: '3600',
      DB: kv as unknown as KVNamespace,
    };

    await emailHandler(makeMessage(MIME_WITH_ATTACHMENT), env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/webhooks/123/abc?wait=true');
    // multipart body, not JSON
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get('payload_json')).toBeTruthy();
    expect(form.get('files[0]')).toBeInstanceOf(Blob);
    expect((form.get('files[0]') as Blob).size).toBeGreaterThan(0);
  });

  it('keeps metadata only when ATTACHMENTS=false', async () => {
    const kv = new FakeKV();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: '888779' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const env: Environment = {
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
      ATTACHMENTS: 'false',
      MAIL_TTL: '3600',
      DB: kv as unknown as KVNamespace,
    };

    await emailHandler(makeMessage(MIME_WITH_ATTACHMENT), env);

    // No Att: keys written
    expect(kv.keys().filter(k => k.startsWith('Att:'))).toHaveLength(0);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const payload = JSON.parse(init.body as string);
    expect(payload.embeds[0].fields.find((f: { name: string }) => f.name.includes('Attachments'))).toBeUndefined();
  });
});

describe('attachment download route', () => {
  const MAIL_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  async function seed(kv: FakeKV) {
    await kv.put(`Mail:${MAIL_ID}`, JSON.stringify({
      id: MAIL_ID,
      messageId: '<x>',
      from: 'a@b.c',
      to: 'd@e.f',
      subject: 'att',
      text: 'body',
      attachments: [{ filename: 'weird"name.bin', mimeType: 'application/octet-stream', disposition: 'attachment', size: 4 }],
    }));
    await kv.put(`Att:${MAIL_ID}:0`, new Uint8Array([9, 9, 9, 9]).buffer);
  }

  it('serves an attachment with safe download headers', async () => {
    const kv = new FakeKV();
    await seed(kv);
    const env: Environment = { DB: kv as unknown as KVNamespace };
    const res = await emailViewHandler(
      new Request(`http://x/email/${MAIL_ID}?att=0`),
      env,
      MAIL_ID,
    );
    expect(res.status).toBe(200);
    // quotes from the original name are stripped — only the HTTP quoted-string wrapper remains
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="weird_name.bin"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9, 9]));
  });

  it('404s for out-of-range or non-numeric att index', async () => {
    const kv = new FakeKV();
    await seed(kv);
    const env: Environment = { DB: kv as unknown as KVNamespace };
    for (const bad of ['5', '-1', 'abc', '']) {
      const res = await emailViewHandler(new Request(`http://x/email/${MAIL_ID}?att=${bad}`), env, MAIL_ID);
      expect(res.status).toBe(404);
    }
  });

  it('404s when the mail exists but attachment content is gone', async () => {
    const kv = new FakeKV();
    await kv.put(`Mail:${MAIL_ID}`, JSON.stringify({
      id: MAIL_ID,
      messageId: '<x>',
      from: 'a@b.c',
      to: 'd@e.f',
      subject: 'att',
      text: 'body',
      attachments: [{ filename: 'gone.bin', mimeType: 'application/octet-stream', disposition: 'attachment', size: 4 }],
    }));
    const env: Environment = { DB: kv as unknown as KVNamespace };
    const res = await emailViewHandler(new Request(`http://x/email/${MAIL_ID}?att=0`), env, MAIL_ID);
    expect(res.status).toBe(404);
  });

  it('lists attachment download links on the preview page', async () => {
    const kv = new FakeKV();
    await seed(kv);
    const env: Environment = { DB: kv as unknown as KVNamespace };
    const res = await emailViewHandler(new Request(`http://x/email/${MAIL_ID}?mode=preview`), env, MAIL_ID);
    const html = await res.text();
    expect(html).toContain('📎 Attachments');
    expect(html).toContain('?att=0');
    // filename escaped
    expect(html).not.toContain('<weird');
  });
});
