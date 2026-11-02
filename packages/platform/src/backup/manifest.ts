import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface ManifestEntry {
  /** Path inside the archive, POSIX separators, e.g. "db/app.db" or "conf/secret.key". */
  path: string;
  size: number;
  mtimeMs: number;
  /** mtime/ctime in nanoseconds, used to skip re-hashing unchanged large files. */
  stamp?: string;
  sha256: string;
}

const REHASH_BELOW = 4 * 1024 * 1024;
export type Manifest = Record<string, ManifestEntry>;

export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Walks `root` and returns entries prefixed with `prefix`. Re-hashes only files whose size/mtime changed vs `previous`. */
export async function scanTree(root: string, prefix: string, previous: Manifest = {}, exclude: (rel: string) => boolean = () => false): Promise<Manifest> {
  const out: Manifest = {};
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (exclude(rel)) continue;
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) {
        const st = await stat(abs, { bigint: true });
        const path = `${prefix}/${rel}`;
        const prev = previous[path];
        const size = Number(st.size);
        const stamp = `${st.mtimeNs}:${st.ctimeNs}`;
        // Small files are always hashed; large files reuse the previous hash when size and timestamps are identical.
        const reuse = prev && size >= REHASH_BELOW && prev.size === size && prev.stamp === stamp;
        const sha256 = reuse ? prev.sha256 : await sha256File(abs);
        out[path] = { path, size, mtimeMs: Number(st.mtimeNs / 1_000_000n), stamp, sha256 };
      }
    }
  }
  await walk(root);
  return out;
}

/** Files that are new or changed in `next` compared with `prev`, and files that were deleted. */
export function diffManifest(prev: Manifest, next: Manifest) {
  const changed = Object.values(next).filter((e) => prev[e.path]?.sha256 !== e.sha256);
  const deleted = Object.keys(prev).filter((p) => !(p in next));
  return { changed, deleted };
}
