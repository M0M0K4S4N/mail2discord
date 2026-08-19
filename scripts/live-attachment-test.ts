// Live attachment test: runs the real emailHandler + emailViewHandler against a real Discord webhook.
// Usage: TEST_WEBHOOK_URL=... node build/live-attachment-test.js
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import type { Environment } from '../src/types';
import { emailHandler } from '../src/handler/mail';
import { emailViewHandler } from '../src/handler/fetch';

const WEBHOOK_URL = process.env.TEST_WEBHOOK_URL as string;
const UPLOAD = process.env.UPLOAD === '1';

class MemKV {
  private store = new Map<string, { value: string | ArrayBuffer; expiresAt?: number }>();
  async get(key: string, type?: string) {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt && e.expiresAt < Date.now()) return null;
    return e.value;
  }
  async put(key: string, value: string | ArrayBuffer, opts?: { expirationTtl?: number }) {
    this.store.set(key, {
      value,
      expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
    });
  }
  dump() {
    return [...this.store.keys()] as string[];
  }
}

// A tiny valid PDF (smallest recognizable PDF stub) and a text file
const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xc7, 0xec, 0x8f, 0xa2, 0x0a,
]);
const TXT_BYTES = new TextEncoder().encode('plain attachment file — hello from live test\n');

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

const MIME = [
  'Return-Path: <noreply@example.com>',
  'From: Test Sender <noreply@example.com>',
  'To: test-inbox@mail2discord.local',
  'Subject: [mail2discord] Attachment live test 📎',
  'Date: Wed, 19 Aug 2026 21:00:00 +0700',
  'Message-ID: <live-att-test-001@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="OUTER"',
  '',
  '--OUTER',
  'Content-Type: multipart/alternative; boundary="INNER"',
  '',
  '--INNER',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'อีเมลทดสอบไฟล์แนบค่ะ — PDF + TXT + inline pixel',
  '',
  'Flow: parse -> KV (Mail + Att keys) -> Discord webhook + download link',
  '--INNER',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><h1>Attachment Live Test</h1><p>ไฟล์แนบ 2 ไฟล์ + tracking pixel 1 อัน</p></body></html>',
  '--INNER--',
  '--OUTER',
  'Content-Type: application/pdf; name="document.pdf"',
  'Content-Disposition: attachment; filename="document.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(PDF_BYTES),
  '--OUTER',
  'Content-Type: text/plain; name="notes.txt"',
  'Content-Disposition: attachment; filename="notes.txt"',
  'Content-Transfer-Encoding: base64',
  '',
  b64(TXT_BYTES),
  '--OUTER',
  'Content-Type: image/png',
  'Content-Disposition: inline',
  'Content-ID: <pixel>',
  'Content-Transfer-Encoding: base64',
  '',
  b64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  '--OUTER--',
  '',
].join('\r\n');

async function main() {
  if (!WEBHOOK_URL) {
    console.error('Set TEST_WEBHOOK_URL=<your discord webhook>');
    process.exit(1);
  }
  const kv = new MemKV();
  const env = {
    DISCORD_WEBHOOK_URL: WEBHOOK_URL,
    DISCORD_UPLOAD_ATTACHMENTS: UPLOAD ? 'true' : undefined,
    DOMAIN: 'mail2discord.test.workers.dev',
    MAIL_TTL: '3600',
    DB: kv,
  };

  const encoder = new TextEncoder();
  const message = {
    from: 'noreply@example.com',
    to: 'test-inbox@mail2discord.local',
    headers: new Headers({
      'Message-ID': '<live-att-test-001@example.com>',
      Subject: '[mail2discord] Attachment live test',
    }),
    rawSize: MIME.length,
    raw: new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(MIME));
        c.close();
      },
    }),
    forward: async (_addr: string) => {},
    setReject: (_reason: string) => {},
  };
  const typedMessage = message as unknown as ForwardableEmailMessage;
  const typedEnv = env as unknown as Environment;

  console.log(`[1] emailHandler (upload=${UPLOAD})...`);
  await emailHandler(typedMessage, typedEnv);

  const mailKey = kv.dump().find((k: string) => k.startsWith('Mail:'));
  if (!mailKey) {
    console.error('FAILED: no mail cached');
    process.exit(1);
  }
  const mailId = mailKey.slice('Mail:'.length);
  const cached = JSON.parse((await kv.get(mailKey)) as string);
  console.log('[2] mail id:', mailId);
  console.log('[3] attachments meta:', JSON.stringify(cached.attachments, null, 2));
  console.log('[4] skipped:', JSON.stringify(cached.skippedAttachments, null, 2));

  const attKeys = kv.dump().filter((k: string) => k.startsWith('Att:'));
  console.log('[5] Att keys:', attKeys);

  // exercise the download route against the real handler
  for (const i of [0, 1]) {
    const res = await emailViewHandler(new Request(`http://x/email/${mailId}?att=${i}`), typedEnv, mailId);
    const body = new Uint8Array(await res.arrayBuffer());
    const expected = i === 0 ? PDF_BYTES : TXT_BYTES;
    const ok = body.length === expected.length && body.every((v, idx) => v === expected[idx]);
    console.log(`[6.${i}] GET ?att=${i} -> ${res.status} ${res.headers.get('content-disposition')} bytes=${body.length} match=${ok}`);
  }

  // preview page lists links
  const preview = await emailViewHandler(new Request(`http://x/email/${mailId}?mode=preview`), typedEnv, mailId);
  const html = await preview.text();
  console.log('[7] preview lists att links:', html.includes('?att=0') && html.includes('?att=1'));
  console.log('[7b] preview lists skipped:', html.includes('pixel.png') || html.includes('Skipped'));

  console.log('DONE');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
