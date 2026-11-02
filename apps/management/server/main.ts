import { startPlatform } from "@tvsm/platform";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { managementOptions } from "./app.js";

const here = dirname(fileURLToPath(import.meta.url));
// Packaged: /usr/lib/tvsm/management/{server.mjs,web/}. Dev: built UI in dist/web (or use Vite on :5174).
await startPlatform(managementOptions({ webDir: process.env.TVSM_WEB_DIR ?? join(here, "web") }));
