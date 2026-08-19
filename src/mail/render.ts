import type { DiscordActionRow, DiscordEmbed, DiscordMessagePayload, EmailCache, Environment } from '../types';
import { EMBED_COLOR_MAIL } from '../discord/api';
import { checkAddressStatus } from './check';
import { summarizedByOpenAI, summarizedByWorkerAI } from './summarization';
import { signMailToken } from './link-token';

export const DISCORD_EMBED_LIMIT = 4096;

export function summarizeProvider(env: Environment): 'workers-ai' | 'openai' | null {
  const { AI, WORKERS_AI_MODEL, OPENAI_API_KEY } = env;
  if (AI && WORKERS_AI_MODEL) {
    return 'workers-ai';
  }
  if (OPENAI_API_KEY) {
    return 'openai';
  }
  return null;
}

/** Cap the mail body fed to the summary prompt — a 50-word summary does not
 *  need megabytes of text, and long prompts cost tokens and latency. */
export const SUMMARY_PROMPT_BODY_LIMIT = 8 * 1024;

export function buildSummaryPrompt(mail: EmailCache, targetLang: string): string {
  const body = (mail.text || mail.html || '').slice(0, SUMMARY_PROMPT_BODY_LIMIT);
  const truncated = (mail.text || mail.html || '').length > SUMMARY_PROMPT_BODY_LIMIT;
  return `Summarize the following email in approximately 50 words in ${targetLang}.\n\nFrom: ${mail.from}\nSubject: ${mail.subject}\n\n${body}${truncated ? '\n\n[The email body was truncated for this summary.]' : ''}`;
}

/** Trim text to fit a Discord embed description, appending an ellipsis marker. */
export function trimToEmbedLimit(text: string, limit: number = DISCORD_EMBED_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 15)}\n[...]`;
}

/** Build the /email/:id URL for a mail, signing it when LINK_TOKEN_SECRET is set. */
export async function buildMailLink(env: Environment, mailId: string, mode: string): Promise<string> {
  const { DOMAIN, LINK_TOKEN_SECRET } = env;
  const base = `https://${DOMAIN}/email/${mailId}?mode=${mode}`;
  if (!LINK_TOKEN_SECRET) {
    return base;
  }
  const token = await signMailToken(LINK_TOKEN_SECRET, mailId);
  return `${base}&t=${token}`;
}

/** Render the notification message (embed + buttons) for a parsed email. */
export async function renderEmailListMode(mail: EmailCache, env: Environment): Promise<DiscordMessagePayload> {
  const { DEBUG, DOMAIN } = env;
  // Interactive (custom_id) buttons only work when an application is behind the
  // message; in pure-webhook mode keep only the URL buttons.
  const interactive = !!env.DISCORD_TOKEN;
  const embed: DiscordEmbed = {
    title: mail.subject || '(no subject)',
    color: EMBED_COLOR_MAIL,
    fields: [
      { name: 'From', value: codeBlock(mail.from), inline: true },
      { name: 'To', value: codeBlock(mail.to), inline: true },
    ],
    footer: { text: `Message-ID: ${mail.messageId.slice(0, 64)}` },
  };

  // Optional: inline body preview in the embed itself
  if (env.SHOW_BODY === 'true') {
    const maxChars = Math.max(100, Math.min(Number.parseInt(env.SHOW_BODY_MAX_CHARS || '', 10) || 1000, DISCORD_EMBED_LIMIT));
    const body = (mail.text || '').trim();
    if (body) {
      embed.description = body.length > maxChars
        ? `${body.slice(0, maxChars)}\n[…] truncated — use Text/Preview for the full mail`
        : body;
    }
  }

  const buttons: DiscordActionRow['components'] = [];
  if (interactive) {
    buttons.push({ type: 2, style: 1, label: 'Preview', custom_id: `p:${mail.id}` });
    if (summarizeProvider(env)) {
      buttons.push({ type: 2, style: 1, label: 'Summary', custom_id: `s:${mail.id}` });
    }
  }
  // Optional: preview URL as a plain link in the embed (webhook mode — no button needed)
  if (!interactive && env.SHOW_PREVIEW_URL === 'true' && DOMAIN) {
    embed.url = await buildMailLink(env, mail.id, 'preview');
    embed.fields!.push({ name: 'Preview', value: `[Open in browser ↗](${embed.url})` });
  }
  if (mail.text && DOMAIN) {
    buttons.push({ type: 2, style: 5, label: 'Text', url: await buildMailLink(env, mail.id, 'text') });
  }
  if (mail.html && DOMAIN) {
    buttons.push({ type: 2, style: 5, label: 'HTML', url: await buildMailLink(env, mail.id, 'html') });
  }
  if (interactive && DEBUG === 'true') {
    buttons.push({ type: 2, style: 2, label: 'Debug', custom_id: `d:${mail.id}` });
  }
  // Discord allows at most 5 buttons per action row
  const row: DiscordActionRow[] = buttons.length ? [{ type: 1, components: buttons.slice(0, 5) }] : [];

  return {
    embeds: [embed],
    components: row,
    allowed_mentions: { parse: [] },
  };
}

