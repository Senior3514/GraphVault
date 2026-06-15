/**
 * URL web-clipper route (M22).
 *
 * POST /v1/clip
 *   - Requires a valid bearer token (authenticated users only).
 *   - Validates the URL via clipRequestSchema from @graphvault/shared.
 *   - Applies the SSRF guard in ClipService.
 *   - Rate-limited via the global cap (inherits from app.ts).
 *   - Returns { title, markdown, sourceUrl } on success.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { clipRequestSchema } from '@graphvault/shared';
import { badRequest } from '../errors.js';
import type { AuthContext } from '../services/auth.js';
import type { Services } from '../services/index.js';

export function registerClipRoutes(app: FastifyInstance, services: Services): void {
  const auth = (request: FastifyRequest): Promise<AuthContext> =>
    services.auth.authenticate(request.headers.authorization);

  /**
   * POST /v1/clip
   *
   * Fetch and convert a web page to Markdown.
   *
   * Body: { url: string }
   * Response: { title: string, markdown: string, sourceUrl: string }
   */
  app.post('/v1/clip', async (request, reply) => {
    // Require authentication — clipping is a server-side outbound request and
    // should only be accessible to signed-in users.
    await auth(request);

    const parsed = clipRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid clip request', parsed.error.flatten());
    }

    const result = await services.clip.clip(parsed.data.url);
    return reply.code(200).send(result);
  });
}
