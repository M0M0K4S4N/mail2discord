import type { Ai, KVNamespace } from '@cloudflare/workers-types';

export interface EmailHandleStatus {
  discord: boolean;
  forward: string[];
}

export interface EmailCache {
  id: string;
  messageId: string;
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
  /** Attachment metadata (content stored separately in KV) */
  attachments?: EmailAttachmentMeta[];
  /** Attachments that were deliberately not stored, with the reason */
  skippedAttachments?: SkippedAttachment[];
  /** True when the raw email exceeded MAX_EMAIL_SIZE and was truncated */
  truncated?: boolean;
}

export interface EmailAttachmentMeta {
  filename: string;
  mimeType: string;
  disposition: 'attachment' | 'inline' | null;
  size: number;
  /** Content-ID of an inline part, without angle brackets */
  contentId?: string;
}

export interface StoredAttachment extends EmailAttachmentMeta {
  /** Index into EmailCache.attachments — used as the KV/download key */
  index: number;
  content: ArrayBuffer;
}

export interface SkippedAttachment extends EmailAttachmentMeta {
  reason: 'inline' | 'too_large' | 'too_many' | 'empty';
}

export type MaxEmailSizePolicy = 'unhandled' | 'continue' | 'truncate';

export type BlockPolicy = 'reject' | 'forward' | 'discord';

export interface Environment {
  /** Discord Bot Token (required in bot mode), e.g. MTE3... */
  DISCORD_TOKEN?: string;
  /** Comma-separated channel/webhook IDs to send notifications to (bot mode) */
  DISCORD_CHANNEL_ID?: string;
  /** Discord Webhook URL (simplified mode). When set, bot mode is skipped. */
  DISCORD_WEBHOOK_URL?: string;
  /** Public key of the Discord application, for verifying interaction signatures */
  DISCORD_PUBLIC_KEY?: string;
  /** Shared secret required to call /init (bot mode). /init is disabled when unset */
  INIT_SECRET?: string;
  /** Comma-separated backup email addresses to forward raw mail to */
  FORWARD_LIST?: string;
  /** Sender block list: JSON array string of addresses or regex patterns */
  BLOCK_LIST?: string;
  /** Sender white list: JSON array string of addresses or regex patterns */
  WHITE_LIST?: string;
  /** Set to 'true' to only use env lists (skip KV-stored lists) */
  DISABLE_LOAD_REGEX_FROM_DB?: string;
  /** Comma-separated actions for blocked mail: reject,forward,discord. Default: discord */
  BLOCK_POLICY?: string;
  /** Mail cache TTL in seconds. Default: 1 day */
  MAIL_TTL?: string;
  /** Show the email body directly in the Discord embed. Default: false */
  SHOW_BODY?: string;
  /** Max characters of the body to embed when SHOW_BODY is on. Default: 1000 */
  SHOW_BODY_MAX_CHARS?: string;
  /** Show a preview URL link (web reading page) in the embed for webhook mode. Default: false */
  SHOW_PREVIEW_URL?: string;
  /** Workers domain, e.g. project.account.workers.dev */
  DOMAIN?: string;
  /** Max email size in bytes. Default: 512*1024 */
  MAX_EMAIL_SIZE?: string;
  /** unhandled | truncate | continue. Default: truncate */
  MAX_EMAIL_SIZE_POLICY?: MaxEmailSizePolicy;
  /** Set 'false' to drop attachments entirely (metadata only). Default: true */
  ATTACHMENTS?: string;
  /** Max bytes per stored attachment. Default: 8 MiB */
  MAX_ATTACHMENT_SIZE?: string;
  /** Max number of stored attachments per mail. Default: 10 */
  MAX_ATTACHMENT_COUNT?: string;
  /** Set 'true' to upload attachments as Discord files alongside the notification. Default: false */
  DISCORD_UPLOAD_ATTACHMENTS?: string;
  /** OpenAI-compatible API key for email summarization */
  OPENAI_API_KEY?: string;
  /** Default: https://api.openai.com/v1/chat/completions */
  OPENAI_COMPLETIONS_API?: string;
  /** Default: gpt-4o-mini */
  OPENAI_CHAT_MODEL?: string;
  /** Workers AI model id; requires the AI binding */
  WORKERS_AI_MODEL?: string;
  /** Language for AI summary. Default: english */
  SUMMARY_TARGET_LANG?: string;
  /** Set 'true' to deduplicate retried email deliveries (uses more KV writes) */
  GUARDIAN_MODE?: string;
  /** Set 'true' to show a Debug button on notifications */
  DEBUG?: string;
  /** KV namespace binding — variable name must be DB */
  DB: KVNamespace;
  /** Workers AI binding (optional) */
  AI?: Ai;
}

export interface DiscordEmbedFooter {
  text: string;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  /** URL the embed title links to (e.g. the preview page) */
  url?: string;
  description?: string;
  color?: number;
  footer?: DiscordEmbedFooter;
  timestamp?: string;
  fields?: DiscordEmbedField[];
}

export interface DiscordComponent {
  type: number;
  style?: number;
  label?: string;
  custom_id?: string;
  url?: string;
  disabled?: boolean;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordComponent[];
}

export interface DiscordMessagePayload {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordActionRow[];
  username?: string;
  avatar_url?: string;
  allowed_mentions?: { parse: string[] };
  flags?: number;
}

export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number;
  data?: {
    id?: string;
    name?: string;
    options?: Array<{
      name: string;
      value?: string;
      options?: Array<{ name: string; value: string }>;
      type?: number;
    }>;
    custom_id?: string;
    component_type?: number;
  };
  message?: {
    id: string;
    embeds?: DiscordEmbed[];
  };
  token?: string;
  user?: { id: string; username: string };
  member?: { user?: { id: string; username: string } };
}