/** Render the preview (plain text, embed-limited) view. */
export function renderEmailPreviewMode(mail: EmailCache): DiscordMessagePayload {
  return renderEmailDetail(mail.text || 'No content', mail.id);
}

function renderEmailDetail(text: string, id: string): DiscordMessagePayload {
  return {
    embeds: [{
      color: EMBED_COLOR_MAIL,
      description: trimToEmbedLimit(text),
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 2, label: 'Back', custom_id: `l:${id}` },
        { type: 2, style: 4, label: 'Delete', custom_id: 'delete' },
      ],
    }],
    allowed_mentions: { parse: [] },
  };
}

/** Render the AI summary view. */
export async function renderEmailSummaryMode(mail: EmailCache, env: Environment): Promise<DiscordMessagePayload> {
  const {
    AI,
    OPENAI_API_KEY,
    WORKERS_AI_MODEL,
    OPENAI_COMPLETIONS_API = 'https://api.openai.com/v1/chat/completions',
    OPENAI_CHAT_MODEL = 'gpt-4o-mini',
    SUMMARY_TARGET_LANG = 'english',
  } = env;

  const prompt = buildSummaryPrompt(mail, SUMMARY_TARGET_LANG);
  let summary: string;
  try {
    if (AI && WORKERS_AI_MODEL) {
      summary = await summarizedByWorkerAI(AI, WORKERS_AI_MODEL, prompt);
    } else if (OPENAI_API_KEY) {
      summary = await summarizedByOpenAI(OPENAI_API_KEY, OPENAI_COMPLETIONS_API, OPENAI_CHAT_MODEL, prompt);
    } else {
      summary = 'Sorry, no summarization provider is configured.';
    }
  } catch (e) {
    summary = `Failed to summarize the email: ${(e as Error).message}`;
  }
  return renderEmailDetail(summary, mail.id);
}

/** Render the debug view: metadata + list check status, no body. */
export async function renderEmailDebugMode(mail: EmailCache, env: Environment): Promise<DiscordMessagePayload> {
  const addresses = [mail.from, mail.to];
  const res = await checkAddressStatus(addresses, env);
  const lines = [
    `id: ${mail.id}`,
    `messageId: ${mail.messageId}`,
    `from: ${mail.from}`,
    `to: ${mail.to}`,
    `subject: ${mail.subject}`,
    `block-check: ${JSON.stringify(res)}`,
  ];
  return renderEmailDetail(lines.join('\n'), mail.id);
}

export function codeBlock(text: string): string {
  return `\`${text.length > 100 ? `${text.slice(0, 100)}…` : text}\``;
}
