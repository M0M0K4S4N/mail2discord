import type { Environment } from '../types';
import { emailHandler } from './mail';
import { discordInteractionHandler, emailViewHandler, healthHandler, initHandler } from './fetch';

export async function fetchHandler(request: Request, env: Environment, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/init') {
    return initHandler(request, env);
  }
  if (path === '/discord') {
    return discordInteractionHandler(request, env, ctx);
  }
  if (path === '/health') {
    return healthHandler();
  }
  const emailMatch = /^\/email\/([0-9a-fA-F-]{36})$/.exec(path);
  if (emailMatch) {
    return emailViewHandler(request, env, emailMatch[1]);
  }
  return new Response('Not Found', { status: 404 });
}

export { emailHandler };
