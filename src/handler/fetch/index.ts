import type { DiscordInteraction, EmailCache, Environment, DiscordMessagePayload } from '../../types';
import { Dao } from '../../db';
import { checkAddressStatus } from '../../mail/check';
import { renderEmailDebugMode, renderEmailListMode, renderEmailPreviewMode, renderEmailSummaryMode } from '../../mail/render';
import { editInteractionOriginal, registerApplicationCommands, fetchBotUser } from '../../discord/api';
import { verifyDiscordSignature } from '../../discord/verify';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorResponse(message: string, status = 500): Response {
  return json({ error: message }, status);
}

/** Constant-time string comparison to avoid timing leaks on secrets. */
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

/** POST|GET /init?secret=... — register slash commands and sanity-check the bot token. */
export async function initHandler(request: Request, env: Environment): Promise<Response> {
  if (request.method !== 'POST' && request.method !== 'GET') {
    return errorResponse('Method not allowed', 405);
  }
  const secret = env.INIT_SECRET;
  if (!secret) {
    return errorResponse('/init is disabled: set INIT_SECRET to enable this endpoint', 403);
  }
  const provided = new URL(request.url).searchParams.get('secret') || request.headers.get('x-init-secret') || '';
  if (!timingSafeEqual(secret, provided)) {
    return errorResponse('Invalid secret', 401);
  }
  const token = env.DISCORD_TOKEN;
  if (!token) {
    return errorResponse('DISCORD_TOKEN is not set', 400);
  }
  try {
    const bot = await fetchBotUser(token);
    const { application_id, commands } = await registerApplicationCommands(token);
    return json({
      ok: true,
      application_id,
      bot: `${bot.username} (${bot.id})`,
      commands: (commands as Array<{ name: string }>).map(c => c.name),
      note: 'Now set the Interactions Endpoint URL of your Discord application to https://<DOMAIN>/discord',
    });
  } catch (e) {
    return errorResponse((e as Error).message);
  }
}

/** POST /discord — Discord interaction endpoint. */
export async function discordInteractionHandler(request: Request, env: Environment, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();

  // Interactions MUST be verified with the app's public key (Ed25519).
  // Webhook mode never receives interactions, so without a configured key we
  // reject everything instead of accepting unverified requests.
  const publicKey = env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    return errorResponse('Interactions disabled: DISCORD_PUBLIC_KEY is not set', 401);
  }
  const valid = await verifyDiscordSignature(publicKey, signature || '', timestamp || '', body);
  if (!valid) {
    return errorResponse('Invalid request signature', 401);
  }

  const interaction = JSON.parse(body) as DiscordInteraction;

  // PING from Discord
  if (interaction.type === 1) {
    return json({ type: 1 });
  }

  // Slash command: /mail blocklist|whitelist|test
  if (interaction.type === 2 && interaction.data?.name === 'mail') {
    return await handleMailCommand(interaction, env);
  }

  // Button click (message component)
  if (interaction.type === 3 && interaction.data?.component_type === 2) {
    return await handleMailButton(interaction, env, ctx);
  }

  return json({ type: 4, data: { content: 'Unknown interaction' } });
}

function getOption(options: Array<{ name: string; value: string }> | undefined, name: string): string | undefined {
  return options?.find(o => o.name === name)?.value;
}

