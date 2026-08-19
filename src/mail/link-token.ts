// HMAC-signed links for /email/:id — when LINK_TOKEN_SECRET is set, every
// email URL carries ?t=<HMAC-SHA256(secret, mailId)> and requests without a
// valid token get 404. Prevents URL-guessing/leakage of OTP mails.

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison to avoid timing leaks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return hex(sig);
}

/** Sign a mail id into its link token. */
export function signMailToken(secret: string, mailId: string): Promise<string> {
  return hmacHex(secret, mailId);
}

/** Verify a ?t= token for a mail id. Null/empty tokens never match. */
export async function verifyMailToken(secret: string, mailId: string, token: string | null | undefined): Promise<boolean> {
  if (!secret || !token) {
    return false;
  }
  const expected = await hmacHex(secret, mailId);
  return timingSafeEqual(expected, token);
}
