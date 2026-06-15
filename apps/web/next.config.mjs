/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow importing the workspace shared package without prebuilding it.
  transpilePackages: ['@graphvault/shared'],
};

export default nextConfig;
