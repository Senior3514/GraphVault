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
      /**
       * Drive the `neutral` ramp from CSS variables (defined in globals.css) so
       * the thousands of existing `bg-neutral-950 text-neutral-100` utilities
       * adapt per theme automatically — no per-component rewrite. Dark uses the
       * stock Tailwind triples; light uses an inverted ramp so semantics hold
       * (`neutral-950` is always "page background", `neutral-50` "strongest
       * text"). Accents (sky/amber/red) are unchanged — they read on both.
       */
      colors: {
        neutral: {
          50: 'rgb(var(--n-50) / <alpha-value>)',
          100: 'rgb(var(--n-100) / <alpha-value>)',
          200: 'rgb(var(--n-200) / <alpha-value>)',
          300: 'rgb(var(--n-300) / <alpha-value>)',
          400: 'rgb(var(--n-400) / <alpha-value>)',
          500: 'rgb(var(--n-500) / <alpha-value>)',
          600: 'rgb(var(--n-600) / <alpha-value>)',
          700: 'rgb(var(--n-700) / <alpha-value>)',
          800: 'rgb(var(--n-800) / <alpha-value>)',
          900: 'rgb(var(--n-900) / <alpha-value>)',
          950: 'rgb(var(--n-950) / <alpha-value>)',
        },
      },
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
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(16px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'glow-pulse': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '0.8' },
        },
        'node-appear': {
          from: { opacity: '0', transform: 'scale(0.6)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'edge-draw': {
          from: { strokeDashoffset: '200' },
          to: { strokeDashoffset: '0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        'onboarding-in': {
          from: { opacity: '0', transform: 'translateY(12px) scale(0.97)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'palette-in': 'palette-in 140ms ease-out',
        'slide-up': 'slide-up 400ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-up-delay': 'slide-up 400ms 150ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-in-right': 'slide-in-right 400ms cubic-bezier(0.16, 1, 0.3, 1)',
        'glow-pulse': 'glow-pulse 3s ease-in-out infinite',
        'node-appear': 'node-appear 500ms cubic-bezier(0.16, 1, 0.3, 1)',
        float: 'float 4s ease-in-out infinite',
        'onboarding-in': 'onboarding-in 300ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
