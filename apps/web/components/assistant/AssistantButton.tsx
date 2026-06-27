'use client';

/**
 * A small toolbar button that toggles the AI assistant panel.
 *
 * Renders as a fixed floating button in the bottom-right corner of the shell.
 * On desktop it sits above the main content area; on mobile it respects
 * safe-area-inset-bottom so it does not overlap the home indicator.
 *
 * The button is intentionally unobtrusive: it uses a subtle icon and is
 * invisible when the assistant is disabled (kind === 'off') - users who never
 * configure AI will not see the button at all.
 *
 * Keyboard: Cmd/Ctrl+Shift+A toggles the panel.
 */

import { useEffect } from 'react';

import { useAISettings } from './useAISettings';
import { dispatchAssistantToggle } from './AssistantPanel';

export function AssistantButton() {
  const { settings } = useAISettings();

  // Keyboard shortcut: Cmd/Ctrl+Shift+A.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        dispatchAssistantToggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Hide the button entirely when AI is off - do not hint at a feature the user
  // has not opted into. They can still access it via Settings if they know it exists.
  if (settings.kind === 'off') return null;

  return (
    <button
      type="button"
      onClick={dispatchAssistantToggle}
      aria-label="Toggle AI assistant (Ctrl+Shift+A)"
      title="AI assistant (Ctrl+Shift+A)"
      className={[
        'fixed bottom-6 right-6 z-20',
        'flex h-10 w-10 items-center justify-center rounded-full',
        'bg-sky-600 text-white shadow-lg',
        'hover:bg-sky-500 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950',
        'transition-colors',
      ].join(' ')}
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <SparkleIcon />
    </button>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.83-4.4z"
        clipRule="evenodd"
      />
    </svg>
  );
}
