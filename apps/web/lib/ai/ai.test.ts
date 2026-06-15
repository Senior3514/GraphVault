/**
 * Tests for the AI assistant lib layer.
 *
 * Covers:
 *  1. Provider selection invariant: kind=off → no network, always throws.
 *  2. Prompt builder correctness for every action.
 *  3. Send-context builder correctness.
 *  4. truncateContext respects the MAX_CONTEXT_CHARS limit.
 *  5. redactKey helper.
 *  6. Settings persistence round-trip (mocked sessionStorage).
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { buildPrompt, buildSendContext } from './prompts.js';
import { chat, truncateContext } from './providers.js';
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

describe('chat() with kind=byok and empty key', () => {
  it('throws without network call when key is missing', async () => {
    const originalFetch = (globalThis as Record<string, unknown>)['fetch'];
    let fetchCalled = false;
    (globalThis as Record<string, unknown>)['fetch'] = () => {
      fetchCalled = true;
      return Promise.resolve(new Response('{}'));
    };

    const settings: AISettings = {
      ...DEFAULT_AI_SETTINGS,
      kind: 'byok',
      byokKey: '',
    };
    await assert.rejects(
      () => chat(settings, [{ role: 'user', content: 'hello' }]),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.toLowerCase().includes('key'), `Expected "key" in: ${err.message}`);
        return true;
      },
    );

    assert.equal(fetchCalled, false, 'fetch should not have been called with empty key');

    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });
});

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
// 2. Prompt builders
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
// 3. Send-context builders
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
// 4. truncateContext
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
// 5. redactKey
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
// 6. Settings persistence round-trip
// ---------------------------------------------------------------------------

describe('AI settings persistence', () => {
  it('round-trips settings through sessionStorage', () => {
    const settings: AISettings = {
      ...DEFAULT_AI_SETTINGS,
      kind: 'byok',
      byokKey: 'sk-testkey',
      byokModel: 'claude-sonnet-4-6',
    };

    saveAISettings(settings);
    const loaded = loadAISettings();

    assert.equal(loaded.kind, 'byok');
    assert.equal(loaded.byokKey, 'sk-testkey');
    assert.equal(loaded.byokModel, 'claude-sonnet-4-6');
  });

  it('returns defaults when nothing is stored', () => {
    const loaded = loadAISettings();
    assert.equal(loaded.kind, 'off');
    assert.equal(loaded.byokKey, '');
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
    assert.equal(loaded.byokBackend, DEFAULT_AI_SETTINGS.byokBackend);
  });
});
