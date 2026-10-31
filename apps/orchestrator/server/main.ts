import { startPlatform } from "@tvsm/platform";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

await startPlatform({
  app: { id: "orchestrator", name: "TV Station Orchestrator", defaultPort: 8080 },
  // Packaged: /usr/lib/tvsm/orchestrator/{server.mjs,web/}. Dev: built UI in dist/web (or use Vite on :5173).
  webDir: process.env.TVSM_WEB_DIR ?? join(here, "web"),
  register: (server, platform) => {
    // Node enrollment and management API arrive in step 2 of the plan.
    server.get("/api/orchestrator/overview", async () => ({
      nodes: { total: 0, online: 0, pending: 0 },
      mailConfigured: platform.mail.getConfig().enabled,
      backupTargets: platform.backup.listTargets().length,
      lastBackup: (platform.backup.listRuns(1)[0] as Record<string, unknown> | undefined) ?? null,
    }));
  },
});
