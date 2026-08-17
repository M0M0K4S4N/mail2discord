// Live webhook test: runs the real emailHandler pipeline against a real Discord webhook.
// Usage: node build/live-test.js
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import type { Environment } from '../src/types';
import { emailHandler } from '../src/handler/mail';

const WEBHOOK_URL = process.env.TEST_WEBHOOK_URL as string;

class MemKV {
  private store = new Map();
  async get(key: string) {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt && e.expiresAt < Date.now()) return null;
    return e.value as string;
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }) {
    this.store.set(key, {
      value,
      expiresAt: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined,
    });
  }
  dump() {
    return [...this.store.keys()] as string[];
  }
}

const MIME = [
  'Return-Path: <noreply@github.com>',
  'Received: from github.com (out-xx.github.com [1.2.3.4])',
  'From: GitHub <noreply@github.com>',
  'To: test-inbox@mail2discord.local',
  'Subject: [mail2discord] Live webhook test — ทดสอบส่งจริง 🚀',
  'Date: Mon, 17 Aug 2026 16:30:00 +0700',
  'Message-ID: <live-test-001@github.com>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="BOUND1"',
  '',
  '--BOUND1',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'นี่คือการทดสอบส่งอีเมลจริงผ่าน mail2discord pipeline',
  '',
  'Flow: Cloudflare Email Routing -> Worker (parse + KV cache) -> Discord webhook',
  '',
  'สวัสดีค่ะ — plain text part ค่ะ',
  '--BOUND1',
  'Content-Type: text/html; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<html><body>',
  '<h1>Live Test</h1>',
  '<p>นี่คือ <b>HTML part</b> ของอีเมลทดสอบค่ะ =E0=B9=84=E0=B8=97=E0=B8=A2</p>',
  '<ul><li>postal-mime ต้อง parse ผ่าน</li><li>render เป็น embed แล้วยิง webhook</li></ul>',
  '</body></html>',
  '--BOUND1--',
  '',
].join('\r\n');

async function main() {
  const kv = new MemKV();
  const env = {
    DISCORD_WEBHOOK_URL: WEBHOOK_URL,
    MAIL_TTL: '3600',
    SHOW_BODY: process.env.SHOW_BODY,
    SHOW_BODY_MAX_CHARS: process.env.SHOW_BODY_MAX_CHARS,
    DB: kv,
  };

  const encoder = new TextEncoder();
  let rejected: string | null = null;
  const forwards: string[] = [];
  const message = {
    from: 'noreply@github.com',
    to: 'test-inbox@mail2discord.local',
    headers: new Headers({
      'Message-ID': '<live-test-001@github.com>',
      Subject: '[mail2discord] Live webhook test',
    }),
    rawSize: MIME.length,
    raw: new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(MIME));
        c.close();
      },
    }),
    forward: async (addr: string) => forwards.push(addr),
    setReject: (reason: string) => {
      rejected = reason;
    },
  };
  const typedMessage = message as unknown as ForwardableEmailMessage;
  const typedEnv = env as unknown as Environment;

  console.log('[1] running emailHandler (real pipeline, real webhook)...');
  await emailHandler(typedMessage, typedEnv);

  console.log('[2] rejected:', rejected);
  console.log('[3] forwarded:', forwards);
  console.log('[4] KV keys:', kv.dump());
  const mailKey = kv.dump().find((k: string) => k.startsWith('Mail:'));
  if (mailKey) {
    const cached = JSON.parse((await kv.get(mailKey)) as string);
    console.log('[5] cached subject:', cached.subject);
    console.log('[6] cached text preview:', (cached.text || '').slice(0, 80).replace(/\n/g, ' ⏎ '));
    console.log('[7] cached html bytes:', (cached.html || '').length);
    console.log('[8] mail id:', cached.id);
  } else {
    console.log('[!] no mail cached — check handler logs above');
  }
  console.log('DONE');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
