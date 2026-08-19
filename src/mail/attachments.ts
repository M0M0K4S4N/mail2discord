import type { Attachment } from 'postal-mime';
import type { EmailAttachmentMeta, SkippedAttachment, StoredAttachment } from '../types';

export const DEFAULT_MAX_ATTACHMENT_SIZE = 8 * 1024 * 1024;
export const DEFAULT_MAX_ATTACHMENT_COUNT = 10;

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/gzip': '.gz',
  'application/x-7z-compressed': '.7z',
  'application/vnd.rar': '.rar',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'message/rfc822': '.eml',
};

/** Normalize an attachment filename: fill in a fallback name and strip path/control chars. */
export function attachmentFilename(att: Attachment, fallbackIndex: number): string {
  let name = (att.filename || '').trim();
  if (!name) {
    const ext = EXT_BY_MIME[(att.mimeType || '').toLowerCase()] || '.bin';
    name = `attachment-${fallbackIndex + 1}${ext}`;
  }
  name = name.replace(/[\\/]/g, '_').replace(/[\r\n\0]/g, '');
  return name.slice(0, 150) || `attachment-${fallbackIndex + 1}.bin`;
}

/** Coerce postal-mime attachment content into a standalone ArrayBuffer. */
export function toBuffer(content: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content).slice().buffer as ArrayBuffer;
  }
  if (content instanceof Uint8Array) {
    const copy = new Uint8Array(content.byteLength);
    copy.set(content);
    return copy.buffer;
  }
  return content;
}

export interface ExtractedAttachments {
  stored: StoredAttachment[];
  skipped: SkippedAttachment[];
}

/**
 * Split parsed attachments into storable files (KV + Discord upload) and skipped
 * entries (kept as metadata so the notification can say what was left out).
 *
 * Inline / related parts are skipped: they are usually cid-referenced images in
 * the HTML body (and very often 1×1 tracking pixels) — noisy to upload and
 * useless to store, since the HTML view is rendered escaped/inert.
 */
export function extractAttachments(
  attachments: Attachment[],
  maxSize: number,
  maxCount: number,
): ExtractedAttachments {
  const stored: StoredAttachment[] = [];
  const skipped: SkippedAttachment[] = [];
  for (const att of attachments) {
    const filename = attachmentFilename(att, stored.length + skipped.length);
    const content = toBuffer(att.content);
    const meta: EmailAttachmentMeta = {
      filename,
      mimeType: att.mimeType || 'application/octet-stream',
      disposition: att.disposition,
      size: content.byteLength,
      contentId: att.contentId || undefined,
    };
    if (att.disposition === 'inline' || att.related) {
      skipped.push({ ...meta, reason: 'inline' });
      continue;
    }
    if (content.byteLength === 0) {
      skipped.push({ ...meta, reason: 'empty' });
      continue;
    }
    if (stored.length >= maxCount) {
      skipped.push({ ...meta, reason: 'too_many' });
      continue;
    }
    if (content.byteLength > maxSize) {
      skipped.push({ ...meta, reason: 'too_large' });
      continue;
    }
    stored.push({ ...meta, index: stored.length, content });
  }
  return { stored, skipped };
}

export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Make a filename safe to interpolate into Discord markdown (links, code
 * spans) — filenames come from the sender and are fully attacker-controlled.
 */
export function markdownSafeName(name: string): string {
  return name.replace(/[`*_~\\[\]()]/g, '_');
}
