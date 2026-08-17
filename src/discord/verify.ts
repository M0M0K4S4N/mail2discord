// Discord interaction signature verification (Ed25519) using WebCrypto.
// See: https://discord.com/developers/docs/interactions/receiving-and-responding#security-and-authorization

function hexToUint8(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hasDiscordCryptoKey(usable: unknown): usable is { verify: typeof crypto.subtle.verify } {
  return usable instanceof CryptoKey;
}

/** Verify a Discord interaction request signature. */
export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  if (!publicKeyHex || !signatureHex || !timestamp) {
    return false;
  }
  try {
    const keyData = hexToUint8(publicKeyHex);
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' },
      false,
      ['verify'],
    );
    if (!hasDiscordCryptoKey(key)) {
      return false;
    }
    const sig = hexToUint8(signatureHex);
    const data = new TextEncoder().encode(`${timestamp}${body}`);
    return await crypto.subtle.verify('NODE-ED25519', key, sig, data);
  } catch (e) {
    console.error('verifyDiscordSignature error:', e);
    return false;
  }
}
