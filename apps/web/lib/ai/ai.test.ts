/**
 * Tests for the AI assistant lib layer.
 *
 * Covers:
 *  1. Provider selection invariant: kind=off → no network, always throws.
 *  2. Provider selection: kind=server without bearerToken → throws, no network.
 *  3. Provider selection: kind=server with bearerToken → calls /v1/ai/chat (mock).
 *  4. Provider selection: kind=local with empty endpoint → throws, no network.
 *  5. Prompt builder correctness for every action.
 *  6. Send-context builder correctness.
 *  7. truncateContext respects the MAX_CONTEXT_CHARS limit.
 *  8. redactKey helper.
 *  9. Settings persistence round-trip (mocked sessionStorage).
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { buildPrompt, buildSendContext } from './prompts.js';
import { chat, chatStream, truncateContext } from './providers.js';
import { loadAISettings, saveAISettings, clearAISettings } from './settings.js';
import { redactKey, DEFAULT_AI_SETTINGS, type AISettings } from './types.js';

// ---------------------------------------------------------------------------
// Helpers / mocks
// ---------------------------------------------------------------------------

/** Minimal sessionStorage shim for Node test environment. */
const makeSessionStorage = () => {
  const store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      Object.keys(store).forEach((k) => delete store[k]);
    },
  };
};

// Install the shim on globalThis so loadAISettings / saveAISettings can use it.
let originalWindow: unknown;

beforeEach(() => {
  originalWindow = (globalThis as Record<string, unknown>)['window'];
  const ss = makeSessionStorage();
  (globalThis as Record<string, unknown>)['window'] = { sessionStorage: ss };
});

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as Record<string, unknown>)['window'];
  } else {
    (globalThis as Record<string, unknown>)['window'] = originalWindow;
  }
});

// ---------------------------------------------------------------------------
// 1. Provider selection: off → no network
// ---------------------------------------------------------------------------

