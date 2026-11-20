import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // DuckDB ships a native addon: load it with Node's require instead of bundling it.
  serverExternalPackages: ["@duckdb/node-api", "@duckdb/node-bindings"],
  // npm workspace: dependencies are hoisted to the repo root.
  turbopack: { root: path.join(__dirname, "..") },
  devIndicators: false,
};

export default nextConfig;
