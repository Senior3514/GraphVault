/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow importing the workspace shared package without prebuilding it.
  transpilePackages: ['@graphvault/shared'],
  // Static export: the web client is fully client-side (browser-persisted vault),
  // so it ships as static files. This lets it deploy to any static host —
  // including a Vercel project with the "Other" preset — with no server runtime.
  output: 'export',
  images: { unoptimized: true },
  // Stable directory-style URLs (/vault/) for static hosting.
  trailingSlash: true,
  // Security note: `headers()` is a server-runtime feature and is silently ignored
  // when `output: 'export'` is set. Response headers for the static build are set
  // via two complementary mechanisms:
  //   1. vercel.json `headers` array  — authoritative for the Vercel deployment.
  //   2. <meta http-equiv="Content-Security-Policy"> in app/layout.tsx — fallback
  //      for any other static host (GitHub Pages, Netlify, Caddy, nginx, etc.).
  // Do NOT add a `headers()` function here; it is a no-op for static exports and
  // would create a false sense that headers are being applied.
};

export default nextConfig;
