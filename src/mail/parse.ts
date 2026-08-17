import type { RawEmail } from 'postal-mime';
import type { EmailCache, MaxEmailSizePolicy } from '../types';
import { convert } from 'html-to-text';
import PostalMime from 'postal-mime';

export interface ParsedEmailInput {
  raw: ReadableStream<Uint8Array> | null;
  rawSize?: number;
  headers: { get(name: string): string | null };
  from: string;
  to: string;
}

function truncateStream(stream: ReadableStream<Uint8Array>, maxBytes: number): ReadableStream<Uint8Array> {
  let bytesRead = 0;
  const tran = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
      if (bytesRead >= maxBytes) {
        controller.terminate();
        return;
      }
      const remainingBytes = maxBytes - bytesRead;
      if (chunk.length <= remainingBytes) {
        controller.enqueue(chunk);
        bytesRead += chunk.length;
      } else {
        const limitedChunk = chunk.slice(0, remainingBytes);
        controller.enqueue(limitedChunk);
        bytesRead += maxBytes;
        controller.terminate();
      }
    },
  });
  return stream.pipeThrough(tran);
}

export async function parseEmail(
  message: ParsedEmailInput,
  maxSize: number,
  maxSizePolicy: MaxEmailSizePolicy,
): Promise<EmailCache> {
  const id = crypto.randomUUID();
  const cache: EmailCache = {
    id,
    messageId: message.headers.get('Message-ID')?.trim() || id,
    from: message.from,
    to: message.to,
    subject: message.headers.get('Subject') || '',
  };
  let isTruncate = false;
  let emailRaw: ReadableStream<Uint8Array> | null = message.raw;
  try {
    if (message.rawSize === undefined || message.rawSize > maxSize) {
      switch (maxSizePolicy) {
        case 'unhandled':
          cache.text = `The original size of the email was ${message.rawSize} bytes, which exceeds the maximum size of ${maxSize} bytes.`;
          cache.html = cache.text;
          return cache;
        case 'truncate':
          isTruncate = true;
          if (emailRaw) {
            emailRaw = truncateStream(emailRaw, maxSize);
          }
          break;
        default:
          break;
      }
    }
    if (!emailRaw) {
      cache.text = 'No raw content available.';
      cache.html = undefined;
      return cache;
    }
    const parser = new PostalMime();
    const email = await parser.parse(emailRaw as unknown as RawEmail);
    cache.subject = email.subject || cache.subject;
    cache.html = email.html || undefined;
    cache.text = email.text || undefined;
    if (cache.html && !cache.text) {
      cache.text = convert(cache.html, {});
    }
    if (isTruncate) {
      cache.text = `${cache.text || ''}\n\n[Truncated] The original size of the email was ${message.rawSize} bytes, which exceeds the maximum size of ${maxSize} bytes.`;
    }
  } catch (e) {
    const msg = `Error parsing email: ${(e as Error).message}`;
    cache.text = msg;
    cache.html = msg;
  }
  return cache;
}
