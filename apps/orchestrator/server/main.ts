import { startPlatform } from "@tvsm/platform";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ATEM_CONTROL_MIGRATIONS, ATEM_MIGRATIONS, registerAtem } from "./atem.js";
import { DIAGRAM_MIGRATIONS, registerDiagram } from "./diagram.js";
import { HYPERDECK_MIGRATIONS } from "./legacy.js";
import { MONITOR_MIGRATIONS, registerMonitoring } from "./monitoring.js";
import { NODE_MIGRATIONS, PROVISION_MIGRATIONS, registerNodes } from "./nodes.js";
import { registerTeranex, TERANEX_MIGRATIONS } from "./teranex.js";

const here = dirname(fileURLToPath(import.meta.url));

await startPlatform({
  app: { id: "orchestrator", name: "TV Station Orchestrator", defaultPort: 8080 },
  // Packaged: /usr/lib/tvsm/orchestrator/{server.mjs,web/}. Dev: built UI in dist/web (or use Vite on :5173).
  webDir: process.env.TVSM_WEB_DIR ?? join(here, "web"),
  // Append-only: migrations are numbered by position.
  migrations: [...NODE_MIGRATIONS, ...ATEM_MIGRATIONS, ...ATEM_CONTROL_MIGRATIONS, ...DIAGRAM_MIGRATIONS, ...HYPERDECK_MIGRATIONS, ...MONITOR_MIGRATIONS, ...TERANEX_MIGRATIONS, ...PROVISION_MIGRATIONS],
  register: (server, platform) => {
    // The ATEM list is read lazily (on-air warning before a role change); atem is registered right after.
    const nodes = registerNodes(server, platform, { atems: () => atem.list() });
    const atem = registerAtem(server, platform);
    const teranex = registerTeranex(server, platform);
    registerDiagram(server, platform, atem.list, teranex.list);
    registerMonitoring(server, platform, { nodes: nodes.list, atems: atem.list, teranexes: teranex.list, automationAuthorized: atem.automationAuthorized });
    server.get("/api/orchestrator/overview", async () => ({
      nodes: nodes.counts(),
      atem: atem.counts(),
      teranex: teranex.counts(),
      mailConfigured: platform.mail.getConfig().enabled,
      backupTargets: platform.backup.listTargets().length,
      lastBackup: (platform.backup.listRuns(1)[0] as Record<string, unknown> | undefined) ?? null,
    }));
  },
});
