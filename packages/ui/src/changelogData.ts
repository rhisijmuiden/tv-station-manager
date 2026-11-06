import { buildChangelog } from "./changelog";

/** All changelog files from the repo root, bundled at build time. */
export const releases = buildChangelog(import.meta.glob("../../../changelog/*/*.json", { eager: true }));
