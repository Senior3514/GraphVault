'use client';

/**
 * Selection side panel. Shows the selected note's title, tags, an inline
 * rendered content preview, and backlinks (resolved inbound edges from the
 * engine index) plus controls to open the note in `/vault` or focus a local
 * graph around it.
 *
 * The inline preview lets you actually read a note without leaving the
 * graph - clicking a wikilink inside it re-selects that node in-graph when
 * it's part of the current view, or falls back to opening it in the vault
 * editor when it isn't (e.g. filtered out).
 *
 * M21 AI additions (gated behind aiEnabled - hidden when AI is off):
 *  - "Suggest related" - surfaces vault notes the AI thinks are related but
 *    not yet linked. Clicking a suggestion navigates to that note.
 *  - "Find gaps" - surfaces note titles the AI thinks are MISSING from this
 *    cluster, useful for surfacing future writing ideas.
 *
 * Privacy invariant: these sections are hidden entirely when AI is off.
 * When shown, only note TITLES and link topology are sent - never bodies.
 * The "what we'll send" notice is shown before the first request fires.
 * (The inline preview below is unrelated to AI - it's a pure client-side
 * render of content already in the browser, same as the vault editor's own
 * preview pane; nothing is sent anywhere.)
 */

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { colorForKey } from '../../lib/graph/model';
import type { GraphEdge, GraphIndex, GraphNode } from '@graphvault/engine';
import type { AISettings } from '../../lib/ai/types';
import { chat, type ServerProviderOptions } from '../../lib/ai/providers';
import type { ResolveTarget } from '../../lib/markdown/render';
import {
  buildRelatedNotesPrompt,
  parseRelatedNotes,
  buildGapFindingPrompt,
  parseGapSuggestions,
  buildGraphSendContext,
  type RelatedNoteSuggestion,
} from '../../lib/ai/graph-prompts';

// The markdown renderer (DOMPurify + the markdown parser) is real weight that
// the graph route otherwise never needs on first load - NodePanel only
// mounts once a node is selected. Dynamically importing it keeps that cost
// out of the route's First Load JS entirely; it fetches on first selection
// instead. `ssr: false` matches the rest of this route's lazy boundaries
// (see `ForceGraphCanvas` in graph/page.tsx) - nothing here can render
// server-side anyway, since `selectedNode` starts `null` on every load.
const MarkdownPreview = dynamic(() => import('../MarkdownPreview').then((m) => m.MarkdownPreview), {
  ssr: false,
  loading: () => <p className="px-4 py-3 text-xs text-neutral-600">Loading preview&hellip;</p>,
});

export interface NodePanelProps {
  node: GraphNode;
  /** The selected note's raw content (frontmatter included - `MarkdownPreview`
   *  strips it), or `undefined` if it couldn't be found in the vault. */
  noteContent: string | undefined;
  index: GraphIndex;
  /** Whether the local-graph view is currently centred on this node. */
  isLocalFocus: boolean;
  onFocusLocal: (id: string) => void;
  onSelect: (id: string) => void;
  /** Open the note in the vault editor (the page owns the URL shape). */
  onOpen: (path: string) => void;
  /** Resolve a wikilink target clicked inside the preview to a note path. */
  resolvePreviewLink: ResolveTarget;
  /** A wikilink inside the preview was clicked - the page decides whether
   *  to re-select in-graph or fall back to opening the note. */
  onPreviewNavigate: (target: string) => void;
  /** AI settings - when kind === 'off' the AI sections are hidden entirely. */
  aiSettings?: AISettings;
  /**
   * Server-proxy options (token + URL) for `server` AI mode. Required for the
   * AI sections to work when AI is in server mode; ignored for local/off.
   */
  serverOpts?: ServerProviderOptions;
}