describe('chat() with kind=off', () => {
  it('throws immediately without making any network calls', async () => {
    // Monkey-patch fetch to detect any network calls.
    const originalFetch = (globalThis as Record<string, unknown>)['fetch'];
    let fetchCalled = false;
    (globalThis as Record<string, unknown>)['fetch'] = () => {
      fetchCalled = true;
      return Promise.resolve(new Response('{}'));
    };

    const settings: AISettings = { ...DEFAULT_AI_SETTINGS, kind: 'off' };
    await assert.rejects(
      () => chat(settings, [{ role: 'user', content: 'hello' }]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('disabled'), `Expected "disabled" in: ${err.message}`);
        return true;
      },
    );

    assert.equal(fetchCalled, false, 'fetch should not have been called when kind=off');

    // Restore fetch.
    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Provider selection: server without bearerToken → throws, no network
// ---------------------------------------------------------------------------

describe('chat() with kind=server and no bearer token', () => {
  it('throws without network call when bearer token is missing', async () => {
    const originalFetch = (globalThis as Record<string, unknown>)['fetch'];
    let fetchCalled = false;
    (globalThis as Record<string, unknown>)['fetch'] = () => {
      fetchCalled = true;
      return Promise.resolve(new Response('{}'));
    };

    const settings: AISettings = {
      ...DEFAULT_AI_SETTINGS,
      kind: 'server',
    };
    await assert.rejects(
      () =>
        chat(settings, [{ role: 'user', content: 'hello' }], {
          serverUrl: 'http://localhost:4000',
          bearerToken: '', // empty — not signed in
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes('sign in') ||
            err.message.toLowerCase().includes('token'),
          `Expected sign-in message in: ${err.message}`,
        );
        return true;
      },
    );

    assert.equal(fetchCalled, false, 'fetch should not have been called without a bearer token');

    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });

  it('throws without network call when serverOpts is undefined', async () => {
    const originalFetch = (globalThis as Record<string, unknown>)['fetch'];
    let fetchCalled = false;
    (globalThis as Record<string, unknown>)['fetch'] = () => {
      fetchCalled = true;
      return Promise.resolve(new Response('{}'));
    };

    const settings: AISettings = { ...DEFAULT_AI_SETTINGS, kind: 'server' };
    // Pass no serverOpts at all
    await assert.rejects(() => chat(settings, [{ role: 'user', content: 'hello' }]));

    assert.equal(fetchCalled, false, 'fetch should not have been called without serverOpts');

    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Provider selection: server with bearerToken → calls /v1/ai/chat (mock)
// ---------------------------------------------------------------------------

describe('chat() with kind=server and valid bearer token', () => {
  it('calls /v1/ai/chat on the GV server and returns content', async () => {
    const originalFetch = (globalThis as Record<string, unknown>)['fetch'];
    let fetchedUrl = '';
    let fetchedBody: unknown = null;
    let fetchedAuthHeader = '';

    (globalThis as Record<string, unknown>)['fetch'] = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      fetchedUrl = input.toString();
      fetchedBody = init?.body ? JSON.parse(init.body as string) : null;
      fetchedAuthHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
      return new Response(JSON.stringify({ content: 'Mock AI response', model: 'test/model' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const settings: AISettings = {
      ...DEFAULT_AI_SETTINGS,
      kind: 'server',
      serverModel: 'anthropic/claude-3-haiku',
    };

    const result = await chat(settings, [{ role: 'user', content: 'Summarise my note.' }], {
      serverUrl: 'http://localhost:4000',
      bearerToken: 'test-bearer-token-abc',
    });

    assert.equal(result, 'Mock AI response');
    assert.ok(
      fetchedUrl.includes('/v1/ai/chat'),
      `Expected /v1/ai/chat in URL, got: ${fetchedUrl}`,
    );
    assert.equal(fetchedAuthHeader, 'Bearer test-bearer-token-abc');
    assert.ok(
      fetchedBody !== null &&
        typeof fetchedBody === 'object' &&
        'messages' in (fetchedBody as object),
      'fetch body must include messages',
    );
    assert.equal((fetchedBody as { model?: string }).model, 'anthropic/claude-3-haiku');

    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });

  it('does not include model key when serverModel is empty', async () => {
    const originalFetch = (globalThis as Record<string, unknown>)['fetch'];
    let fetchedBody: unknown = null;

    (globalThis as Record<string, unknown>)['fetch'] = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      fetchedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(JSON.stringify({ content: 'ok' }), { status: 200 });
    };

    const settings: AISettings = { ...DEFAULT_AI_SETTINGS, kind: 'server', serverModel: '' };

    await chat(settings, [{ role: 'user', content: 'hello' }], {
      serverUrl: 'http://localhost:4000',
      bearerToken: 'tok',
    });

    // model key should not be present when serverModel is empty
    assert.ok(
      !('model' in (fetchedBody as Record<string, unknown>)),
      'model should not be sent when serverModel is empty',
    );

    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });

  it('throws when the server proxy returns a non-ok status', async () => {
    const originalFetch = (globalThis as Record<string, unknown>)['fetch'];

    (globalThis as Record<string, unknown>)['fetch'] = async () => {
      return new Response(
        JSON.stringify({ error: { message: 'No AI key configured', code: 'NOT_FOUND' } }),
        { status: 404 },
      );
    };

    const settings: AISettings = { ...DEFAULT_AI_SETTINGS, kind: 'server' };

    await assert.rejects(
      () =>
        chat(settings, [{ role: 'user', content: 'hello' }], {
          serverUrl: 'http://localhost:4000',
          bearerToken: 'tok',
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );

    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 3b. Streaming provider (chatStream)
// ---------------------------------------------------------------------------

describe('chatStream()', () => {
  it('throws immediately for kind=off without any network call', async () => {
    const originalFetch = (globalThis as Record<string, unknown>)['fetch'];
    let fetchCalled = false;
    (globalThis as Record<string, unknown>)['fetch'] = () => {
      fetchCalled = true;
      return Promise.resolve(new Response('{}'));
    };

    const settings: AISettings = { ...DEFAULT_AI_SETTINGS, kind: 'off' };
    await assert.rejects(
      () =>
        chatStream(
          settings,
          [{ role: 'user', content: 'hi' }],
          { serverUrl: 'http://localhost:4000', bearerToken: 'tok' },
          {},
        ),
      (err: unknown) => err instanceof Error && err.message.includes('disabled'),
    );
    assert.equal(fetchCalled, false, 'fetch must not be called when kind=off');

    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });

  it('streams deltas and surfaces usage for kind=server', async () => {
    const originalFetch = (globalThis as Record<string, unknown>)['fetch'];
    let sentBody: unknown = null;

    (globalThis as Record<string, unknown>)['fetch'] = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      sentBody = init?.body ? JSON.parse(init.body as string) : null;
      const enc = new TextEncoder();
      const frames = [
        'event: delta\ndata: {"type":"delta","content":"Hel"}\n\n',
        'event: delta\ndata: {"type":"delta","content":"lo"}\n\n',
        'event: usage\ndata: {"type":"usage","usage":{"costUsd":0.002}}\n\n',
        'event: done\ndata: {"type":"done","model":"m"}\n\n',
      ];
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const f = frames.shift();
          if (f) controller.enqueue(enc.encode(f));
          else controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };

    const settings: AISettings = { ...DEFAULT_AI_SETTINGS, kind: 'server' };
    const deltas: string[] = [];
    let cost = -1;
    let done = false;
    await chatStream(
      settings,
      [{ role: 'user', content: 'hi' }],
      { serverUrl: 'http://localhost:4000', bearerToken: 'tok' },
      {
        onDelta: (c) => deltas.push(c),
        onUsage: (u) => {
          cost = u.costUsd ?? -1;
        },
        onDone: () => {
          done = true;
        },
      },
    );

    assert.deepEqual(deltas, ['Hel', 'lo']);
    assert.equal(cost, 0.002);
    assert.equal(done, true);
    // The request must opt into streaming.
    assert.equal((sentBody as { stream?: boolean }).stream, true);

    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });

  it('surfaces a non-ok HTTP response (e.g. 429) via onError', async () => {
    const originalFetch = (globalThis as Record<string, unknown>)['fetch'];
    (globalThis as Record<string, unknown>)['fetch'] = async () =>
      new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'cap reached' } }), {
        status: 429,
      });

    const settings: AISettings = { ...DEFAULT_AI_SETTINGS, kind: 'server' };
    let code = '';
    let message = '';
    await chatStream(
      settings,
      [{ role: 'user', content: 'hi' }],
      { serverUrl: 'http://localhost:4000', bearerToken: 'tok' },
      {
        onError: (c, m) => {
          code = c;
          message = m;
        },
      },
    );
    assert.equal(code, 'RATE_LIMITED');
    assert.equal(message, 'cap reached');

    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Provider selection: local with empty endpoint → throws, no network
// ---------------------------------------------------------------------------

describe('chat() with kind=local and empty endpoint', () => {
  it('throws without network call when endpoint is not configured', async () => {
    const originalFetch = (globalThis as Record<string, unknown>)['fetch'];
    let fetchCalled = false;
    (globalThis as Record<string, unknown>)['fetch'] = () => {
      fetchCalled = true;
      return Promise.resolve(new Response('{}'));
    };

    const settings: AISettings = {
      ...DEFAULT_AI_SETTINGS,
      kind: 'local',
      localEndpoint: '',
    };
    await assert.rejects(() => chat(settings, [{ role: 'user', content: 'hello' }]));

    assert.equal(fetchCalled, false, 'fetch should not have been called with empty endpoint');

    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Prompt builders
// ---------------------------------------------------------------------------

describe('buildPrompt()', () => {
  const NOTE = 'This note is about graph theory and knowledge management.';
  const TITLES = ['Graph basics', 'Zettelkasten method', 'PKM tools'];

  it('summarize: has system + user with note content', () => {
    const msgs = buildPrompt('summarize', NOTE);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].role, 'user');
    assert.ok(msgs[1].content.includes(NOTE));
    assert.ok(msgs[1].content.toLowerCase().includes('summarize'));
  });

  it('find-related: includes note titles', () => {
    const msgs = buildPrompt('find-related', NOTE, TITLES);
    assert.equal(msgs.length, 2);
    assert.ok(msgs[1].content.includes('Graph basics'));
    assert.ok(msgs[1].content.includes('Zettelkasten method'));
  });

  it('find-related: without titles still includes note', () => {
    const msgs = buildPrompt('find-related', NOTE);
    assert.equal(msgs.length, 2);
    assert.ok(msgs[1].content.includes(NOTE));
  });

  it('suggest-links: includes note titles and wikilink instruction', () => {
    const msgs = buildPrompt('suggest-links', NOTE, TITLES);
    assert.ok(msgs[1].content.includes('[[wikilink]]'));
    assert.ok(msgs[1].content.includes('PKM tools'));
  });

  it('suggest-tags: asks for #tags format', () => {
    const msgs = buildPrompt('suggest-tags', NOTE);
    assert.ok(msgs[1].content.includes('#tags'));
  });

  it('outline: asks for Markdown headings', () => {
    const msgs = buildPrompt('outline', NOTE);
    assert.ok(msgs[1].content.toLowerCase().includes('outline'));
    assert.ok(msgs[1].content.includes('##'));
  });
});

// ---------------------------------------------------------------------------
// 6. Send-context builders
// ---------------------------------------------------------------------------

describe('buildSendContext()', () => {
  const NOTE = 'short note';
  const TITLES = ['A', 'B', 'C'];

  it('summarize: describes note + char count', () => {
    const ctx = buildSendContext('summarize', NOTE);
    assert.ok(ctx.description.includes('note'));
    assert.ok(ctx.description.includes(String(NOTE.length)));
    assert.equal(ctx.text, NOTE);
  });

  it('find-related: describes note + title count when titles provided', () => {
    const ctx = buildSendContext('find-related', NOTE, TITLES);
    assert.ok(ctx.description.includes('3 note titles'));
  });

  it('find-related: no title count when no titles', () => {
    const ctx = buildSendContext('find-related', NOTE);
    assert.ok(!ctx.description.includes('note titles'));
  });

  it('suggest-links: includes title count', () => {
    const ctx = buildSendContext('suggest-links', NOTE, TITLES);
    assert.ok(ctx.description.includes('3 note titles'));
  });

  it('outline: describes note char count', () => {
    const ctx = buildSendContext('outline', NOTE);
    assert.ok(ctx.description.includes(String(NOTE.length)));
  });
});

// ---------------------------------------------------------------------------
// 7. truncateContext
// ---------------------------------------------------------------------------

describe('truncateContext()', () => {
  it('returns short text unchanged', () => {
    const short = 'hello world';
    assert.equal(truncateContext(short), short);
  });

  it('truncates text over 32000 chars and appends a notice', () => {
    const long = 'a'.repeat(40_000);
    const result = truncateContext(long);
    assert.ok(result.length < long.length);
    assert.ok(result.includes('truncated'));
    // Should start with the first 32000 chars.
    assert.equal(result.slice(0, 32_000), 'a'.repeat(32_000));
  });
});

// ---------------------------------------------------------------------------
// 8. redactKey
// ---------------------------------------------------------------------------

describe('redactKey()', () => {
  it('keeps first 4 chars and replaces the rest', () => {
    const result = redactKey('sk-abc123def456');
    assert.equal(result, 'sk-a****');
  });

  it('short keys are fully redacted', () => {
    assert.equal(redactKey('abc'), '****');
    assert.equal(redactKey(''), '****');
  });

  it('exactly 4 chars is also redacted', () => {
    // The invariant: length <= 4 → fully redacted.
    assert.equal(redactKey('abcd'), '****');
  });
});

// ---------------------------------------------------------------------------
// 9. Settings persistence round-trip
// ---------------------------------------------------------------------------

describe('AI settings persistence', () => {
  it('round-trips server settings through sessionStorage', () => {
    const settings: AISettings = {
      ...DEFAULT_AI_SETTINGS,
      kind: 'server',
      serverModel: 'openai/gpt-4o-mini',
    };

    saveAISettings(settings);
    const loaded = loadAISettings();

    assert.equal(loaded.kind, 'server');
    assert.equal(loaded.serverModel, 'openai/gpt-4o-mini');
  });

  it('round-trips local settings through sessionStorage', () => {
    const settings: AISettings = {
      ...DEFAULT_AI_SETTINGS,
      kind: 'local',
      localEndpoint: 'http://localhost:11434/v1',
      localModel: 'llama3',
    };

    saveAISettings(settings);
    const loaded = loadAISettings();

    assert.equal(loaded.kind, 'local');
    assert.equal(loaded.localEndpoint, 'http://localhost:11434/v1');
    assert.equal(loaded.localModel, 'llama3');
  });

  it('returns defaults when nothing is stored', () => {
    const loaded = loadAISettings();
    assert.equal(loaded.kind, 'off');
    assert.equal(loaded.serverModel, '');
  });

  it('clearAISettings removes stored data', () => {
    saveAISettings({ ...DEFAULT_AI_SETTINGS, kind: 'local' });
    clearAISettings();
    const loaded = loadAISettings();
    assert.equal(loaded.kind, 'off');
  });

  it('partial persisted data merges with defaults', () => {
    // Simulate a persisted partial object (e.g. from an old schema).
    const raw = JSON.stringify({ kind: 'local', localModel: 'mistral' });
    (globalThis as Record<string, unknown>)['window'] = {
      sessionStorage: {
        getItem: () => raw,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    };
    const loaded = loadAISettings();
    assert.equal(loaded.kind, 'local');
    assert.equal(loaded.localModel, 'mistral');
    // Defaults for un-persisted fields must still be present.
    assert.equal(loaded.serverModel, DEFAULT_AI_SETTINGS.serverModel);
  });

  it('legacy byok kind is migrated to off', () => {
    // Simulate old data with kind='byok' (from before the server-proxy migration).
    const raw = JSON.stringify({ kind: 'byok', byokKey: 'sk-old' });
    (globalThis as Record<string, unknown>)['window'] = {
      sessionStorage: {
        getItem: () => raw,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    };
    const loaded = loadAISettings();
    // Must be migrated to 'off' — the client-side key path no longer exists.
    assert.equal(loaded.kind, 'off');
  });
});
