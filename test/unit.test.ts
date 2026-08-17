import { describe, expect, it } from 'vitest';
import { loadArrayFromRaw } from '../src/db';
import { testAddress } from '../src/mail/check';
import { codeBlock, summarizeProvider, trimToEmbedLimit } from '../src/mail/render';
import type { Environment } from '../src/types';

function makeEnv(overrides: Partial<Environment> = {}): Environment {
  const base: Environment = {
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/abc',
    DB: {} as KVNamespace,
  };
  return Object.assign(base, overrides);
}

describe('loadArrayFromRaw', () => {
  it('returns empty for null/undefined/empty string', () => {
    expect(loadArrayFromRaw(null)).toEqual([]);
    expect(loadArrayFromRaw(undefined)).toEqual([]);
    expect(loadArrayFromRaw('')).toEqual([]);
  });

  it('parses a valid JSON array', () => {
    expect(loadArrayFromRaw('["a@b.com","b@c.com"]')).toEqual(['a@b.com', 'b@c.com']);
  });

  it('returns empty for invalid JSON', () => {
    expect(loadArrayFromRaw('not json')).toEqual([]);
  });

  it('returns empty for non-array JSON', () => {
    expect(loadArrayFromRaw('{"a":1}')).toEqual([]);
  });

  it('filters non-string items', () => {
    expect(loadArrayFromRaw('["ok", 1, null, "fine"]')).toEqual(['ok', 'fine']);
  });
});

describe('testAddress', () => {
  it('matches exact address case-insensitively', () => {
    expect(testAddress('user@example.com', 'USER@example.com')).toBe(true);
  });

  it('matches via regex', () => {
    expect(testAddress('noreply@github.com', '.*@github\\.com')).toBe(true);
    expect(testAddress('spam@evil.io', 'spam@.*')).toBe(true);
  });

  it('returns false for invalid regex patterns', () => {
    expect(testAddress('user@example.com', '[invalid')).toBe(false);
  });
});

describe('summarizeProvider', () => {
  it('prefers workers-ai when both AI binding and model are set', () => {
    const env = makeEnv({ AI: {} as unknown as Ai, WORKERS_AI_MODEL: '@cf/meta/llama-3.1-8b-instruct' });
    expect(summarizeProvider(env)).toBe('workers-ai');
  });

  it('uses openai when only OPENAI_API_KEY is set', () => {
    const env = makeEnv({ OPENAI_API_KEY: 'sk-test' });
    expect(summarizeProvider(env)).toBe('openai');
  });

  it('returns null with no providers', () => {
    expect(summarizeProvider(makeEnv())).toBeNull();
  });
});

describe('trimToEmbedLimit', () => {
  it('keeps short text as-is', () => {
    expect(trimToEmbedLimit('short')).toBe('short');
  });

  it('trims long text and appends marker', () => {
    const long = 'x'.repeat(5000);
    const out = trimToEmbedLimit(long);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.endsWith('[...]')).toBe(true);
  });

  it('respects custom limit', () => {
    const out = trimToEmbedLimit('y'.repeat(100), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('[...]')).toBe(true);
  });
});

describe('codeBlock', () => {
  it('wraps short text in backticks', () => {
    expect(codeBlock('a@b.com')).toBe('`a@b.com`');
  });

  it('truncates long text with ellipsis', () => {
    const out = codeBlock('z'.repeat(150));
    expect(out.startsWith('`')).toBe(true);
    expect(out.endsWith('…`')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(103);
  });
});
