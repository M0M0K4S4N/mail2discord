// Debug: print the exact payload renderEmailListMode would send.
import type { EmailCache, Environment } from '../src/types';
import { renderEmailListMode } from '../src/mail/render';

const mail: EmailCache = {
  id: '85141919-ab11-432e-97fd-c1d9a8ee1888',
  messageId: '<live-test-001@github.com>',
  from: 'noreply@github.com',
  to: 'test-inbox@mail2discord.local',
  subject: 'debug',
  text: 'some body text',
};

const env: Environment = {
  SHOW_PREVIEW_URL: 'true',
  DOMAIN: 'mail2discord.preview.test',
} as Environment;

const payload = await renderEmailListMode(mail, env);
console.log(JSON.stringify(payload, null, 2));
