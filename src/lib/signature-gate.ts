import { verifyRequest } from '@karasu-lab/utils/server/request-signature';

const SIGNATURE_REQUIRED_PREFIX = '/api/internal/';

const reject = (message: string) => Response.json({ error: message }, { status: 401 });

export async function rejectInvalidSignature(env: Env, request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const secret = env.INTERNAL_API_SECRET ?? '';
  const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text();
  const result = verifyRequest({ secret, method: request.method, url: request.url, headers: request.headers, body });

  if (result.status === 'unsigned' && pathname.startsWith(SIGNATURE_REQUIRED_PREFIX)) return reject('Unauthorized');
  if (result.status === 'invalid' || (result.status === 'valid' && !secret)) return reject('Invalid signature');
  return null;
}
