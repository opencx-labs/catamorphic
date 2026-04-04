import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@catamorphic/ui", "@catamorphic/parser"],
};

export default nextConfig;
