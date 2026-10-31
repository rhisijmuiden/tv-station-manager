// Bundles the server into a single ESM file. Version comes from the root package.json or TVSM_VERSION.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const version = process.env.TVSM_VERSION ?? JSON.parse(readFileSync(new URL("../../package.json", import.meta.url))).version;
await build({
  entryPoints: ["server/main.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // ssh2 has optional native add-ons; the pure JS fallback is used when they are missing.
  external: ["cpu-features", "./crypto/build/Release/sshcrypto.node"],
  banner: {
    js: [
      "import { createRequire as __tvsmCreateRequire } from 'node:module';",
      "import { fileURLToPath as __tvsmFileURLToPath } from 'node:url';",
      "import { dirname as __tvsmDirname } from 'node:path';",
      "const require = __tvsmCreateRequire(import.meta.url);",
      "const __filename = __tvsmFileURLToPath(import.meta.url);",
      "const __dirname = __tvsmDirname(__filename);",
    ].join("\n"),
  },
  define: { __TVSM_VERSION__: JSON.stringify(version) },
  logLevel: "info",
});
