/**
 * Remote MCP connector: MCP-over-HTTP endpoint (`/mcp`).
 *
 * Bridges an OAuth-authenticated remote client (Claude.ai's "custom
 * connector") to the EXACT SAME tool/resource/prompt logic the stdio server
 * (`@graphvault/mcp`) already exposes to Claude Desktop - `registerTools`,
 * `bindTools`, `VaultManager`, etc. are all reused unmodified. The only new
 * piece is the transport: `StreamableHTTPServerTransport` instead of stdio.
 *
 * `GraphVaultClient` (from `@graphvault/mcp`) is hard-wired to call this same
 * server's own `/v1/*` sync routes over HTTP with a bearer token. Rather than
 * making a real network loopback call (which wouldn't work under `app.inject`-
 * based tests, and adds a pointless round trip), its injectable `fetchImpl` is
 * pointed at a small shim that drives `app.inject()` directly - a real,
 * in-process request through the exact same route handlers, auth included.
 * To authenticate those simulated requests, each MCP-over-HTTP call mints a
 * fresh, ordinary vault-sync token (via `AuthService.issueServiceToken`) for
 * the OAuth-verified user - the two auth systems stay cleanly separate: OAuth
 * proves who the remote MCP client is acting for, the sync token is what the
 * existing `/v1/*` routes already know how to check.
 *
 * Stateless per HTTP request: each call builds a fresh `VaultManager`, so the
 * usual in-process snapshot cache (`indexTtlMs`) does not carry over between
 * calls - a known, deliberate simplicity/perf trade-off for v1 (see
 * docs/deployment.md). Multiple vaults: the account's first vault (by
 * creation order) is used; per-connector vault selection is a future slice.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  GraphVaultClient,
  VaultManager,
  bindPrompts,
  bindResources,
  bindTools,
  bindWriteTools,
  registerPrompts,
  registerResources,
  registerTools,
  DEFAULT_INDEX_TTL_MS,
  type McpConfig,
} from '@graphvault/mcp';
import type { ServerConfig } from '../config.js';
import type { Services } from '../services/index.js';
import { extractBearerToken } from './oauth.js';

/** A placeholder origin for `GraphVaultClient` - only the path+query it builds
 *  ever matters, since {@link injectFetch} resolves requests in-process. */
const INTERNAL_BASE_URL = 'http://internal.graphvault.invalid';

/** Routes `GraphVaultClient`'s HTTP calls through `app.inject()` instead of a
 *  real network hop - works identically under tests and in production, since
 *  Fastify's inject runs the real route pipeline (auth, validation, handlers). */
function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
    }
    let payload: Buffer | string | undefined;
    if (init?.body instanceof Uint8Array) {
      payload = Buffer.from(init.body);
    } else if (typeof init?.body === 'string') {
      payload = init.body;
    }
    const res = await app.inject({
      method: (init?.method as 'GET' | 'PUT' | 'POST' | 'DELETE' | undefined) ?? 'GET',
      url: parsed.pathname + parsed.search,
      headers,
      payload,
    });
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(res.headers)) {
      if (typeof value === 'string') responseHeaders[key] = value;
      else if (Array.isArray(value)) responseHeaders[key] = value.join(', ');
    }
    return new Response(res.rawPayload, { status: res.statusCode, headers: responseHeaders });
  }) as typeof fetch;
}

export function registerMcpRoutes(
  app: FastifyInstance,
  services: Services,
  config: ServerConfig,
): void {
  // Off => register nothing so the endpoint is invisible (404), same as /oauth/*.
  if (!config.mcpRemoteEnabled || !services.oauth) return;
  const oauth = services.oauth;

  const mcpRateLimit = {
    config: {
      rateLimit: {
        // The MCP endpoint is called far more often than /oauth/* (every tool
        // call), so it gets the general cap rather than the strict OAuth one.
        max: config.rateLimitMax,
        timeWindow: config.rateLimitWindowMs,
      },
    },
  };

  async function handleMcpRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const bearer = extractBearerToken(request);
    const auth = bearer ? await oauth.verifyAccessToken(bearer) : null;
    if (!auth) {
      // RFC 6750 §3: WWW-Authenticate cues an MCP client to (re-)run the OAuth flow.
      reply.header('WWW-Authenticate', 'Bearer realm="graphvault-mcp"');
      reply
        .code(401)
        .send({ error: 'invalid_token', error_description: 'Missing or expired access token' });
      return;
    }

    const vaults = await services.vault.list(auth.userId);
    if (vaults.length === 0) {
      reply.code(400).send({
        error: 'no_vault',
        error_description:
          'This account has no vault yet - create one first in the GraphVault web app.',
      });
      return;
    }
    // Deterministic default: the account's first (oldest) vault. Multi-vault
    // connector selection is a future slice (see docs/deployment.md).
    const vaultId = vaults[0]!.id;

    const serviceToken = await services.auth.issueServiceToken(
      auth.userId,
      `MCP connector (${auth.clientId})`,
    );

    const mcpConfig: McpConfig = {
      serverUrl: INTERNAL_BASE_URL,
      token: serviceToken.accessToken,
      vaultId,
      vaultName: undefined,
      deviceId: serviceToken.deviceId,
      indexTtlMs: DEFAULT_INDEX_TTL_MS,
    };

    const client = new GraphVaultClient(
      { serverUrl: mcpConfig.serverUrl, token: mcpConfig.token },
      { fetchImpl: injectFetch(app) },
    );
    const manager = new VaultManager(client, mcpConfig);
    const tools = bindTools(manager);
    const writeTools = bindWriteTools(manager, client, mcpConfig);
    const resources = bindResources(manager);
    const prompts = bindPrompts(manager);

    const mcpServer = new McpServer({ name: 'graphvault', version: '0.0.0' });
    registerTools(mcpServer, tools, writeTools);
    registerResources(mcpServer, resources);
    registerPrompts(mcpServer, prompts);

    // Stateless: no session id, no SSE stream kept open across requests - one
    // self-contained JSON-RPC exchange per HTTP call (see file header).
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);

    // Fastify must not also try to send a response - we're writing to the raw
    // Node response ourselves via the transport.
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await transport.close();
      await mcpServer.close();
    }
  }

  app.post('/mcp', mcpRateLimit, async (request, reply) => handleMcpRequest(request, reply));
  app.get('/mcp', mcpRateLimit, async (request, reply) => handleMcpRequest(request, reply));
  app.delete('/mcp', mcpRateLimit, async (request, reply) => handleMcpRequest(request, reply));
}
