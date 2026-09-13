import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,

  /**
   * gzip buffers until it has enough bytes to compress, which stalls
   * Server-Sent Events until a chunk boundary is reached. Let a reverse proxy
   * handle compression (excluding /api/events) instead.
   */
  compress: false,

  /**
   * Keep native/Node-only libraries out of the bundler.
   * `pg` and `@prisma/client` are already externalised by default.
   */
  serverExternalPackages: ["mqtt", "ioredis", "bcryptjs"],
};

export default nextConfig;
