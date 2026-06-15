'use client';

/**
 * React state layer over the pure vault operations + persistence store.
 *
 * Owns the canonical notes array, derived index (parsed notes, backlinks,
 * search), and autosave. UI components call the returned mutators; this hook
 * keeps state immutable and persists asynchronously so a render never blocks on
 * storage. The pure operations live in `vault.ts`; this is just glue + effects.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { computeBacklinks, type Backlink } from './links';
import { NoteSearchIndex, type SearchResult } from './search';
import { LocalStorageVaultStore } from './store';
import type { IndexedNote, Note, NotePath } from './types';
import {
  createNote as createNoteOp,
  deleteNote as deleteNoteOp,
  indexNotes,
  renameNote as renameNoteOp,
  updateNoteContent as updateNoteContentOp,
} from './vault';

const store = new LocalStorageVaultStore();

export interface UseVault {
  ready: boolean;
  notes: IndexedNote[];
  getNote(path: NotePath): IndexedNote | undefined;
  backlinksFor(path: NotePath): Backlink[];
  search(query: string): SearchResult[];
  resolveLink(target: string): NotePath | null;
  createNote(path: string, content?: string): Note;
  updateContent(path: NotePath, content: string): void;
  renameNote(from: NotePath, to: string): NotePath;
  deleteNote(path: NotePath): void;
  resetVault(): Promise<void>;
}

export function useVault(): UseVault {
  const [rawNotes, setRawNotes] = useState<Note[]>([]);
  const [ready, setReady] = useState(false);
  const searchIndex = useRef<NoteSearchIndex | null>(null);

  // Initial load from the persistence store (seeds on first run).
  useEffect(() => {
    let active = true;
    store.load().then((loaded) => {
      if (!active) return;
      setRawNotes(loaded);
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const notes = useMemo(() => indexNotes(rawNotes), [rawNotes]);

  // Keep the search index in sync with the current notes.
  useEffect(() => {
    if (!searchIndex.current) {
      searchIndex.current = new NoteSearchIndex(notes);
    } else {
      searchIndex.current.replaceAll(notes);
    }
  }, [notes]);

  const backlinks = useMemo(() => computeBacklinks(notes), [notes]);

  const resolver = useMemo(() => {
    const byKey = new Map<string, NotePath>();
    for (const n of notes) {
      const add = (k: string) => {
        const key = k.trim().toLowerCase();
        if (key && !byKey.has(key)) byKey.set(key, n.path);
      };
      add(n.path.replace(/\.md$/i, ''));
      add(n.path.replace(/\.md$/i, '').split('/').pop() ?? '');
      add(n.parsed.title);
    }
    return byKey;
  }, [notes]);

  // Persist whenever notes change (after the initial load).
  useEffect(() => {
    if (!ready) return;
    void store.save(rawNotes);
  }, [rawNotes, ready]);

  const getNote = useCallback(
    (path: NotePath) => notes.find((n) => n.path === path),
    [notes],
  );

  const createNote = useCallback((path: string, content = '') => {
    let created: Note | undefined;
    setRawNotes((prev) => {
      const next = createNoteOp(prev, path, content);
      created = next[next.length - 1];
      return next;
    });
    // `created` is set synchronously inside the updater above.
    return created as Note;
  }, []);

  const updateContent = useCallback((path: NotePath, content: string) => {
    setRawNotes((prev) => updateNoteContentOp(prev, path, content));
  }, []);

  const renameNote = useCallback((from: NotePath, to: string) => {
    let target = from;
    setRawNotes((prev) => {
      const next = renameNoteOp(prev, from, to);
      target = next.find((n) => n.path !== from && !prev.some((p) => p.path === n.path))?.path ?? to;
      return next;
    });
    return target;
  }, []);

  const deleteNote = useCallback((path: NotePath) => {
    setRawNotes((prev) => deleteNoteOp(prev, path));
  }, []);

  const resetVault = useCallback(async () => {
    await store.clear();
    const seeded = await store.load();
    setRawNotes(seeded);
  }, []);

  const search = useCallback(
    (query: string) => searchIndex.current?.search(query) ?? [],
    [],
  );

  const resolveLink = useCallback(
    (target: string) => resolver.get(target.trim().replace(/\.md$/i, '').toLowerCase()) ?? null,
    [resolver],
  );

  const backlinksFor = useCallback(
    (path: NotePath) => backlinks.get(path) ?? [],
    [backlinks],
  );

  return {
    ready,
    notes,
    getNote,
    backlinksFor,
    search,
    resolveLink,
    createNote,
    updateContent,
    renameNote,
    deleteNote,
    resetVault,
  };
}
