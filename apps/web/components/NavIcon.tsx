'use client';

/**
 * Inline SVG nav glyphs for the sidebar. Kept as plain `currentColor` strokes
 * (no external icon library, no network fetch) so they theme with the rail and
 * stay crisp when the sidebar collapses to an icon-only rail.
 */

export type NavGlyph = 'home' | 'vault' | 'graph' | 'sync' | 'settings';

export function NavIcon({ glyph, className }: { glyph: NavGlyph; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {glyph === 'home' && (
        <>
          <path d="M4 11 12 4l8 7" />
          <path d="M6 10v9h12v-9" />
          <path d="M10 19v-5h4v5" />
        </>
      )}
      {glyph === 'vault' && (
        <>
          <path d="M5 3h11l3 3v15H5z" />
          <path d="M8 7h6M8 11h8M8 15h5" />
        </>
      )}
      {glyph === 'graph' && (
        <>
          <circle cx="6" cy="7" r="2" />
          <circle cx="18" cy="9" r="2" />
          <circle cx="12" cy="17" r="2" />
          <path d="M7.6 8.4 10.8 15.4M16.6 10.4 13.4 15.4M8 7.4 16 8.8" />
        </>
      )}
      {glyph === 'sync' && (
        <>
          <path d="M4 9a8 8 0 0 1 13.3-3.3L20 8" />
          <path d="M20 15a8 8 0 0 1-13.3 3.3L4 16" />
          <path d="M20 4v4h-4M4 20v-4h4" />
        </>
      )}
      {glyph === 'settings' && (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v2.5M12 18.5V21M4.2 7l2.1 1.3M17.7 15.7 19.8 17M3 14.5l2.4-.7M18.6 10.2l2.4-.7M7 19.8l1.1-2.3M15.9 6.5 17 4.2" />
        </>
      )}
    </svg>
  );
}
