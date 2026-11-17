import type { NextConfig } from "next";
const config: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["sharp"],
  experimental: {
    agentUpgrade: "security",
  },
};
export default config;
