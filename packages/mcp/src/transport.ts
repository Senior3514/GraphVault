/**
 * Stdio MCP transport — Content-Length-framed JSON-RPC 2.0 over stdin/stdout.
 *
 * Framing (identical to Language Server Protocol, which MCP inherited):
 *
 *   Content-Length: <byte-length>\r\n
 *   \r\n
 *   <UTF-8 JSON body>
 *
 * Each message is a complete JSON-RPC 2.0 object. The server reads from
 * stdin one message at a time and writes responses to stdout.
 *
 * No third-party dependencies — only node:readline, node:stream, node:buffer.
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { JsonRpcRequest, JsonRpcResponse } from './types.js';

type MessageHandler = (req: JsonRpcRequest) => JsonRpcResponse | null;

const HEADER_CONTENT_LENGTH = 'Content-Length';

/**
 * Write a single JSON-RPC response to `out` using Content-Length framing.
 */
export function writeMessage(out: Writable, msg: JsonRpcResponse): void {
  const body = JSON.stringify(msg);
  const byteLen = Buffer.byteLength(body, 'utf8');
  out.write(`${HEADER_CONTENT_LENGTH}: ${byteLen}\r\n\r\n${body}`);
}

/**
 * Read Content-Length-framed JSON-RPC messages from `input` and call
 * `handler` for each request. Responses returned from `handler` are written
 * to `output` immediately. `null` return means a notification (no response).
 *
 * Resolves when the input stream ends.
 */
export async function serveStdio(
  input: Readable,
  output: Writable,
  handler: MessageHandler,
): Promise<void> {
  // We need to read raw bytes, not lines, because the body may contain
  // embedded newlines. Strategy: buffer all incoming data, parse headers,
  // then consume exactly `Content-Length` bytes for the body.
  const chunks: Buffer[] = [];
  let buffer = Buffer.alloc(0);

  input.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    buffer = Buffer.concat(chunks);
    processBuffer();
  });

  function processBuffer(): void {
    // Keep consuming messages as long as the buffer has enough data.
    while (true) {
      // Find the double CRLF that terminates the headers.
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break; // Need more data.

      // Parse headers (ASCII).
      const headerBlock = buffer.slice(0, headerEnd).toString('ascii');
      let contentLength = -1;
      for (const line of headerBlock.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        if (name === 'content-length') {
          contentLength = parseInt(line.slice(colon + 1).trim(), 10);
        }
      }
      if (contentLength < 0) {
        // Malformed: skip to next double-CRLF.
        buffer = buffer.slice(headerEnd + 4);
        chunks.length = 0;
        chunks.push(buffer);
        break;
      }

      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + contentLength) break; // Need more data.

      const body = buffer.slice(bodyStart, bodyStart + contentLength).toString('utf8');
      buffer = buffer.slice(bodyStart + contentLength);
      chunks.length = 0;
      chunks.push(buffer);

      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(body) as JsonRpcRequest;
      } catch {
        // Malformed JSON — send parse error (no id).
        writeMessage(output, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        continue;
      }

      const response = handler(msg);
      if (response !== null) {
        writeMessage(output, response);
      }
    }
  }

  return new Promise<void>((resolve, reject) => {
    input.on('end', resolve);
    input.on('error', reject);
  });
}

/**
 * Helper: build a single-use stdio pair from raw string input for tests.
 * Returns the output string after all messages have been processed.
 */
export async function runMessages(
  messages: JsonRpcRequest[],
  handler: MessageHandler,
): Promise<JsonRpcResponse[]> {
  // Encode each message as Content-Length-framed bytes.
  const frames: Buffer[] = messages.map((m) => {
    const body = JSON.stringify(m);
    const byteLen = Buffer.byteLength(body, 'utf8');
    return Buffer.from(`${HEADER_CONTENT_LENGTH}: ${byteLen}\r\n\r\n${body}`, 'utf8');
  });
  const fullInput = Buffer.concat(frames);

  const {
    Readable: NodeReadable,
    Writable: NodeWritable,
    PassThrough,
  } = await import('node:stream');
  void NodeReadable;
  void NodeWritable;

  const input = new PassThrough();
  const outputChunks: Buffer[] = [];
  const output = new PassThrough();
  output.on('data', (chunk: Buffer) => outputChunks.push(chunk));

  const done = serveStdio(input, output, handler);
  input.end(fullInput);
  await done;

  // Parse all responses from the output buffer.
  let outBuf = Buffer.concat(outputChunks);
  const responses: JsonRpcResponse[] = [];
  while (outBuf.length > 0) {
    const headerEnd = outBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const headerBlock = outBuf.slice(0, headerEnd).toString('ascii');
    let contentLength = -1;
    for (const line of headerBlock.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      if (line.slice(0, colon).trim().toLowerCase() === 'content-length') {
        contentLength = parseInt(line.slice(colon + 1).trim(), 10);
      }
    }
    if (contentLength < 0) break;
    const bodyStart = headerEnd + 4;
    const body = outBuf.slice(bodyStart, bodyStart + contentLength).toString('utf8');
    outBuf = outBuf.slice(bodyStart + contentLength);
    responses.push(JSON.parse(body) as JsonRpcResponse);
  }
  return responses;
}

// Re-export readline for use in simpler newline-delimited fallback (not used
// in this server, kept for reference).
export { createInterface };
