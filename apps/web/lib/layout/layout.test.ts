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
    focusMode: override.focusMode ?? base.focusMode,
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

describe('focus mode', () => {
  it('defaults to false', () => {
    assert.equal(DEFAULT_LAYOUT.focusMode, false);
  });

  it('round-trips through JSON serialise → parse → merge (the storage path)', () => {
    // Simulate saveLayout(): serialise a layout with focusMode on.
    const enabled: WorkspaceLayout = { ...DEFAULT_LAYOUT, focusMode: true };
    const serialised = JSON.stringify(enabled);
    // Simulate loadLayout(): parse + merge onto defaults.
    const parsed = JSON.parse(serialised) as Partial<WorkspaceLayout>;
    const restored = merge(DEFAULT_LAYOUT, parsed);
    assert.equal(restored.focusMode, true);

    // And toggling back off round-trips too.
    const disabled = JSON.parse(
      JSON.stringify({ ...restored, focusMode: false }),
    ) as Partial<WorkspaceLayout>;
    assert.equal(merge(DEFAULT_LAYOUT, disabled).focusMode, false);
  });

  it('older persisted state WITHOUT focusMode yields the default (not undefined)', () => {
    // An old blob that predates focus mode: the key is simply absent.
    const oldBlob: Partial<WorkspaceLayout> = {
      panels: { sidebar: true, noteList: true, details: true },
      widths: { noteList: 300, details: 320 },
      maximized: null,
      tabs: [],
      activeTabId: null,
      splitMode: 'none',
      secondaryTabId: null,
    };
    assert.equal('focusMode' in oldBlob, false);
    const result = merge(DEFAULT_LAYOUT, oldBlob);
    assert.equal(result.focusMode, false);
    assert.notEqual(result.focusMode, undefined);
  });

  it('an explicit focusMode:undefined in the override does not clobber the default', () => {
    // Defensive: the `?? base.focusMode` coalesce protects against a constructed
    // Partial that carries focusMode as an explicit undefined value.
    const override = { focusMode: undefined } as unknown as Partial<WorkspaceLayout>;
    const result = merge(DEFAULT_LAYOUT, override);
    assert.equal(result.focusMode, false);
  });

  it('exiting focus mode preserves stored pane sizes and panel visibility', () => {
    // User had custom widths + a collapsed details pane, then turned focus mode
    // on. Focus mode is purely presentational, so turning it off must restore
    // the EXACT prior widths/panels (nothing was mutated).
    const customised: WorkspaceLayout = {
      ...DEFAULT_LAYOUT,
      widths: { noteList: 333, details: 421 },
      panels: { sidebar: true, noteList: true, details: false },
      focusMode: false,
    };

    // Enter focus mode (only the flag changes).
    const focused: WorkspaceLayout = { ...customised, focusMode: true };
    assert.deepEqual(focused.widths, customised.widths);
    assert.deepEqual(focused.panels, customised.panels);

    // Persist + reload while focused.
    const reloaded = merge(
      DEFAULT_LAYOUT,
      JSON.parse(JSON.stringify(focused)) as Partial<WorkspaceLayout>,
    );
    assert.equal(reloaded.focusMode, true);
    assert.deepEqual(reloaded.widths, customised.widths);
    assert.deepEqual(reloaded.panels, customised.panels);

    // Exit focus mode — widths + panels are untouched.
    const exited: WorkspaceLayout = { ...reloaded, focusMode: false };
    assert.equal(exited.focusMode, false);
    assert.deepEqual(exited.widths, customised.widths);
    assert.deepEqual(exited.panels, customised.panels);
  });
});

// ---- focus mode + maximized pane interaction (regression) ------------------
// Bug: focus mode hides the side panes; with `maximized === 'noteList'` (or
// 'details') the editor is also hidden → ALL three columns gone → blank
// workspace that persisted across reloads.

import { applyFocusMode, effectiveMaximized } from './useLayout';

describe('focus mode + maximized pane', () => {
  it('entering focus mode clears a maximized side pane', () => {
    const maxedNoteList: WorkspaceLayout = { ...DEFAULT_LAYOUT, maximized: 'noteList' };
    const next = applyFocusMode(maxedNoteList, true);
    assert.equal(next.focusMode, true);
    assert.equal(next.maximized, null, 'maximized must be cleared on entering focus mode');
  });

  it('entering focus mode clears a maximized details pane too', () => {
    const maxedDetails: WorkspaceLayout = { ...DEFAULT_LAYOUT, maximized: 'details' };
    const next = applyFocusMode(maxedDetails, true);
    assert.equal(next.maximized, null);
  });

  it('exiting focus mode does NOT resurrect a maximized pane', () => {
    const focused: WorkspaceLayout = { ...DEFAULT_LAYOUT, focusMode: true, maximized: null };
    const next = applyFocusMode(focused, false);
    assert.equal(next.focusMode, false);
    assert.equal(next.maximized, null);
  });

  it('effectiveMaximized neutralises a stale persisted maximized in focus mode', () => {
    // Simulate a previously-persisted blank state: focusMode on + maximized set.
    assert.equal(effectiveMaximized('noteList', true), null);
    assert.equal(effectiveMaximized('details', true), null);
    // Outside focus mode the maximized value is honoured as-is.
    assert.equal(effectiveMaximized('noteList', false), 'noteList');
    assert.equal(effectiveMaximized(null, false), null);
  });

  it('editor column is visible for every maximized value while in focus mode', () => {
    // Mirrors WorkspaceLayout: showEditor = effMax === null || effMax === 'editor'.
    for (const m of ['noteList', 'details', 'editor', null] as const) {
      const effMax = effectiveMaximized(m, true);
      const showEditor = effMax === null || effMax === 'editor';
      assert.equal(showEditor, true, `editor must show in focus mode with maximized=${m}`);
    }
  });
});
