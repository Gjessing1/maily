/**
 * JWT auth (ARCHITECTURE §5): a single master password mints a long-lived JWT,
 * validated on every protected HTTP route and on the Socket.io handshake.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';

/** Long-lived per the single-user design; rotate by changing JWT_SECRET. */
const TOKEN_TTL = '365d';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** Constant-time master-password check. */
export function verifyMasterPassword(provided: string): boolean {
  const expected = Buffer.from(env.masterPassword());
  const got = Buffer.from(provided);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

export function issueToken(app: FastifyInstance): string {
  return app.jwt.sign({ sub: 'master' }, { expiresIn: TOKEN_TTL });
}

/** preHandler/onRequest hook that rejects requests without a valid JWT. */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // External-auth mode: a trusted gateway already gates access (see env.disableAuth).
  if (env.disableAuth) return;
  try {
    await req.jwtVerify();
  } catch {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}
