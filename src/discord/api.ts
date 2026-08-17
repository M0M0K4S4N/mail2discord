import type { DiscordActionRow, DiscordMessagePayload } from '../types';

export const DISCORD_API = 'https://discord.com/api/v10';
export const EMBED_COLOR_MAIL = 0x5865F2;
export const EMBED_COLOR_BLOCK = 0xED4245;

async function discordFetch(token: string | undefined, path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bot ${token}`;
  }
  return fetch(`${DISCORD_API}${path}`, {
    ...init,
    headers,
  });
}

/** Send a message to a channel with the bot token. */
export async function createChannelMessage(
  token: string,
  channelId: string,
  payload: DiscordMessagePayload,
): Promise<{ id: string }> {
  const res = await discordFetch(token, `/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Discord createChannelMessage failed: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

/** Execute a webhook (simplified mode, no bot token needed). */
export async function executeWebhook(
  webhookUrl: string,
  payload: DiscordMessagePayload,
): Promise<{ id: string }> {
  const url = webhookUrl.endsWith('?wait=true') ? webhookUrl : `${webhookUrl}?wait=true`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      allowed_mentions: { parse: [] },
      ...payload,
    }),
  });
  if (!res.ok) {
    throw new Error(`Discord executeWebhook failed: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

/** Register global application (slash) commands. Returns the app id used. */
export async function registerApplicationCommands(token: string): Promise<{ application_id: string; commands: unknown[] }> {
  const meRes = await discordFetch(token, '/oauth2/applications/@me');
  if (!meRes.ok) {
    throw new Error(`Failed to fetch application id: ${meRes.status} ${await meRes.text()}`);
  }
  const me = (await meRes.json()) as { id: string };
  const commands = [
    {
      name: 'mail',
      description: 'Manage mail2discord',
      options: [
        {
          name: 'blocklist',
          description: 'Manage the sender block list',
          type: 1,
          options: [
            { name: 'add', description: 'Address or regex to block', type: 3, required: false },
            { name: 'remove', description: 'Address or regex to remove', type: 3, required: false },
            { name: 'list', description: 'Set to "true" to list entries', type: 3, required: false },
          ],
        },
        {
          name: 'whitelist',
          description: 'Manage the sender white list',
          type: 1,
          options: [
            { name: 'add', description: 'Address or regex to allow', type: 3, required: false },
            { name: 'remove', description: 'Address or regex to remove', type: 3, required: false },
            { name: 'list', description: 'Set to "true" to list entries', type: 3, required: false },
          ],
        },
        {
          name: 'test',
          description: 'Test an address against block/white lists',
          type: 1,
          options: [{ name: 'address', description: 'Email address to test', type: 3, required: true }],
        },
      ],
    },
  ];
  const res = await discordFetch(token, `/applications/${me.id}/commands`, {
    method: 'PUT',
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    throw new Error(`Failed to register commands: ${res.status} ${await res.text()}`);
  }
  return { application_id: me.id, commands: await res.json() };
}

/** Fetch the bot's own user info — used by /init as a sanity check. */
export async function fetchBotUser(token: string): Promise<{ id: string; username: string }> {
  const res = await discordFetch(token, '/users/@me');
  if (!res.ok) {
    throw new Error(`Failed to fetch bot user: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

/** Edit an interaction's original response (follow-up to a deferred update). */
export async function editInteractionOriginal(
  applicationId: string,
  interactionToken: string,
  payload: DiscordMessagePayload,
): Promise<void> {
  const res = await fetch(`${DISCORD_API}/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`editInteractionOriginal failed: ${res.status} ${await res.text()}`);
  }
}

export function actionRow(components: DiscordActionRow['components']): DiscordActionRow {
  return { type: 1, components };
}
