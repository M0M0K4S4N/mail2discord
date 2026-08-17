import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import type { Environment } from './types';
import { emailHandler, fetchHandler } from './handler';

export interface WorkerExports {
  fetch: (request: Request, env: Environment, ctx: ExecutionContext) => Promise<Response>;
  email: (message: ForwardableEmailMessage, env: Environment) => Promise<void>;
}

const worker: WorkerExports = {
  fetch: fetchHandler,
  email: emailHandler,
};

export default worker;
