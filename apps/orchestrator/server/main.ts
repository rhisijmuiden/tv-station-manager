import { startPlatform } from "@tvsm/platform";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_MIGRATIONS, registerNodes } from "./nodes.js";

const here = dirname(fileURLToPath(import.meta.url));

await startPlatform({
  app: { id: "orchestrator", name: "TV Station Orchestrator", defaultPort: 8080 },
  // Packaged: /usr/lib/tvsm/orchestrator/{server.mjs,web/}. Dev: built UI in dist/web (or use Vite on :5173).
  webDir: process.env.TVSM_WEB_DIR ?? join(here, "web"),
  migrations: NODE_MIGRATIONS,
  register: (server, platform) => {
    const nodes = registerNodes(server, platform);
    server.get("/api/orchestrator/overview", async () => ({
      nodes: nodes.counts(),
      mailConfigured: platform.mail.getConfig().enabled,
      backupTargets: platform.backup.listTargets().length,
      lastBackup: (platform.backup.listRuns(1)[0] as Record<string, unknown> | undefined) ?? null,
    }));
  },
});
