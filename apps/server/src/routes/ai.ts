/**
 * AI proxy routes.
 *
 * All routes are under /v1/ai and require a valid bearer token.
 * The AI API key is stored server-side (encrypted at rest) and NEVER returned
 * to the client.
 *
 * Config endpoints:
 *   POST   /v1/ai/config   — save/update AI key + gateway config
 *   GET    /v1/ai/config   — read non-secret info (keySet + gateway + model)
 *   DELETE /v1/ai/config   — remove AI config
 *
 * Chat proxy:
 *   POST   /v1/ai/chat     — forward a chat completion request to the upstream
 *                            gateway using the stored key
 *
 * Security notes:
 *   - The API key is never returned to the client.
 *   - Error messages are sanitised to prevent key leaks.
 *   - A per-user/day cap protects against runaway usage.
 *   - The global @fastify/rate-limit cap also applies.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { aiConfigRequestSchema, aiChatRequestSchema, type AiStreamEvent } from '@graphvault/shared';
import { AppError, badRequest } from '../errors.js';
import type { AuthContext } from '../services/auth.js';
import type { Services } from '../services/index.js';

/** Serialise one provider-agnostic event as an SSE frame (named event + data). */
function sseFrame(ev: AiStreamEvent): string {
  return `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
}

export function registerAiRoutes(app: FastifyInstance, services: Services): void {
  const auth = (request: FastifyRequest): Promise<AuthContext> =>
    services.auth.authenticate(request.headers.authorization);

  // ---- Config: save/update AI key ----

  app.post('/v1/ai/config', async (request, reply) => {
    const { user } = await auth(request);
    const parsed = aiConfigRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid AI configuration', parsed.error.flatten());
    }
    // Validate that custom gateway includes a baseUrl.
    if (parsed.data.gateway === 'custom' && !parsed.data.baseUrl) {
      throw badRequest('baseUrl is required when gateway is "custom"');
    }
    await services.ai.saveConfig(user.id, parsed.data);
    return reply.code(201).send({ ok: true });
  });

  // ---- Config: read non-secret info ----

  app.get('/v1/ai/config', async (request, reply) => {
    const { user } = await auth(request);
    const info = await services.ai.getConfigInfo(user.id);
    if (!info) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: 'AI is not configured' } });
    }
    return reply.send(info);
  });

  // ---- Config: delete ----

  app.delete('/v1/ai/config', async (request, reply) => {
    const { user } = await auth(request);
    await services.ai.deleteConfig(user.id);
    return reply.code(204).send();
  });

  // ---- Chat proxy ----

  app.post('/v1/ai/chat', async (request, reply) => {
    const { user } = await auth(request);
    const parsed = aiChatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid chat request', parsed.error.flatten());
    }
    const { messages, model, stream } = parsed.data;

    if (stream) {
      return streamChat(reply, services, user.id, messages, model);
    }

    const result = await services.ai.chat(user.id, messages, model);
    return reply.send(result);
  });
}

/**
 * SSE streaming branch for POST /v1/ai/chat. The spend/cap pre-check runs BEFORE
 * any SSE headers are written, so a tripped cap is delivered as a real HTTP 429
 * (an SSE response has already committed `200`, so post-header errors can only be
 * an `event: error`). Once headers are written the route relays the service's
 * provider-agnostic frames, emits a heartbeat, and aborts the upstream fetch the
 * instant the client disconnects.
 */
async function streamChat(
  reply: FastifyReply,
  services: Services,
  userId: string,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  model: string | undefined,
): Promise<FastifyReply> {
  // Pre-check (decrypt + cap check) BEFORE writing SSE headers. A 404/429 thrown
  // here propagates to the normal error handler as a real HTTP status.
  const prepared = await services.ai.prepareStream(userId, model);

  // Take over the underlying socket: Fastify will not try to send a reply itself.
  reply.hijack();

  // Commit SSE headers. X-Accel-Buffering disables nginx/Caddy proxy buffering.
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Abort the upstream fetch the moment the client disconnects, so a closed tab
  // does not keep burning the user's budget.
  const abort = new AbortController();
  const onClose = (): void => abort.abort();
  reply.raw.on('close', onClose);

  // Heartbeat: a comment line every 15s so intermediaries don't idle-timeout a
  // slow generation. SSE comments start with ':' and are ignored by clients.
  const heartbeat = setInterval(() => {
    if (!reply.raw.writableEnded) reply.raw.write(':keepalive\n\n');
  }, 15_000);

  const write = (ev: AiStreamEvent): void => {
    if (!reply.raw.writableEnded) reply.raw.write(sseFrame(ev));
  };

  try {
    for await (const ev of services.ai.streamChat(userId, prepared, messages, abort.signal)) {
      write(ev);
    }
  } catch (err) {
    // A failure after headers can only be an SSE error frame (status is already
    // 200). Map an AppError to its code; otherwise a generic, key-free message.
    const code = err instanceof AppError ? err.code : 'INTERNAL';
    const message = err instanceof AppError ? err.message : 'AI proxy: streaming error';
    write({ type: 'error', code, message });
  } finally {
    clearInterval(heartbeat);
    reply.raw.off('close', onClose);
    if (!reply.raw.writableEnded) reply.raw.end();
  }

  // Tell Fastify we've handled the raw response ourselves.
  return reply;
}
