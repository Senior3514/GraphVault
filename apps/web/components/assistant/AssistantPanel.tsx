'use client';

/**
 * Privacy-first AI assistant panel.
 *
 * Toggleable via:
 *  - The button rendered in AppFrame (assistant rail button).
 *  - The custom DOM event 'graphvault:assistant-toggle' (command-palette friendly).
 *
 * Before any request is sent the panel shows:
 *  - Which action is selected.
 *  - What context will be sent ("sending: current note (2 048 chars)").
 *  - A confirm button - the user must deliberately choose to send.
 *
 * AI output is rendered through the DOMPurify-sanitised markdown path (via
 * renderMarkdown with a no-op resolver so no wikilink anchors are injected),
 * never as raw HTML.
 *
 * The panel respects prefers-reduced-motion and does not disrupt the responsive
 * layout - it slides in as an overlay on mobile, as a right sidebar panel on
 * wider screens.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { renderMarkdown } from '../../lib/markdown/render';
import { buildPrompt, buildSendContext } from '../../lib/ai/prompts';
import { chat, chatStream, truncateContext } from '../../lib/ai/providers';
import { formatUsd } from '../../lib/ai/budget';
import type { AssistantAction } from '../../lib/ai/types';
import type { AiSpendCapState, AiUsage } from '@graphvault/shared';
import { useVaultContext } from '../../lib/vault/VaultProvider';
import { useAISettings } from './useAISettings';
import { useAuth } from '../../lib/api/useAuth';
import { useServerSettings } from '../../lib/api/useServerSettings';

/** Custom event name - dispatched by the toolbar button and command-palette. */
export const ASSISTANT_TOGGLE_EVENT = 'graphvault:assistant-toggle';

/** Dispatch this from anywhere to toggle the assistant panel open/closed. */
export function dispatchAssistantToggle() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ASSISTANT_TOGGLE_EVENT));
  }
}

// ---------------------------------------------------------------------------
// Action metadata
// ---------------------------------------------------------------------------

const ACTIONS: { id: AssistantAction; label: string; description: string }[] = [
  {
    id: 'summarize',
    label: 'Summarize',
    description: 'Get a concise 2-4 sentence summary of this note.',
  },
  {
    id: 'find-related',
    label: 'Find related notes',
    description: 'Discover which other notes in your vault are related.',
  },
  {
    id: 'suggest-links',
    label: 'Suggest links',
    description: 'Suggest [[wikilinks]] to connect this note to others.',
  },
  {
    id: 'suggest-tags',
    label: 'Suggest tags',
    description: 'Suggest #tags to categorise this note.',
  },
  {
    id: 'outline',
    label: 'Outline / restructure',
    description: 'Generate a structured Markdown outline for this note.',
  },
];

// ---------------------------------------------------------------------------
// AssistantPanel
// ---------------------------------------------------------------------------

