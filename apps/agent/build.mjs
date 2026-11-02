import { build } from "esbuild";
import { readFileSync } from "node:fs";

const version = process.env.TVSM_VERSION ?? JSON.parse(readFileSync(new URL("../../package.json", import.meta.url))).version;
await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/agent.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  define: { __TVSM_VERSION__: JSON.stringify(version) },
  logLevel: "info",
});
