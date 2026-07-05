'use client';

/**
 * Note hierarchy sidebar view - CherryTree-style explicit note-parent/child
 * nesting, an alternative to {@link NoteTree}'s folder view. A note declares
 * its place in this tree via a `parent` frontmatter field (path or title),
 * completely independent of which folder the file physically lives in -
 * see `@graphvault/engine`'s `buildNoteHierarchy` for the resolution rules
 * and cycle-safety guarantees.
 *
 * Not virtualized (unlike NoteTree): hierarchy trees are authored by hand
 * one `parent:` at a time, so in practice they're far shallower than a full
 * folder listing of every note. If that stops being true for some vault,
 * the same virtualList machinery NoteTree uses would drop in the same way.
 */

import { useMemo, useState } from 'react';
import { buildNoteHierarchy, type HierarchyNode } from '@graphvault/engine';
import type { IndexedNote, NotePath } from '../lib/vault/types';

interface NoteHierarchyTreeProps {
  notes: IndexedNote[];
  activePath: NotePath | null;
  onSelect(path: NotePath): void;
}

export function NoteHierarchyTree({ notes, activePath, onSelect }: NoteHierarchyTreeProps) {
  // The web client has its own lightweight ParsedNote (path lives on the
  // outer IndexedNote, not nested inside `.parsed`) - buildNoteHierarchy
  // accepts the minimal NoteHierarchyInput shape precisely so callers like
  // this one don't need this package's own parse pipeline to use it.
  const forest = useMemo(
    () =>
      buildNoteHierarchy(
        notes.map((n) => ({
          path: n.path,
          title: n.parsed.title,
          frontmatter: n.parsed.frontmatter,
        })),
      ),
    [notes],
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (forest.length === 0) {
    return <p className="px-3 py-4 text-sm text-neutral-500">No notes yet.</p>;
  }

  return (
    <ul role="tree" aria-label="Note hierarchy" className="space-y-0.5">
      {forest.map((node) => (
        <HierarchyRow
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          onSelect={onSelect}
          collapsed={collapsed}
          onToggle={toggle}
        />
      ))}
    </ul>
  );
}

interface HierarchyRowProps {
  node: HierarchyNode;
  depth: number;
  activePath: NotePath | null;
  onSelect(path: NotePath): void;
  collapsed: ReadonlySet<string>;
  onToggle(path: string): void;
}

function HierarchyRow({
  node,
  depth,
  activePath,
  onSelect,
  collapsed,
  onToggle,
}: HierarchyRowProps) {
  const hasChildren = node.children.length > 0;
  const isOpen = !collapsed.has(node.path);
  const active = node.path === activePath;
  const pad = { paddingLeft: `${depth * 12 + 8}px` };

  return (
    <li role="treeitem" aria-expanded={hasChildren ? isOpen : undefined} aria-selected={active}>
      <div className="flex items-center">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            aria-label={isOpen ? `Collapse ${node.title}` : `Expand ${node.title}`}
            className="flex h-6 w-5 shrink-0 items-center justify-center text-xs text-neutral-600 hover:text-neutral-300"
          >
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-5 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={() => onSelect(node.path as NotePath)}
          style={pad}
          className={[
            'flex h-6 w-full min-w-0 items-center gap-1.5 truncate rounded px-2 text-left text-sm transition-colors',
            active
              ? 'bg-neutral-800/80 text-neutral-100'
              : 'text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100',
          ].join(' ')}
          title={node.parentUnresolved ? `${node.path} - declared parent not found` : node.path}
        >
          <span className="truncate">{node.title}</span>
          {node.parentUnresolved && (
            <span className="shrink-0 text-amber-500" aria-hidden="true">
              ⚠
            </span>
          )}
        </button>
      </div>
      {hasChildren && isOpen && (
        <ul role="group">
          {node.children.map((child) => (
            <HierarchyRow
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onSelect={onSelect}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
