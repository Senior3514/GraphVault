#!/usr/bin/env node
/**
 * @graphvault/mcp — executable entry point.
 *
 * A standalone stdio Model Context Protocol server that exposes a user's
 * self-hosted GraphVault vault to external agents (e.g. Claude Desktop). The
 * read tools are always available; conflict-safe write tools (create/update/
 * append/delete) are registered only when GRAPHVAULT_DEVICE_ID is configured.
 *
 * Configuration is taken entirely from environment variables (see config.ts);
 * the server fails fast with a clear message when misconfigured. The bearer
 * token is never written to stdout/stderr.
 *
 * IMPORTANT: stdio transports use stdout for the protocol. All diagnostics MUST
 * go to stderr, never stdout, or they corrupt the MCP stream.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GraphVaultClient } from './client.js';
import { ConfigError, loadConfig } from './config.js';
import { registerPrompts, registerResources, registerTools } from './server.js';
import { bindTools } from './tools.js';
import { VaultManager } from './vault.js';
import { bindWriteTools } from './writes.js';
import { bindResources } from './resources.js';
import { bindPrompts } from './prompts.js';

/** Log a diagnostic line to stderr (never stdout — that carries the protocol). */
function logErr(message: string): void {
  process.stderr.write(`[graphvault-mcp] ${message}\n`);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logErr(err.message);
      process.exit(1);
    }
    throw err;
  }

  const client = new GraphVaultClient(config);
  const manager = new VaultManager(client, config);
  const tools = bindTools(manager);
  const writeTools = bindWriteTools(manager, client, config);
  const resources = bindResources(manager);
  const prompts = bindPrompts(manager);

  const server = new McpServer({
    name: 'graphvault',
    version: '0.0.0',
  });
  registerTools(server, tools, writeTools);
  // Resources (notes as attachable resources) and prompts are read-only and
  // always available, regardless of whether writes are enabled.
  registerResources(server, resources);
  registerPrompts(server, prompts);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const writeMode = writeTools.enabled
    ? 'writes ENABLED (conflict-safe create/update/append/delete)'
    : 'read-only (set GRAPHVAULT_DEVICE_ID to enable writes)';
  logErr(`connected (server=${config.serverUrl}). ${writeMode}.`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  logErr(`fatal: ${message}`);
  process.exit(1);
});
