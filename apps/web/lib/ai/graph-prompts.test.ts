/**
 * Tests for the AI graph-intelligence prompt builders and parsers.
 *
 * Covers:
 *  1. `buildClusterNamePrompt` — shape, privacy (no bodies), edge cases.
 *  2. `parseClusterNames`      — numbered list, bulleted list, partial output.
 *  3. `buildRelatedNotesPrompt` — shape, title truncation, empty vault.
 *  4. `parseRelatedNotes`       — bold format, plain format, ID resolution,
 *                                 hallucinated titles, max-6 cap.
 *  5. `buildGapFindingPrompt`   — shape, empty neighbourhood.
 *  6. `parseGapSuggestions`     — numbered, bulleted, quote-stripped, max-6 cap.
 *  7. `buildGraphSendContext`   — all three action types.
 *  8. Privacy invariant: when AI is off, no network call occurs.
 *     (Re-uses the existing chat() off-guard, confirmed here for completeness.)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildClusterNamePrompt,
  parseClusterNames,
  buildRelatedNotesPrompt,
  parseRelatedNotes,
  buildGapFindingPrompt,
  parseGapSuggestions,
  buildGraphSendContext,
  MAX_TITLES_PER_CLUSTER,
  MAX_CLUSTERS_TO_NAME,
  MAX_VAULT_TITLES_IN_PROMPT,
  type ClusterInput,
} from './graph-prompts.js';

import { chat } from './providers.js';
import { DEFAULT_AI_SETTINGS } from './types.js';

// ---------------------------------------------------------------------------
// 1. buildClusterNamePrompt
// ---------------------------------------------------------------------------

describe('buildClusterNamePrompt()', () => {
  it('returns 2 messages (system + user)', () => {
    const clusters: ClusterInput[] = [
      { index: 0, titles: ['Graph Theory', 'Network Analysis'] },
      { index: 1, titles: ['Machine Learning', 'Neural Networks', 'Deep Learning'] },
    ];
    const msgs = buildClusterNamePrompt(clusters);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].role, 'user');
  });

  it('includes cluster count and titles in the user message', () => {
    const clusters: ClusterInput[] = [{ index: 0, titles: ['Note A', 'Note B'] }];
    const msgs = buildClusterNamePrompt(clusters);
    const user = msgs[1].content;
    assert.ok(user.includes('1 connected cluster'));
    assert.ok(user.includes('Note A'));
    assert.ok(user.includes('Note B'));
  });

  it('truncates titles per cluster to MAX_TITLES_PER_CLUSTER', () => {
    const manyTitles = Array.from({ length: MAX_TITLES_PER_CLUSTER + 5 }, (_, i) => `Note ${i}`);
    const clusters: ClusterInput[] = [{ index: 0, titles: manyTitles }];
    const msgs = buildClusterNamePrompt(clusters);
    const user = msgs[1].content;
    // Should include the "+5 more" indicator.
    assert.ok(user.includes(`+5 more`));
  });

  it('asks for a numbered list in the same order', () => {
    const clusters: ClusterInput[] = [
      { index: 0, titles: ['A'] },
      { index: 1, titles: ['B'] },
    ];
    const msgs = buildClusterNamePrompt(clusters);
    assert.ok(msgs[1].content.includes('numbered list'));
    assert.ok(msgs[1].content.includes('1. <name for Cluster 1>'));
  });

  it('handles empty cluster list gracefully', () => {
    const msgs = buildClusterNamePrompt([]);
    assert.equal(msgs.length, 2);
    assert.ok(msgs[1].content.includes('No clusters'));
  });

  it('NEVER mentions note bodies — only the word "TITLES" appears in the privacy section', () => {
    const clusters: ClusterInput[] = [{ index: 0, titles: ['My private note', 'Another note'] }];
    const msgs = buildClusterNamePrompt(clusters);
    // The system prompt must reference titles only.
    assert.ok(msgs[0].content.toLowerCase().includes('titles'));
    assert.ok(msgs[0].content.toLowerCase().includes('never see or repeat note body'));
  });

  it('limits to MAX_CLUSTERS_TO_NAME constant exported correctly', () => {
    // Just verify the constant is a positive integer <= 20.
    assert.ok(typeof MAX_CLUSTERS_TO_NAME === 'number');
    assert.ok(MAX_CLUSTERS_TO_NAME > 0 && MAX_CLUSTERS_TO_NAME <= 20);
  });
});

// ---------------------------------------------------------------------------
// 2. parseClusterNames
// ---------------------------------------------------------------------------

describe('parseClusterNames()', () => {
  it('parses a numbered list', () => {
    const raw = '1. Knowledge Management\n2. Machine Learning\n3. Creative Writing';
    const names = parseClusterNames(raw, 3);
    assert.deepEqual(names, ['Knowledge Management', 'Machine Learning', 'Creative Writing']);
  });

  it('parses a bulleted list', () => {
    const raw = '- Graph Theory\n- Project Planning';
    const names = parseClusterNames(raw, 2);
    assert.deepEqual(names, ['Graph Theory', 'Project Planning']);
  });

  it('parses mixed format (numbered + bare lines)', () => {
    const raw = '1. First Cluster\nSecond Cluster';
    const names = parseClusterNames(raw, 2);
    assert.deepEqual(names, ['First Cluster', 'Second Cluster']);
  });

  it('respects expectedCount cap', () => {
    const raw = '1. A\n2. B\n3. C\n4. D';
    const names = parseClusterNames(raw, 2);
    assert.equal(names.length, 2);
    assert.equal(names[0], 'A');
  });

  it('returns partial result when model returns fewer names than expected', () => {
    const raw = '1. Only One Name';
    const names = parseClusterNames(raw, 5);
    assert.equal(names.length, 1);
    assert.equal(names[0], 'Only One Name');
  });

  it('returns empty array for empty raw string', () => {
    assert.deepEqual(parseClusterNames('', 3), []);
  });

  it('returns empty array for expectedCount <= 0', () => {
    assert.deepEqual(parseClusterNames('1. Something', 0), []);
    assert.deepEqual(parseClusterNames('1. Something', -1), []);
  });

  it('strips asterisk bullets', () => {
    const raw = '* Alpha\n* Beta';
    const names = parseClusterNames(raw, 2);
    assert.deepEqual(names, ['Alpha', 'Beta']);
  });
});

// ---------------------------------------------------------------------------
// 3. buildRelatedNotesPrompt
// ---------------------------------------------------------------------------

describe('buildRelatedNotesPrompt()', () => {
  const SELECTED = 'Graph Theory Fundamentals';
  const NEIGHBOURS = ['Network Topology', 'Directed Graphs'];
  const ALL = [
    'Graph Theory Fundamentals',
    'Network Topology',
    'Directed Graphs',
    'Linear Algebra',
    'Statistics',
  ];

  it('returns 2 messages (system + user)', () => {
    const msgs = buildRelatedNotesPrompt(SELECTED, NEIGHBOURS, ALL);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].role, 'user');
  });

  it('includes the selected title', () => {
    const msgs = buildRelatedNotesPrompt(SELECTED, NEIGHBOURS, ALL);
    assert.ok(msgs[1].content.includes(SELECTED));
  });

  it('includes neighbour titles', () => {
    const msgs = buildRelatedNotesPrompt(SELECTED, NEIGHBOURS, ALL);
    assert.ok(msgs[1].content.includes('Network Topology'));
    assert.ok(msgs[1].content.includes('Directed Graphs'));
  });

  it('includes vault titles', () => {
    const msgs = buildRelatedNotesPrompt(SELECTED, NEIGHBOURS, ALL);
    assert.ok(msgs[1].content.includes('Linear Algebra'));
    assert.ok(msgs[1].content.includes('Statistics'));
  });

  it('handles empty neighbours gracefully', () => {
    const msgs = buildRelatedNotesPrompt(SELECTED, [], ALL);
    assert.ok(msgs[1].content.includes('No notes are currently linked'));
  });

  it('handles empty vault gracefully', () => {
    const msgs = buildRelatedNotesPrompt(SELECTED, [], []);
    assert.ok(msgs[1].content.includes('Vault is empty'));
  });

  it('truncates vault titles to MAX_VAULT_TITLES_IN_PROMPT', () => {
    const totalCount = MAX_VAULT_TITLES_IN_PROMPT + 50;
    const hugeVault = Array.from({ length: totalCount }, (_, i) => `Note ${i}`);
    const msgs = buildRelatedNotesPrompt(SELECTED, [], hugeVault);
    // The prompt says "X total, showing Y" — verify total count and showing count.
    assert.ok(
      msgs[1].content.includes(`${totalCount} total`),
      `Expected total count ${totalCount} in prompt`,
    );
    assert.ok(
      msgs[1].content.includes(`showing ${MAX_VAULT_TITLES_IN_PROMPT}`),
      `Expected "showing ${MAX_VAULT_TITLES_IN_PROMPT}" in prompt`,
    );
  });

  it('instructs model to use bold title format', () => {
    const msgs = buildRelatedNotesPrompt(SELECTED, NEIGHBOURS, ALL);
    assert.ok(msgs[1].content.includes('**<title>**'));
  });
});

// ---------------------------------------------------------------------------
// 4. parseRelatedNotes
// ---------------------------------------------------------------------------

describe('parseRelatedNotes()', () => {
  const titleToId = new Map<string, string>([
    ['linear algebra', 'id-linear-algebra'],
    ['statistics', 'id-statistics'],
    ['number theory', 'id-number-theory'],
  ]);

  it('parses bold format correctly', () => {
    const raw =
      '- **Linear Algebra**: Shares fundamental matrix concepts.\n- **Statistics**: Related through probability theory.';
    const results = parseRelatedNotes(raw, titleToId);
    assert.equal(results.length, 2);
    assert.equal(results[0].title, 'Linear Algebra');
    assert.equal(results[0].reason, 'Shares fundamental matrix concepts.');
    assert.equal(results[0].nodeId, 'id-linear-algebra');
  });

  it('parses plain "Title: Reason" format', () => {
    const raw = 'Statistics: Useful for graph metrics.';
    const results = parseRelatedNotes(raw, titleToId);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Statistics');
    assert.equal(results[0].reason, 'Useful for graph metrics.');
    assert.equal(results[0].nodeId, 'id-statistics');
  });

  it('parses numbered list', () => {
    const raw = '1. **Number Theory**: Deeply connected.\n2. **Statistics**: Important overlap.';
    const results = parseRelatedNotes(raw, titleToId);
    assert.equal(results.length, 2);
    assert.equal(results[0].title, 'Number Theory');
    assert.equal(results[0].nodeId, 'id-number-theory');
  });

  it('returns undefined nodeId for hallucinated title', () => {
    const raw = '- **Quantum Computing**: Some reason.';
    const results = parseRelatedNotes(raw, titleToId);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Quantum Computing');
    assert.equal(results[0].nodeId, undefined);
  });

  it('caps at 6 results', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `- **Note ${i}**: Reason ${i}.`).join('\n');
    const results = parseRelatedNotes(lines, new Map());
    assert.equal(results.length, 6);
  });

  it('returns empty array for empty raw string', () => {
    assert.deepEqual(parseRelatedNotes('', titleToId), []);
  });

  it('skips malformed lines without title:reason separation', () => {
    const raw = 'Just a bare line with no colon\n- **Good**: Valid reason.';
    const results = parseRelatedNotes(raw, titleToId);
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Good');
  });
});

// ---------------------------------------------------------------------------
// 5. buildGapFindingPrompt
// ---------------------------------------------------------------------------

describe('buildGapFindingPrompt()', () => {
  const SELECTED = 'Machine Learning Overview';
  const NEIGHBOURS = ['Neural Networks', 'Backpropagation', 'Gradient Descent'];

  it('returns 2 messages (system + user)', () => {
    const msgs = buildGapFindingPrompt(SELECTED, NEIGHBOURS);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[1].role, 'user');
  });

  it('includes the selected title', () => {
    const msgs = buildGapFindingPrompt(SELECTED, NEIGHBOURS);
    assert.ok(msgs[1].content.includes(SELECTED));
  });

  it('includes neighbourhood titles', () => {
    const msgs = buildGapFindingPrompt(SELECTED, NEIGHBOURS);
    assert.ok(msgs[1].content.includes('Neural Networks'));
    assert.ok(msgs[1].content.includes('Gradient Descent'));
  });

  it('asks for notes that do NOT exist yet', () => {
    const msgs = buildGapFindingPrompt(SELECTED, NEIGHBOURS);
    assert.ok(msgs[1].content.toLowerCase().includes("don't exist yet"));
  });

  it('handles empty neighbourhood gracefully', () => {
    const msgs = buildGapFindingPrompt(SELECTED, []);
    assert.ok(msgs[1].content.includes('No notes are currently linked'));
  });

  it('NEVER sends note bodies (system prompt enforces titles-only)', () => {
    const msgs = buildGapFindingPrompt(SELECTED, NEIGHBOURS);
    assert.ok(msgs[0].content.includes('TITLES'));
  });
});

// ---------------------------------------------------------------------------
// 6. parseGapSuggestions
// ---------------------------------------------------------------------------

describe('parseGapSuggestions()', () => {
  it('parses a numbered list', () => {
    const raw = '1. Regularisation Techniques\n2. Model Evaluation Metrics\n3. Feature Engineering';
    const suggestions = parseGapSuggestions(raw);
    assert.deepEqual(suggestions, [
      'Regularisation Techniques',
      'Model Evaluation Metrics',
      'Feature Engineering',
    ]);
  });

  it('parses a bulleted list', () => {
    const raw = '- Bias-Variance Tradeoff\n- Ensemble Methods';
    const suggestions = parseGapSuggestions(raw);
    assert.deepEqual(suggestions, ['Bias-Variance Tradeoff', 'Ensemble Methods']);
  });

  it('strips surrounding bold markers', () => {
    const raw = '1. **Activation Functions**\n2. **Dropout Regularisation**';
    const suggestions = parseGapSuggestions(raw);
    assert.deepEqual(suggestions, ['Activation Functions', 'Dropout Regularisation']);
  });

  it('strips surrounding quotes', () => {
    const raw = '1. "Transfer Learning"';
    const suggestions = parseGapSuggestions(raw);
    assert.equal(suggestions[0], 'Transfer Learning');
  });

  it('caps at 6 suggestions', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `${i + 1}. Suggestion ${i}`).join('\n');
    const suggestions = parseGapSuggestions(raw);
    assert.equal(suggestions.length, 6);
  });

  it('returns empty array for empty raw string', () => {
    assert.deepEqual(parseGapSuggestions(''), []);
  });

  it('skips lines longer than 120 chars', () => {
    const long = 'A'.repeat(121);
    const short = 'Short Title';
    const raw = `1. ${long}\n2. ${short}`;
    const suggestions = parseGapSuggestions(raw);
    // long line exceeds 120 chars and is skipped.
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0], short);
  });
});

// ---------------------------------------------------------------------------
// 7. buildGraphSendContext
// ---------------------------------------------------------------------------

describe('buildGraphSendContext()', () => {
  it('cluster-names: describes cluster count', () => {
    const ctx = buildGraphSendContext('cluster-names', { clusterCount: 5 });
    assert.ok(ctx.description.includes('5'));
    assert.ok(ctx.detail.includes('no note content'));
  });

  it('related-notes: describes selected title + counts', () => {
    const ctx = buildGraphSendContext('related-notes', {
      selectedTitle: 'My Note',
      neighbourCount: 3,
      totalTitles: 120,
    });
    assert.ok(ctx.description.includes('My Note'));
    assert.ok(ctx.description.includes('3'));
    assert.ok(ctx.description.includes('120'));
    assert.ok(ctx.detail.includes('no note content'));
  });

  it('find-gaps: describes selected title + neighbour count', () => {
    const ctx = buildGraphSendContext('find-gaps', {
      selectedTitle: 'Knowledge Graph',
      neighbourCount: 7,
    });
    assert.ok(ctx.description.includes('Knowledge Graph'));
    assert.ok(ctx.description.includes('7'));
    assert.ok(ctx.detail.includes('no note content'));
  });
});

// ---------------------------------------------------------------------------
// 8. Privacy invariant: AI off = zero network
// ---------------------------------------------------------------------------

describe('privacy invariant: kind=off blocks all graph AI', () => {
  it('chat() with kind=off throws without network (exhaustive guard)', async () => {
    const originalFetch = (globalThis as Record<string, unknown>)['fetch'];
    let fetchCalled = false;
    (globalThis as Record<string, unknown>)['fetch'] = () => {
      fetchCalled = true;
      return Promise.resolve(new Response('{}'));
    };

    const msgs = buildClusterNamePrompt([{ index: 0, titles: ['A', 'B'] }]);

    await assert.rejects(
      () => chat({ ...DEFAULT_AI_SETTINGS, kind: 'off' }, msgs),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('disabled'));
        return true;
      },
    );

    assert.equal(fetchCalled, false, 'fetch must NOT be called when kind=off');

    if (originalFetch === undefined) {
      delete (globalThis as Record<string, unknown>)['fetch'];
    } else {
      (globalThis as Record<string, unknown>)['fetch'] = originalFetch;
    }
  });
});
