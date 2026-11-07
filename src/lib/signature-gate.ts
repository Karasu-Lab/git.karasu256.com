import { verifyRequest } from '@karasu-lab/utils/server/request-signature';

const SIGNATURE_REQUIRED_PREFIX = '/api/internal/';

const reject = (message: string) => Response.json({ error: message }, { status: 401 });

export function rejectInvalidSignature(env: Env, request: Request, body: string): Response | null {
  const { pathname } = new URL(request.url);
  const secret = env.INTERNAL_API_SECRET ?? '';
  const result = verifyRequest({ secret, method: request.method, url: request.url, headers: request.headers, body });

  if (result.status === 'unsigned' && pathname.startsWith(SIGNATURE_REQUIRED_PREFIX)) return reject('Unauthorized');
  if (result.status === 'invalid' || (result.status === 'valid' && !secret)) return reject('Invalid signature');
  return null;
}
