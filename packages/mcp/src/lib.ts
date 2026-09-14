/**
 * Library entrypoint for `@graphvault/mcp` - the reusable pieces, with no
 * import-time side effects (unlike `index.ts`, the stdio CLI, which connects
 * a transport and reads process.env the moment it runs `main()`).
 *
 * Consumers: the stdio CLI (`index.ts`, via these same re-exports) and the
 * self-hosted server's remote MCP-over-HTTP route (`apps/server`), which
 * builds its own {@link McpConfig} per authenticated request and drives a
 * `StreamableHTTPServerTransport` instead of `StdioServerTransport`.
 */

export { GraphVaultClient, GraphVaultApiError, type ClientOptions } from './client.js';
export { ConfigError, DEFAULT_INDEX_TTL_MS, loadConfig, type McpConfig } from './config.js';
export { VaultManager, type VaultSnapshot, type LoadedNote } from './vault.js';
export { bindTools, type BoundTools } from './tools.js';
export { bindWriteTools, type BoundWriteTools } from './writes.js';
export { bindResources, type BoundResources } from './resources.js';
export { bindPrompts, type BoundPrompts } from './prompts.js';
export { registerTools, registerResources, registerPrompts } from './server.js';
