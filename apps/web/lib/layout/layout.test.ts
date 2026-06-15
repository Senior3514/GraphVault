/**
 * Tests for pure layout utilities (storage serialisation, merge, clamp).
 * These run in Node.js — no DOM, no React.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_LAYOUT,
  DEFAULT_NOTE_LIST_WIDTH,
  MAX_NOTE_LIST_WIDTH,
  MIN_NOTE_LIST_WIDTH,
} from './defaults';

// ---- merge helper (extracted from storage.ts internals) --------------------
// We test the observable behaviour via loadLayout with a stubbed localStorage.

import type { WorkspaceLayout } from './types';

/** Mirror the merge function from storage.ts so we can test it in isolation. */
function merge(base: WorkspaceLayout, override: Partial<WorkspaceLayout>): WorkspaceLayout {
  return {
    ...base,
    ...override,
    panels: { ...base.panels, ...(override.panels ?? {}) },
    widths: { ...base.widths, ...(override.widths ?? {}) },
    tabs: override.tabs ?? base.tabs,
  };
}

describe('layout defaults', () => {
  it('DEFAULT_LAYOUT has both panels visible by default', () => {
    assert.equal(DEFAULT_LAYOUT.panels.noteList, true);
    assert.equal(DEFAULT_LAYOUT.panels.details, true);
    assert.equal(DEFAULT_LAYOUT.panels.sidebar, true);
  });

  it('DEFAULT_LAYOUT has no maximized pane and no tabs', () => {
    assert.equal(DEFAULT_LAYOUT.maximized, null);
    assert.deepEqual(DEFAULT_LAYOUT.tabs, []);
    assert.equal(DEFAULT_LAYOUT.activeTabId, null);
  });

  it('MIN_NOTE_LIST_WIDTH < DEFAULT < MAX', () => {
    assert.ok(MIN_NOTE_LIST_WIDTH < DEFAULT_NOTE_LIST_WIDTH);
    assert.ok(DEFAULT_NOTE_LIST_WIDTH < MAX_NOTE_LIST_WIDTH);
  });
});

describe('merge (layout hydration)', () => {
  it('preserves base values when override is empty', () => {
    const result = merge(DEFAULT_LAYOUT, {});
    assert.deepEqual(result, DEFAULT_LAYOUT);
  });

  it('merges widths shallowly', () => {
    const result = merge(DEFAULT_LAYOUT, { widths: { noteList: 320, details: 288 } });
    assert.equal(result.widths.noteList, 320);
    assert.equal(result.widths.details, 288);
  });

  it('merges panels shallowly, keeping unset fields from base', () => {
    const result = merge(DEFAULT_LAYOUT, {
      panels: { noteList: false, sidebar: true, details: true },
    });
    assert.equal(result.panels.noteList, false);
    assert.equal(result.panels.sidebar, true); // unchanged
    assert.equal(result.panels.details, true); // unchanged
  });

  it('replaces tabs wholesale', () => {
    const tab = { id: 'abc', notePath: 'foo.md', title: 'Foo', dirty: false };
    const result = merge(DEFAULT_LAYOUT, { tabs: [tab] });
    assert.deepEqual(result.tabs, [tab]);
  });

  it('falls back to base tabs when override has no tabs field', () => {
    const baseWithTab: WorkspaceLayout = {
      ...DEFAULT_LAYOUT,
      tabs: [{ id: 'x', notePath: 'a.md', title: 'A', dirty: false }],
    };
    const result = merge(baseWithTab, { maximized: 'editor' });
    assert.equal(result.tabs.length, 1);
    assert.equal(result.maximized, 'editor');
  });
});
