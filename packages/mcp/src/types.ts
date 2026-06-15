/**
 * MCP (Model Context Protocol) JSON-RPC 2.0 types.
 *
 * Covers only the methods this server implements:
 *   initialize, tools/list, tools/call, resources/list, resources/read
 *
 * No third-party dependencies — plain TypeScript interfaces only.
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** Standard JSON-RPC 2.0 error codes. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// MCP initialize
// ---------------------------------------------------------------------------

export interface InitializeParams {
  protocolVersion?: string;
  clientInfo?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface ToolsListResult {
  tools: ToolDef[];
}

export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// MCP resources
// ---------------------------------------------------------------------------

export interface ResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourcesListResult {
  resources: ResourceDef[];
}

export interface ResourceReadParams {
  uri: string;
}

export interface ResourceReadResult {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
  }>;
}
