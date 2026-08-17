import type { DiscordActionRow, DiscordEmbed, DiscordMessagePayload, EmailCache, Environment } from '../types';
import { EMBED_COLOR_MAIL } from '../discord/api';
import { checkAddressStatus } from './check';
import { summarizedByOpenAI, summarizedByWorkerAI } from './summarization';

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

/** Trim text to fit a Discord embed description, appending an ellipsis marker. */
export function trimToEmbedLimit(text: string, limit: number = DISCORD_EMBED_LIMIT): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 15)}\n[...]`;
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

  const buttons: DiscordActionRow['components'] = [];
  if (interactive) {
    buttons.push({ type: 2, style: 1, label: 'Preview', custom_id: `p:${mail.id}` });
    if (summarizeProvider(env)) {
      buttons.push({ type: 2, style: 1, label: 'Summary', custom_id: `s:${mail.id}` });
    }
  }
  if (mail.text && DOMAIN) {
    buttons.push({ type: 2, style: 5, label: 'Text', url: `https://${DOMAIN}/email/${mail.id}?mode=text` });
  }
  if (mail.html && DOMAIN) {
    buttons.push({ type: 2, style: 5, label: 'HTML', url: `https://${DOMAIN}/email/${mail.id}?mode=html` });
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

  const prompt = `Summarize the following email in approximately 50 words in ${SUMMARY_TARGET_LANG}.\n\nFrom: ${mail.from}\nSubject: ${mail.subject}\n\n${mail.text || mail.html || ''}`;
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
