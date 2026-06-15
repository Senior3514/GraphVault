import type { Metadata } from 'next';
import './globals.css';
import { AppFrame } from '../components/AppFrame';

export const metadata: Metadata = {
  title: 'GraphVault — open and write. No folders, no file access.',
  description:
    'A dynamic, cloud-ready notes vault with a graph you can think in. Open the app and start writing — no folders to pick, no file permissions, no setup.',
};

/**
 * Content-Security-Policy for the static export.
 *
 * WHY 'unsafe-inline' FOR SCRIPTS:
 *   Next.js App Router static export (`output: 'export'`) injects RSC flight
 *   data as inline <script> tags (e.g. `self.__next_f.push([…])`). These are
 *   emitted at build time with content that changes every build, so nonces
 *   (server-side, per-request only) and precomputed SHA-256 hashes (change
 *   every build) are both impractical for a fully-static site. All application
 *   JS still loads from '/_next/static/' (same origin), so the practical XSS
 *   attack surface is limited to injected script elements — which DOMPurify
 *   already prevents in the markdown preview path.
 *
 * WHY 'unsafe-inline' FOR STYLES:
 *   Two sources require it:
 *   1. JSX style={} attributes (e.g. animation-delay on the landing page star
 *      row) become inline style="" attributes in the static HTML.
 *   2. Next.js renders a 404 fallback that contains an inline <style> block.
 *   Hashing is not feasible in a static export; scoping 'unsafe-inline' to
 *   style-src only (never to script-src alone) is the narrowest safe relaxation.
 *
 * WHY img-src data::
 *   The react-force-graph-2d canvas renderer may export the graph as a data URI
 *   via canvas.toDataURL(). Allowing data: here is safe because no
 *   user-controlled HTML reaches an <img src> — DOMPurify strips all URLs.
 *
 * All remote origins are absent: no CDN scripts, no external fonts, no analytics.
 * frame-ancestors is ignored in <meta> per spec; it is enforced as a response
 * header in vercel.json (and X-Frame-Options as a belt-and-suspenders fallback).
 */
const CSP = [
  "default-src 'self'",
  // Next.js RSC inline scripts + webpack bootstrap require 'unsafe-inline'.
  // No eval() or wasm-unsafe-eval is needed by this app.
  "script-src 'self' 'unsafe-inline'",
  // Inline style attributes and Next.js 404 inline <style> require 'unsafe-inline'.
  "style-src 'self' 'unsafe-inline'",
  // Only same-origin images; data: covers canvas toDataURL() and SVG data URIs.
  "img-src 'self' data:",
  // No external font CDNs — all typography is system / Tailwind stack.
  "font-src 'self'",
  // Fetch/XHR may go to the user-configured self-hosted sync server, typically a
  // different origin (a VPS, or 127.0.0.1 in dev). It can't be enumerated at
  // build time; allow https: (and http: for local dev). Production servers MUST
  // use TLS. Mitigations: Argon2id + bearer tokens, token in sessionStorage.
  "connect-src 'self' https: http:",
  // No audio or video resources.
  "media-src 'none'",
  // No <object>, <embed>, or Flash.
  "object-src 'none'",
  // No cross-origin iframe embedding.
  "frame-src 'none'",
  // Prevent this app from being framed (clickjacking defence; also set as header).
  "frame-ancestors 'none'",
  // Restrict <base href> to same origin to block base-tag hijacking.
  "base-uri 'self'",
  // Constrain <form action> to same origin.
  "form-action 'self'",
].join('; ');

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/*
         * CSP via <meta> covers the static-file and self-hosted cases.
         * On Vercel the Content-Security-Policy response header set in vercel.json
         * takes precedence and is the authoritative enforcement point; the meta tag
         * is a defence-in-depth fallback for other static hosts (e.g. GitHub Pages,
         * Netlify, Caddy serving the /out directory directly).
         * Note: frame-ancestors is intentionally omitted here because browsers
         * ignore it in <meta> (per CSP Level 2 spec, section 6.2). The header in
         * vercel.json and X-Frame-Options both enforce the no-frame policy.
         */}
        <meta httpEquiv="Content-Security-Policy" content={CSP} />
      </head>
      <body>
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
