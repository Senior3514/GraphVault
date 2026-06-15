import type { Config } from 'tailwindcss';

/**
 * Dark-first design tokens per DESIGN.md. The keyframes/animations mirror the
 * primitives in `globals.css` so they can be referenced via named utilities
 * (e.g. `motion-safe:animate-fade-in`); the global `prefers-reduced-motion`
 * media query disables them for users who opt out.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'Liberation Mono',
          'monospace',
        ],
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'palette-in': {
          from: { opacity: '0', transform: 'translateY(-6px) scale(0.985)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'palette-in': 'palette-in 140ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