export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const { settings } = useAISettings();
  const vault = useVaultContext();
  const auth = useAuth();
  const { serverUrl } = useServerSettings();

  // Derive the current note path from the URL search param (?note=…).
  // This matches how the vault page navigates: /vault?note=path/to/note.md
  const searchParams = useSearchParams();
  const currentNotePath = searchParams.get('note');

  const [selectedAction, setSelectedAction] = useState<AssistantAction>('summarize');
  const [status, setStatus] = useState<'idle' | 'confirming' | 'loading' | 'done' | 'error'>(
    'idle',
  );
  const [result, setResult] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  // Streaming state (server BFF mode): raw accumulated text + usage/cost.
  const [streamText, setStreamText] = useState<string>('');
  const [usage, setUsage] = useState<AiUsage | null>(null);
  // Live spend window from GET /v1/ai/config - gates the send button.
  const [spendState, setSpendState] = useState<AiSpendCapState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Toggle via the custom event (command-palette / other triggers).
  // Capture the previously focused element so we can restore it on close.
  useEffect(() => {
    const onToggle = () =>
      setOpen((prev) => {
        if (!prev) {
          restoreFocusRef.current = document.activeElement as HTMLElement | null;
        }
        return !prev;
      });
    window.addEventListener(ASSISTANT_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(ASSISTANT_TOGGLE_EVENT, onToggle);
  }, []);

  // Focus the panel heading when opened; restore on close.
  useEffect(() => {
    if (open) {
      // Defer to let the panel render before focusing.
      requestAnimationFrame(() => {
        panelRef.current?.focus?.();
      });
    } else {
      restoreFocusRef.current?.focus?.();
    }
  }, [open]);

  // When the panel is open in server mode, fetch the live spend window so the
  // budget gate is accurate before the user runs anything. Strictly a GET of
  // non-secret status (no key, no prompt) - and only when signed in.
  const refreshSpendState = useCallback(async () => {
    if (settings.kind !== 'server' || !auth.token || !serverUrl) {
      setSpendState(null);
      return;
    }
    try {
      const { GraphVaultClient } = await import('../../lib/api/client');
      const client = new GraphVaultClient(serverUrl, auth.token);
      const info = await client.getAiConfig();
      setSpendState(info?.spendCapState ?? null);
    } catch {
      // Non-fatal: a failed status fetch must not block the assistant; the
      // server still enforces the cap and returns 429 if exceeded.
      setSpendState(null);
    }
  }, [settings.kind, auth.token, serverUrl]);

  useEffect(() => {
    if (open) void refreshSpendState();
  }, [open, refreshSpendState]);

  // Abort any in-flight stream when the panel closes so a closed view does not
  // keep the upstream generation (and the user's budget) running.
  useEffect(() => {
    if (!open && abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, [open]);

  // Abort on unmount as a safety net.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Close on Escape; trap Tab inside the panel.
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const panel = panelRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || document.activeElement === panel) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Get the current note content.
  const currentNote = currentNotePath ? vault.getNote(currentNotePath as never) : null;
  const noteContent = currentNote?.content ?? '';

  // Build the context description to show the user.
  const relatedTitles = vault.notes
    .filter((n) => n.path !== currentNotePath)
    .map((n) => n.parsed.title || n.path)
    .slice(0, 50); // cap for prompt size

  const sendContext = noteContent
    ? buildSendContext(selectedAction, noteContent, relatedTitles)
    : null;

  const handleActionChange = useCallback((action: AssistantAction) => {
    setSelectedAction(action);
    setStatus('idle');
    setResult('');
    setErrorMsg('');
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!noteContent) return;

    setStatus('loading');
    setResult('');
    setErrorMsg('');
    setStreamText('');
    setUsage(null);

    const truncated = truncateContext(noteContent);
    const messages = buildPrompt(selectedAction, truncated, relatedTitles.slice(0, 50));

    // For `server` mode, stream via SSE so deltas render incrementally. The key
    // never touches the browser - the bearer token authenticates the proxy call.
    if (settings.kind === 'server' && auth.token) {
      const controller = new AbortController();
      abortRef.current = controller;
      let acc = '';
      try {
        await chatStream(
          settings,
          messages,
          { serverUrl, bearerToken: auth.token },
          {
            onDelta: (chunk) => {
              acc += chunk;
              setStreamText(acc);
            },
            onUsage: (u) => setUsage(u),
            onDone: () => {
              // Sanitise the full accumulated text once through the DOMPurify
              // markdown renderer for the final, copy-able output.
              setResult(renderMarkdown(acc, () => null));
              setStatus('done');
              void refreshSpendState();
            },
            onError: (code, message) => {
              setErrorMsg(code === 'RATE_LIMITED' ? `${message}` : message);
              setStatus('error');
              void refreshSpendState();
            },
          },
          controller.signal,
        );
        // If the stream ended without an explicit done/error frame, finalise
        // from whatever was accumulated.
        setStatus((prev) => {
          if (prev === 'loading') {
            setResult(renderMarkdown(acc, () => null));
            return 'done';
          }
          return prev;
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const msg = err instanceof Error ? err.message : 'Unexpected error.';
        setErrorMsg(msg);
        setStatus('error');
      } finally {
        abortRef.current = null;
      }
      return;
    }

    // Non-streaming path (local mode, or server without a token guard above).
    try {
      const raw = await chat(settings, messages);
      // Sanitise through DOMPurify-based markdown renderer before display.
      // Use a no-op resolver so no wikilink anchors are injected into AI output.
      const sanitised = renderMarkdown(raw, () => null);
      setResult(sanitised);
      setStatus('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unexpected error.';
      setErrorMsg(msg);
      setStatus('error');
    }
  }, [
    noteContent,
    selectedAction,
    relatedTitles,
    settings,
    auth.token,
    serverUrl,
    refreshSpendState,
  ]);

  // Stop an in-flight stream on demand (also aborts the upstream generation).
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // Finalise whatever we have so the user keeps the partial output.
    setStreamText((text) => {
      setResult(renderMarkdown(text, () => null));
      return text;
    });
    setStatus('done');
    void refreshSpendState();
  }, [refreshSpendState]);

  const handleSendClick = useCallback(() => {
    setStatus('confirming');
    setResult('');
    setErrorMsg('');
  }, []);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
    setResult('');
    setErrorMsg('');
    setStreamText('');
    setUsage(null);
  }, []);

  const isOff = settings.kind === 'off';

  // Hide the assistant entirely when AI is off - no panel, no network, no hint
  // of a feature the user has not opted into. (The toggle button is likewise
  // hidden in AssistantButton.)
  if (!open || isOff) return null;

  // The server-side spend window can be exhausted (429 on the next call). Gate
  // the send button so the user is not sent into a doomed request.
  const budgetExhausted = settings.kind === 'server' && spendState?.state === 'exceeded';
  const canSend = !isOff && !!noteContent && status !== 'loading' && !budgetExhausted;

  return (
    <>
      {/* Backdrop - visible on mobile only */}
      <div
        aria-hidden="true"
        className="fixed inset-0 z-30 bg-neutral-950/60 backdrop-blur-sm md:hidden motion-safe:animate-fade-in"
        onClick={() => setOpen(false)}
      />

      {/* Panel */}
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        className={[
          'fixed right-0 top-0 z-40 flex h-full w-80 max-w-[90vw] flex-col',
          'border-l border-neutral-800 bg-neutral-950 shadow-2xl',
          'motion-safe:animate-slide-in-right',
          'focus:outline-none',
        ].join(' ')}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <SparkleIcon />
            <span id={headingId} className="text-sm font-semibold text-neutral-100">
              AI assistant
            </span>
            <span
              className={[
                'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                isOff
                  ? 'bg-neutral-800 text-neutral-500'
                  : settings.kind === 'local'
                    ? 'bg-emerald-950 text-emerald-400'
                    : 'bg-sky-950 text-sky-400',
              ].join(' ')}
            >
              {isOff ? 'Off' : settings.kind === 'local' ? 'Local' : 'Server proxy'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close AI assistant"
            className="flex h-8 w-8 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-sky-500"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Privacy notice - always visible */}
        <div className="shrink-0 border-b border-neutral-800 bg-amber-950/20 px-4 py-2.5 text-xs text-amber-300">
          <strong>Privacy:</strong> your notes leave your device only if you enable a cloud
          provider. Local and Off modes keep everything on-device.{' '}
          {isOff && (
            <span className="text-neutral-400">
              Enable a provider in{' '}
              <a href="/settings" className="underline hover:text-neutral-200">
                Settings
              </a>
              .
            </span>
          )}
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-auto px-4 py-4">
          {/* No note open */}
          {!currentNotePath && (
            <p className="text-sm text-neutral-500">Open a note to use the AI assistant.</p>
          )}

          {/* No note content */}
          {currentNotePath && !noteContent && (
            <p className="text-sm text-neutral-500">This note is empty - nothing to send.</p>
          )}

          {currentNotePath && noteContent && (
            <>
              {/* Action picker */}
              <fieldset className="mb-4">
                <legend className="mb-2 text-xs font-medium text-neutral-400">Choose action</legend>
                <div className="space-y-1">
                  {ACTIONS.map((action) => (
                    <label
                      key={action.id}
                      className={[
                        'flex cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                        selectedAction === action.id
                          ? 'bg-neutral-800 text-neutral-100'
                          : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200',
                      ].join(' ')}
                    >
                      <input
                        type="radio"
                        name="assistant-action"
                        value={action.id}
                        checked={selectedAction === action.id}
                        onChange={() => handleActionChange(action.id)}
                        className="mt-0.5 accent-sky-500"
                        disabled={isOff || status === 'loading'}
                      />
                      <span>
                        <span className="font-medium">{action.label}</span>
                        <span className="ml-1 text-neutral-500"> - {action.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {/* Provider disabled state */}
              {isOff && (
                <div className="rounded-md border border-neutral-800 bg-neutral-900/60 p-3 text-xs text-neutral-500">
                  AI assistant is <strong className="text-neutral-400">off</strong>. Go to{' '}
                  <a href="/settings" className="underline hover:text-neutral-300">
                    Settings → AI assistant
                  </a>{' '}
                  to enable local or cloud inference.
                </div>
              )}

              {/* Budget-exhausted notice (server mode) */}
              {budgetExhausted && (
                <div className="mb-3 rounded-md border border-red-900/60 bg-red-950/30 p-3 text-xs text-red-300">
                  Daily AI budget reached on your server. Requests are paused until the window
                  resets. Raise the cap in{' '}
                  <a href="/settings" className="underline hover:text-red-200">
                    Settings → AI assistant
                  </a>
                  .
                </div>
              )}

              {/* Send / confirm flow */}
              {!isOff && status === 'idle' && (
                <button
                  type="button"
                  onClick={handleSendClick}
                  disabled={!canSend}
                  className="w-full rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-sky-400"
                >
                  Run
                </button>
              )}

              {!isOff && status === 'confirming' && sendContext && (
                <div className="space-y-3">
                  <div className="rounded-md border border-neutral-700 bg-neutral-900/60 p-3 text-xs text-neutral-400">
                    <p className="font-medium text-neutral-300">What will be sent:</p>
                    <p className="mt-1 text-neutral-400">Sending: {sendContext.description}</p>
                    <p className="mt-1 text-neutral-500">
                      Provider:{' '}
                      {settings.kind === 'local'
                        ? `Local (${settings.localEndpoint})`
                        : `Server proxy (${serverUrl})`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleConfirm()}
                      className="flex-1 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 focus-visible:ring-2 focus-visible:ring-sky-400"
                    >
                      Send
                    </button>
                    <button
                      type="button"
                      onClick={handleCancel}
                      className="rounded-md border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Live region: announces async status changes (loading/done/error). */}
              <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
                {status === 'loading'
                  ? 'AI assistant is thinking…'
                  : status === 'done'
                    ? 'AI response ready.'
                    : status === 'error'
                      ? `Error: ${errorMsg}`
                      : ''}
              </div>

              {status === 'loading' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div
                      className="flex items-center gap-2 text-sm text-neutral-400"
                      aria-hidden="true"
                    >
                      <SpinnerIcon />
                      {streamText ? 'Streaming…' : 'Thinking…'}
                    </div>
                    {settings.kind === 'server' && (
                      <button
                        type="button"
                        onClick={handleStop}
                        className="rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                      >
                        Stop
                      </button>
                    )}
                  </div>
                  {/* Live streaming text - shown as plain text while generating,
                      then re-rendered as sanitised markdown on completion. */}
                  {streamText && (
                    <div className="whitespace-pre-wrap break-words rounded-md border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-sm text-neutral-200">
                      {streamText}
                    </div>
                  )}
                </div>
              )}

              {status === 'error' && (
                <div className="space-y-3">
                  <div className="rounded-md border border-red-900/60 bg-red-950/30 p-3 text-xs text-red-300">
                    {errorMsg}
                  </div>
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="rounded-md border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm text-neutral-300 hover:bg-neutral-800"
                  >
                    Try again
                  </button>
                </div>
              )}

              {status === 'done' && result && (
                <div className="space-y-3">
                  {/* Sanitised markdown output */}
                  <div
                    className="markdown-preview rounded-md border border-neutral-800 bg-neutral-900/60 px-4 py-3 text-sm"
                    dangerouslySetInnerHTML={{ __html: result }}
                  />
                  {/* Usage / cost - surfaced from the terminal SSE usage frame. */}
                  {usage && (
                    <p className="text-xs text-neutral-500">
                      {usage.costUsd != null && usage.costUsd > 0 && (
                        <span className="text-neutral-400">{formatUsd(usage.costUsd)}</span>
                      )}
                      {usage.promptTokens != null || usage.completionTokens != null ? (
                        <span>
                          {usage.costUsd != null && usage.costUsd > 0 ? ' · ' : ''}
                          {(usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)} tokens
                        </span>
                      ) : null}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleSendClick}
                      className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
                    >
                      Run again
                    </button>
                    <button
                      type="button"
                      onClick={handleCancel}
                      className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function SparkleIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className="h-4 w-4 text-sky-400"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.83-4.4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path strokeLinecap="round" d="M4.5 4.5l11 11M15.5 4.5l-11 11" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-sky-400 motion-reduce:hidden"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
