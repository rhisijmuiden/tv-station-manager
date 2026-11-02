import { startPlatform } from "@tvsm/platform";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ATEM_CONTROL_MIGRATIONS, ATEM_MIGRATIONS, registerAtem } from "./atem.js";
import { DIAGRAM_MIGRATIONS, registerDiagram } from "./diagram.js";
import { HYPERDECK_MIGRATIONS, registerHyperdecks } from "./hyperdeck.js";
import { NODE_MIGRATIONS, registerNodes } from "./nodes.js";

const here = dirname(fileURLToPath(import.meta.url));

await startPlatform({
  app: { id: "orchestrator", name: "TV Station Orchestrator", defaultPort: 8080 },
  // Packaged: /usr/lib/tvsm/orchestrator/{server.mjs,web/}. Dev: built UI in dist/web (or use Vite on :5173).
  webDir: process.env.TVSM_WEB_DIR ?? join(here, "web"),
  // Append-only: migrations are numbered by position.
  migrations: [...NODE_MIGRATIONS, ...ATEM_MIGRATIONS, ...ATEM_CONTROL_MIGRATIONS, ...DIAGRAM_MIGRATIONS, ...HYPERDECK_MIGRATIONS],
  register: (server, platform) => {
    const nodes = registerNodes(server, platform);
    const atem = registerAtem(server, platform);
    const hyperdecks = registerHyperdecks(server, platform);
    registerDiagram(server, platform, atem.list, hyperdecks.list);
    server.get("/api/orchestrator/overview", async () => ({
      nodes: nodes.counts(),
      atem: atem.counts(),
      hyperdecks: hyperdecks.counts(),
      mailConfigured: platform.mail.getConfig().enabled,
      backupTargets: platform.backup.listTargets().length,
      lastBackup: (platform.backup.listRuns(1)[0] as Record<string, unknown> | undefined) ?? null,
    }));
  },
});
