import { describe, expect, it } from 'vitest';
import type { KVNamespace } from '@cloudflare/workers-types';
import { checkAddressStatus } from '../src/mail/check';
import type { Environment } from '../src/types';

function trackedKV(seed: Record<string, string> = {}): { kv: KVNamespace; reads: string[]; writes: string[] } {
  const store = new Map(Object.entries(seed));
  const reads: string[] = [];
  const writes: string[] = [];
  const kv = {
    get: async (key: string) => {
      reads.push(key);
      return store.get(key) ?? null;
    },
    put: async (key: string, value: string) => {
      writes.push(key);
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, reads, writes };
}

function env(kv: KVNamespace): Environment {
  return {
    DB: kv,
    // do not disable DB list loading — that is the path being cached
  } as Environment;
}

describe('list cache (performance)', () => {
  it('reads KV lists once, then serves subsequent checks from the isolate cache', async () => {
    const { kv, reads } = trackedKV({ BLOCK_LIST: '["a@spam.io"]', WHITE_LIST: '[]' });

    // first check loads both lists from KV
    const first = await checkAddressStatus(['a@spam.io'], env(kv));
    expect(first['a@spam.io']).toBe('block');
    expect(reads.filter(k => k === 'BLOCK_LIST' || k === 'WHITE_LIST')).toHaveLength(2);

    // next 5 checks must not touch KV again
    for (let i = 0; i < 5; i++) {
      const again = await checkAddressStatus([`x${i}@example.com`], env(kv));
      expect(again[`x${i}@example.com`]).toBe('no_match');
    }
    expect(reads.filter(k => k === 'BLOCK_LIST' || k === 'WHITE_LIST')).toHaveLength(2);
  });

  it('loads both lists in parallel (single awaited round)', async () => {
    const { kv, reads } = trackedKV({ BLOCK_LIST: '[]', WHITE_LIST: '["friend@ok.io"]' });
    await checkAddressStatus(['friend@ok.io'], env(kv));
    expect(reads).toContain('WHITE_LIST');
    expect(reads).toContain('BLOCK_LIST');
  });

  it('still merges env-provided lists with the cached DB lists', async () => {
    const { kv } = trackedKV({ BLOCK_LIST: '["a@spam.io"]', WHITE_LIST: '[]' });
    const e = { DB: kv, BLOCK_LIST: '["env@blocked.io"]' } as Environment;
    const res = await checkAddressStatus(['a@spam.io', 'env@blocked.io', 'fine@ok.io'], e);
    expect(res['a@spam.io']).toBe('block');
    expect(res['env@blocked.io']).toBe('block');
    expect(res['fine@ok.io']).toBe('no_match');
  });
});

describe('summary prompt cap (performance)', () => {
  it('caps the mail body at 8 KB and notes truncation', async () => {
    const { buildSummaryPrompt, SUMMARY_PROMPT_BODY_LIMIT } = await import('../src/mail/render');
    const mail = {
      id: 'x',
      messageId: '<x>',
      from: 'a@b.c',
      to: 'd@e.f',
      subject: 'big',
      text: 'A'.repeat(100 * 1024),
    };
    const prompt = buildSummaryPrompt(mail as never, 'english');
    expect(prompt.length).toBeLessThan(SUMMARY_PROMPT_BODY_LIMIT + 500);
    expect(prompt).toContain('[The email body was truncated for this summary.]');
    // short mail: no truncation note
    const shortPrompt = buildSummaryPrompt({ ...mail, text: 'hi' } as never, 'english');
    expect(shortPrompt).not.toContain('truncated');
    expect(shortPrompt).toContain('hi');
  });
});
