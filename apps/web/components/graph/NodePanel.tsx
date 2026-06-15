'use client';

/**
 * Selection side panel. Shows the selected note's title, tags and backlinks
 * (resolved inbound edges from the engine index) plus controls to open the note
 * in `/vault` or focus a local graph around it.
 */

import { colorForKey } from '../../lib/graph/model';
import type { GraphEdge, GraphIndex, GraphNode } from '@graphvault/engine';

export interface NodePanelProps {
  node: GraphNode;
  index: GraphIndex;
  /** Whether the local-graph view is currently centred on this node. */
  isLocalFocus: boolean;
  onFocusLocal: (id: string) => void;
  onSelect: (id: string) => void;
  /** Open the note in the vault editor (the page owns the URL shape). */
  onOpen: (path: string) => void;
}

export function NodePanel({
  node,
  index,
  isLocalFocus,
  onFocusLocal,
  onSelect,
  onOpen,
}: NodePanelProps) {
  const backlinks = index.backlinks.get(node.id) ?? [];
  const outbound = (index.outbound.get(node.id) ?? []).filter((e) => e.resolved);

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l border-neutral-800 bg-neutral-950">
      <div className="border-b border-neutral-800 px-4 py-4">
        <h2 className="text-base font-semibold leading-snug text-neutral-100">{node.title}</h2>
        <p className="mt-1 truncate text-xs text-neutral-500" title={node.path}>
          {node.path}
        </p>

        {node.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {node.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-full bg-neutral-900 px-2 py-0.5 text-xs text-neutral-300"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: colorForKey(tag) }}
                  aria-hidden
                />
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => onOpen(node.path)}
            className="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 transition-colors hover:bg-white"
          >
            Open note
          </button>
          <button
            type="button"
            onClick={() => onFocusLocal(node.id)}
            className={[
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              isLocalFocus
                ? 'bg-neutral-800 text-neutral-100'
                : 'bg-neutral-900 text-neutral-300 hover:bg-neutral-800',
            ].join(' ')}
          >
            {isLocalFocus ? 'Focused' : 'Focus local'}
          </button>
        </div>
      </div>

      <Section title={`Backlinks (${backlinks.length})`}>
        {backlinks.length === 0 ? (
          <Empty>No notes link here.</Empty>
        ) : (
          <EdgeList edges={backlinks} index={index} endpoint="source" onSelect={onSelect} />
        )}
      </Section>

      <Section title={`Outbound (${outbound.length})`}>
        {outbound.length === 0 ? (
          <Empty>No outbound links.</Empty>
        ) : (
          <EdgeList edges={outbound} index={index} endpoint="target" onSelect={onSelect} />
        )}
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-neutral-800 px-4 py-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-neutral-600">{children}</p>;
}

function EdgeList({
  edges,
  index,
  endpoint,
  onSelect,
}: {
  edges: GraphEdge[];
  index: GraphIndex;
  /** Which end of the edge is the *other* note to show. */
  endpoint: 'source' | 'target';
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="space-y-1">
      {edges.map((edge, i) => {
        const otherId = endpoint === 'source' ? edge.source : edge.target;
        const other = index.nodes.get(otherId);
        const label = other?.title ?? edge.alias ?? otherId;
        return (
          <li key={`${otherId}-${i}`}>
            <button
              type="button"
              disabled={!other}
              onClick={() => other && onSelect(otherId)}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-900 disabled:cursor-default disabled:text-neutral-600 disabled:hover:bg-transparent"
            >
              <span className="truncate">{label}</span>
              <span className="shrink-0 text-[10px] uppercase text-neutral-600">{edge.type}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
