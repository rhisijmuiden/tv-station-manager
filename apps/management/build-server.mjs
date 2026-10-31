// Bundles the server into a single ESM file. Version comes from the root package.json or TVSM_VERSION.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

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
  // atem-connection only needs the native freetype2 add-on for rendering multiviewer labels, which we do not use.
  plugins: [
    {
      name: "stub-freetype2",
      setup(b) {
        b.onResolve({ filter: /^@julusian\/freetype2$/ }, () => ({ path: "freetype2", namespace: "stub" }));
        // atem-connection loads its socket via threadedclass by relative path; point it at the separately bundled file.
        b.onLoad({ filter: /atem-connection[\\/]dist[\\/]lib[\\/]atemSocket\.js$/ }, async (args) => {
          const { readFile } = await import("node:fs/promises");
          const src = await readFile(args.path, "utf8");
          if (!src.includes("'./atemSocketChild'")) throw new Error("atem-connection changed: atemSocketChild path not found");
          return { contents: src.replace("'./atemSocketChild'", "require('node:path').join(__dirname, 'atemSocketChild.cjs')"), loader: "js", resolveDir: dirname(args.path) };
        });
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = { NewMemoryFace() { throw new Error('freetype2 is not available'); } };", loader: "js" }));
      },
    },
  ],
  define: { __TVSM_VERSION__: JSON.stringify(version) },
  logLevel: "info",
});

// The ATEM socket runs through threadedclass (in-process, disableMultithreaded) and is required by absolute path.
const req = createRequire(import.meta.url);
await build({
  entryPoints: [req.resolve("atem-connection/dist/lib/atemSocketChild.js")],
  outfile: "dist/atemSocketChild.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  logLevel: "warning",
});