async function handleMailCommand(interaction: DiscordInteraction, env: Environment): Promise<Response> {
  const sub = interaction.data?.options?.[0];
  const dao = new Dao(env.DB);
  let content: string;

  if (!sub) {
    content = 'Usage: /mail blocklist|whitelist|test';
  } else if (sub.name === 'test') {
    const address = getOption(sub.options, 'address') || '';
    const res = await checkAddressStatus([address], env);
    const status = res[address] || 'no_match';
    content = `\`${address}\` → **${status}**`;
  } else {
    const type = sub.name === 'blocklist' ? 'BLOCK_LIST' : 'WHITE_LIST';
    const add = getOption(sub.options, 'add');
    const remove = getOption(sub.options, 'remove');
    if (add) {
      await dao.addAddress(add, type);
      content = `Added \`${add}\` to ${sub.name}`;
    } else if (remove) {
      await dao.removeAddress(remove, type);
      content = `Removed \`${remove}\` from ${sub.name}`;
    } else {
      const list = await dao.loadArrayFromDB(type);
      content = list.length
        ? `**${sub.name}** (${list.length}):\n${list.map(i => `- \`${i}\``).join('\n')}`
        : `**${sub.name}** is empty`;
    }
  }

  return json({
    type: 4,
    data: {
      content: content.slice(0, 1900),
      flags: 64, // ephemeral
    },
  });
}

async function handleMailButton(interaction: DiscordInteraction, env: Environment, ctx: ExecutionContext): Promise<Response> {
  const customId = interaction.data?.custom_id || '';
  const [action, mailId] = customId.split(':');
  const token = interaction.token;
  const appId = interaction.application_id;

  // Delete: tombstone the notification message (fast, no KV/AI work)
  if (action === 'delete') {
    return json({
      type: 7, // UPDATE_MESSAGE
      data: { content: '🗑️ Deleted', embeds: [], components: [] },
    });
  }

  const dao = new Dao(env.DB);
  const mail = mailId ? await dao.loadMailCache(mailId) : null;
  if (!mail) {
    return json({ type: 4, data: { content: 'Email cache expired (MAIL_TTL) or not found.', flags: 64 } });
  }

  // Summary may call an AI provider and exceed the 3s ACK limit:
  // ACK immediately as a deferred update, then edit via webhook in the background.
  if (action === 's') {
    if (token && appId) {
      ctx.waitUntil(
        renderEmailSummaryMode(mail, env)
          .then(payload => editInteractionOriginal(appId, token, payload))
          .catch(e => console.error('summary editInteractionOriginal:', e)),
      );
    }
    return json({ type: 6 }); // DEFERRED_UPDATE_MESSAGE
  }

  // Fast actions: answer with an inline message update
  let payload: DiscordMessagePayload;
  switch (action) {
    case 'p':
      payload = renderEmailPreviewMode(mail);
      break;
    case 'd':
      payload = await renderEmailDebugMode(mail, env);
      break;
    case 'l':
    default:
      payload = await renderEmailListMode(mail, env);
      break;
  }
  return json({ type: 7, data: payload });
}

/** GET /email/:id?mode=text|html|preview — view the cached email body. */
export async function emailViewHandler(request: Request, env: Environment, id: string): Promise<Response> {
  const dao = new Dao(env.DB);
  const mail = await dao.loadMailCache(id);
  if (!mail) {
    return new Response('Email not found or expired (MAIL_TTL).', { status: 404 });
  }
  const mode = new URL(request.url).searchParams.get('mode') || 'text';
  if (mode === 'html') {
    return new Response(wrapHtml(mail), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  if (mode === 'preview') {
    return new Response(wrapPreview(mail), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return new Response(mail.text || 'No text content', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function wrapPreview(mail: EmailCache): string {
  const body = escapeHtml(mail.text || 'No text content');
  const htmlLink = mail.html ? `?mode=html` : '';
  const textLink = `?mode=text`;
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(mail.subject || '(no subject)')}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Thai", sans-serif; background: #f2f3f5; color: #1e1f22; }
  main { max-width: 680px; margin: 24px auto; padding: 24px; background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  @media (prefers-color-scheme: dark) { body { background: #1a1b1e; } main { background: #2b2d31; color: #dbdee1; } }
  h1 { font-size: 1.25rem; margin: 0 0 12px; word-break: break-word; }
  .meta { font-size: .85rem; color: #888; margin-bottom: 20px; line-height: 1.6; }
  .meta code { background: rgba(135,135,135,.15); padding: 1px 6px; border-radius: 4px; }
  .body { font-size: .95rem; line-height: 1.7; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .links { margin-top: 24px; font-size: .85rem; }
  .links a { color: #5865F2; margin-right: 16px; }
  .warning { color: #b5b8bb; font-size: .75rem; margin-top: 32px; border-top: 1px solid #3f4147; padding-top: 12px; }
</style>
</head>
<body>
<main>
  <h1>📭 ${escapeHtml(mail.subject || '(no subject)')}</h1>
  <div class="meta">
    <div>From: <code>${escapeHtml(mail.from)}</code></div>
    <div>To: <code>${escapeHtml(mail.to)}</code></div>
    <div>Message-ID: <code>${escapeHtml(mail.messageId)}</code></div>
  </div>
  <div class="body">${body}</div>
  <div class="links">
    <a href="${textLink}">View raw text</a>${htmlLink ? `<a href="${htmlLink}">View original HTML</a>` : ''}
  </div>
  <div class="warning">⚠️ This preview is rendered as plain text and fully escaped — links and scripts in the original mail are inert. The cache expires per MAIL_TTL.</div>
</main>
</body>
</html>`;
}

function wrapHtml(mail: EmailCache): string {
  const escaped = (mail.html || 'No html content')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeAttr(mail.subject)}</title></head>
<body>
<p style="font-family: monospace; color: #666;">⚠️ The original HTML below is escaped and inert. <a href="?mode=text">View text</a></p>
<hr>
<pre style="white-space: pre-wrap; word-break: break-word;">${escaped}</pre>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

/** GET /health */
export function healthHandler(): Response {
  return json({ ok: true });
}