export function NodePanel({
  node,
  noteContent,
  index,
  isLocalFocus,
  onFocusLocal,
  onSelect,
  onOpen,
  resolvePreviewLink,
  onPreviewNavigate,
  aiSettings,
  serverOpts,
}: NodePanelProps) {
  const backlinks = index.backlinks.get(node.id) ?? [];
  const outbound = (index.outbound.get(node.id) ?? []).filter((e) => e.resolved);
  const aiEnabled = aiSettings !== undefined && aiSettings.kind !== 'off';

  return (
    // On desktop: aside with fixed width and left border.
    // On mobile: rendered inside a bottom drawer by the page, so we use
    // full width with no border/shrink constraints.
    <aside className="flex w-full shrink-0 flex-col overflow-y-auto bg-neutral-950 md:w-80 md:border-l md:border-neutral-800">
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

      <section className="max-h-80 overflow-y-auto border-b border-neutral-800">
        <h3 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Preview
        </h3>
        {noteContent === undefined ? (
          <p className="px-4 pb-3 pt-2 text-xs text-neutral-600">Note content unavailable.</p>
        ) : noteContent.trim().length === 0 ? (
          <p className="px-4 pb-3 pt-2 text-xs text-neutral-600">This note is empty.</p>
        ) : (
          <div className="text-sm">
            <MarkdownPreview
              markdown={noteContent}
              resolve={resolvePreviewLink}
              onNavigate={onPreviewNavigate}
            />
          </div>
        )}
      </section>

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

      {/* M21: AI sections - only rendered when AI is enabled */}
      {aiEnabled && aiSettings && (
        <>
          <RelatedNotesSection
            node={node}
            index={index}
            aiSettings={aiSettings}
            serverOpts={serverOpts}
            onSelect={onSelect}
          />
          <GapFindingSection
            node={node}
            index={index}
            aiSettings={aiSettings}
            serverOpts={serverOpts}
          />
        </>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// M21: Related notes AI section
// ---------------------------------------------------------------------------

function RelatedNotesSection({
  node,
  index,
  aiSettings,
  serverOpts,
  onSelect,
}: {
  node: GraphNode;
  index: GraphIndex;
  aiSettings: AISettings;
  serverOpts?: ServerProviderOptions;
  onSelect: (id: string) => void;
}) {
  const [status, setStatus] = useState<'idle' | 'confirming' | 'loading' | 'done' | 'error'>(
    'idle',
  );
  const [results, setResults] = useState<RelatedNoteSuggestion[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  // Gather the data we'll send (titles only, no bodies).
  const neighbourTitles = [
    ...(index.backlinks.get(node.id) ?? []),
    ...(index.outbound.get(node.id) ?? []),
  ]
    .filter((e) => e.resolved)
    .map((e) => {
      const otherId = e.source === node.id ? e.target : e.source;
      return index.nodes.get(otherId)?.title;
    })
    .filter((t): t is string => Boolean(t));

  const allTitles = [...index.nodes.values()].map((n) => n.title);

  // Build title → id lookup for response parsing.
  const titleToId = new Map<string, string>();
  for (const [id, n] of index.nodes) {
    titleToId.set(n.title.toLowerCase(), id);
    titleToId.set(n.title, id);
  }

  const sendCtx = buildGraphSendContext('related-notes', {
    selectedTitle: node.title,
    neighbourCount: neighbourTitles.length,
    totalTitles: allTitles.length,
  });

  const handleRun = async () => {
    setStatus('loading');
    setErrorMsg('');
    try {
      const msgs = buildRelatedNotesPrompt(node.title, neighbourTitles, allTitles);
      const raw = await chat(aiSettings, msgs, serverOpts);
      const parsed = parseRelatedNotes(raw, titleToId);
      setResults(parsed);
      setStatus('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'AI request failed.');
      setStatus('error');
    }
  };

  // Reset when node changes.
  const handleConfirm = () => setStatus('confirming');
  const handleCancel = () => setStatus('idle');

  return (
    <section className="border-b border-neutral-800 px-4 py-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        AI: Related notes
      </h3>

      {status === 'idle' && (
        <button
          type="button"
          onClick={handleConfirm}
          className="rounded-md bg-violet-950/60 px-2.5 py-1.5 text-xs font-medium text-violet-300 transition-colors hover:bg-violet-900/60 hover:text-violet-200"
        >
          Suggest related notes
        </button>
      )}

      {status === 'confirming' && (
        <div className="space-y-2">
          <p className="text-[11px] leading-relaxed text-neutral-500">
            <strong className="text-neutral-400">What we&apos;ll send:</strong>{' '}
            {sendCtx.description}
          </p>
          <p className="text-[11px] text-neutral-600">{sendCtx.detail}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleRun}
              className="rounded-md bg-violet-950/60 px-2.5 py-1.5 text-xs font-medium text-violet-300 hover:bg-violet-900/60"
            >
              Send
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-md px-2.5 py-1.5 text-xs text-neutral-600 hover:text-neutral-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status === 'loading' && (
        <p className="text-[11px] text-neutral-600 motion-safe:animate-pulse">Asking AI&hellip;</p>
      )}

      {status === 'error' && (
        <div className="space-y-1">
          <p className="text-[11px] text-red-400">{errorMsg}</p>
          <button
            type="button"
            onClick={() => setStatus('idle')}
            className="text-[11px] text-neutral-600 underline hover:text-neutral-400"
          >
            Dismiss
          </button>
        </div>
      )}

      {status === 'done' && (
        <div className="space-y-1">
          {results.length === 0 ? (
            <p className="text-[11px] text-neutral-600">No additional related notes found.</p>
          ) : (
            <ul className="space-y-2">
              {results.map((r, i) => (
                <li key={`related-${i}`} className="space-y-0.5">
                  {r.nodeId ? (
                    <button
                      type="button"
                      onClick={() => onSelect(r.nodeId!)}
                      className="w-full truncate text-left text-xs font-medium text-violet-300 underline-offset-2 hover:text-violet-200 hover:underline"
                    >
                      {r.title}
                    </button>
                  ) : (
                    <span className="text-xs font-medium text-neutral-500">{r.title}</span>
                  )}
                  <p className="text-[11px] leading-relaxed text-neutral-600">{r.reason}</p>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => {
              setStatus('idle');
              setResults([]);
            }}
            className="mt-1 text-[11px] text-neutral-700 hover:text-neutral-500"
          >
            Clear
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// M21: Gap finding AI section
// ---------------------------------------------------------------------------

function GapFindingSection({
  node,
  index,
  aiSettings,
  serverOpts,
}: {
  node: GraphNode;
  index: GraphIndex;
  aiSettings: AISettings;
  serverOpts?: ServerProviderOptions;
}) {
  const [status, setStatus] = useState<'idle' | 'confirming' | 'loading' | 'done' | 'error'>(
    'idle',
  );
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState('');

  const neighbourTitles = [
    ...(index.backlinks.get(node.id) ?? []),
    ...(index.outbound.get(node.id) ?? []),
  ]
    .filter((e) => e.resolved)
    .map((e) => {
      const otherId = e.source === node.id ? e.target : e.source;
      return index.nodes.get(otherId)?.title;
    })
    .filter((t): t is string => Boolean(t));

  const sendCtx = buildGraphSendContext('find-gaps', {
    selectedTitle: node.title,
    neighbourCount: neighbourTitles.length,
  });

  const handleRun = async () => {
    setStatus('loading');
    setErrorMsg('');
    try {
      const msgs = buildGapFindingPrompt(node.title, neighbourTitles);
      const raw = await chat(aiSettings, msgs, serverOpts);
      const parsed = parseGapSuggestions(raw);
      setSuggestions(parsed);
      setStatus('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'AI request failed.');
      setStatus('error');
    }
  };

  const handleConfirm = () => setStatus('confirming');
  const handleCancel = () => setStatus('idle');

  return (
    <section className="border-b border-neutral-800 px-4 py-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        AI: Knowledge gaps
      </h3>

      {status === 'idle' && (
        <button
          type="button"
          onClick={handleConfirm}
          className="rounded-md bg-teal-950/60 px-2.5 py-1.5 text-xs font-medium text-teal-300 transition-colors hover:bg-teal-900/60 hover:text-teal-200"
        >
          Find gaps
        </button>
      )}

      {status === 'confirming' && (
        <div className="space-y-2">
          <p className="text-[11px] leading-relaxed text-neutral-500">
            <strong className="text-neutral-400">What we&apos;ll send:</strong>{' '}
            {sendCtx.description}
          </p>
          <p className="text-[11px] text-neutral-600">{sendCtx.detail}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleRun}
              className="rounded-md bg-teal-950/60 px-2.5 py-1.5 text-xs font-medium text-teal-300 hover:bg-teal-900/60"
            >
              Send
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-md px-2.5 py-1.5 text-xs text-neutral-600 hover:text-neutral-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {status === 'loading' && (
        <p className="text-[11px] text-neutral-600 motion-safe:animate-pulse">Asking AI&hellip;</p>
      )}

      {status === 'error' && (
        <div className="space-y-1">
          <p className="text-[11px] text-red-400">{errorMsg}</p>
          <button
            type="button"
            onClick={() => setStatus('idle')}
            className="text-[11px] text-neutral-600 underline hover:text-neutral-400"
          >
            Dismiss
          </button>
        </div>
      )}

      {status === 'done' && (
        <div className="space-y-1">
          {suggestions.length === 0 ? (
            <p className="text-[11px] text-neutral-600">No gap suggestions returned.</p>
          ) : (
            <ul className="space-y-1">
              {suggestions.map((title, i) => (
                <li key={`gap-${i}`} className="text-xs text-teal-200/80">
                  {i + 1}. {title}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => {
              setStatus('idle');
              setSuggestions([]);
            }}
            className="mt-1 text-[11px] text-neutral-700 hover:text-neutral-500"
          >
            Clear
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

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
