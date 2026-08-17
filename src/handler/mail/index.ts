import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import type { EmailCache, Environment } from '../../types';
import { Dao } from '../../db';
import { isMessageBlock } from '../../mail/check';
import { parseEmail } from '../../mail/parse';
import { renderEmailListMode } from '../../mail/render';
import { createChannelMessage, executeWebhook } from '../../discord/api';

export async function sendMailToDiscord(mail: EmailCache, env: Environment): Promise<string[]> {
  const payload = await renderEmailListMode(mail, env);
  const messageIDs: string[] = [];

  if (env.DISCORD_WEBHOOK_URL) {
    const msg = await executeWebhook(env.DISCORD_WEBHOOK_URL, payload);
    messageIDs.push(msg.id);
    return messageIDs;
  }

  const token = env.DISCORD_TOKEN;
  const channelIds = (env.DISCORD_CHANNEL_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token || channelIds.length === 0) {
    throw new Error('No Discord destination configured: set DISCORD_WEBHOOK_URL or DISCORD_TOKEN + DISCORD_CHANNEL_ID');
  }
  for (const channelId of channelIds) {
    const msg = await createChannelMessage(token, channelId, payload);
    messageIDs.push(msg.id);
  }
  return messageIDs;
}

export async function emailHandler(message: ForwardableEmailMessage, env: Environment): Promise<void> {
  const {
    FORWARD_LIST,
    BLOCK_POLICY,
    GUARDIAN_MODE,
    DB,
    MAIL_TTL,
    MAX_EMAIL_SIZE,
    MAX_EMAIL_SIZE_POLICY,
  } = env;

  const dao = new Dao(DB);
  const id = message.headers.get('Message-ID')?.trim() || crypto.randomUUID();
  const isBlock = await isMessageBlock(message, env);
  const isGuardian = GUARDIAN_MODE === 'true';
  const blockPolicy = ((BLOCK_POLICY || 'discord').split(',') as Array<'reject' | 'forward' | 'discord'>);
  const statusTTL = 60 * 60;
  const status = await dao.loadMailStatus(id, isGuardian);

  // Reject the email
  if (isBlock && blockPolicy.includes('reject')) {
    message.setReject('Blocked');
    return;
  }

  // Forward to backup emails
  try {
    const blockForward = isBlock && blockPolicy.includes('forward');
    const forwardList = blockForward ? [] : (FORWARD_LIST || '').split(',');
    for (const forward of forwardList) {
      try {
        const addr = forward.trim();
        if (!addr || status.forward.includes(addr)) {
          continue;
        }
        await message.forward(addr);
        if (isGuardian) {
          status.forward.push(addr);
          await dao.saveMailStatus(id, status, statusTTL);
        }
      } catch (e) {
        console.error(e);
      }
    }
  } catch (e) {
    console.error(e);
  }

  // Send to Discord
  try {
    const blockDiscord = isBlock && blockPolicy.includes('discord');
    if (!status.discord && !blockDiscord) {
      const ttl = Number.parseInt(MAIL_TTL || '', 10) || 60 * 60 * 24;
      const maxSize = Number.parseInt(MAX_EMAIL_SIZE || '', 10) || 512 * 1024;
      const maxSizePolicy = MAX_EMAIL_SIZE_POLICY || 'truncate';
      const mail = await parseEmail(message, maxSize, maxSizePolicy);
      await dao.saveMailCache(mail.id, mail, ttl);
      const msgIDs = await sendMailToDiscord(mail, env);
      for (const msgID of msgIDs) {
        await dao.saveMessageIDToMailID(`${msgID}`, mail.id, ttl);
      }
    }
    if (isGuardian) {
      status.discord = true;
      await dao.saveMailStatus(id, status, statusTTL);
    }
  } catch (e) {
    console.error(e);
  }
}
