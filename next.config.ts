import type { NextConfig } from "next";
const config: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["sharp", "ffmpeg-static", "ffprobe-static"],
  experimental: { proxyClientMaxBodySize: "510mb" },
};
export default config;
