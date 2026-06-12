import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/agent/:path*",
        destination: `${process.env.SERVER_URL ?? "http://localhost:4021"}/:path*`,
      },
    ];
  },
};

export default nextConfig;
