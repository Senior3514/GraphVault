'use client';

/** Recursive folder/file tree for the vault sidebar. */

import { useState } from 'react';

import { buildTree, type TreeNode } from '../lib/vault/vault';
import type { IndexedNote, NotePath } from '../lib/vault/types';

interface NoteTreeProps {
  notes: IndexedNote[];
  activePath: NotePath | null;
  onSelect(path: NotePath): void;
}

export function NoteTree({ notes, activePath, onSelect }: NoteTreeProps) {
  const tree = buildTree(notes);
  if (notes.length === 0) {
    return <p className="px-3 py-4 text-sm text-neutral-500">No notes yet.</p>;
  }
  return (
    <ul className="space-y-0.5">
      {tree.map((node) => (
        <TreeItem
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeItem({
  node,
  depth,
  activePath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  activePath: NotePath | null;
  onSelect(path: NotePath): void;
}) {
  const [open, setOpen] = useState(true);
  const pad = { paddingLeft: `${depth * 12 + 8}px` };

  if (node.children) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={pad}
          className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
        >
          <span className="inline-block w-3 text-xs text-neutral-600">
            {open ? '▾' : '▸'}
          </span>
          <span className="truncate">{node.name}</span>
        </button>
        {open && (
          <ul className="space-y-0.5">
            {node.children.map((child) => (
              <TreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const active = node.path === activePath;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        style={pad}
        className={[
          'block w-full truncate rounded px-2 py-1 text-left text-sm transition-colors',
          active
            ? 'bg-neutral-800/80 text-neutral-100'
            : 'text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100',
        ].join(' ')}
        title={node.path}
      >
        {node.note?.parsed.title ?? node.name}
      </button>
    </li>
  );
}
