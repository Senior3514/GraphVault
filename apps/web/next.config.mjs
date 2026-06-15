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
};

export default nextConfig;
