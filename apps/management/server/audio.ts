/**
 * Audio under the broadcast ("geluid onder"): a sound bed that CasparCG mixes under what the playout layer shows,
 * e.g. the station's live radio behind the beeldkrant. A source is
 * - stream:    an internet stream (Icecast/Shoutcast MP3/AAC, HLS .m3u8, ...), opened by CasparCG's FFmpeg producer,
 * - soundcard: a recording device of Windows on the studio node (line in / jack), via DirectShow,
 * - decklink:  the input of a DeckLink card on the studio node (embedded SDI audio or the analog breakout).
 * Editors pick a source per block or per item; the director plays it on AUDIO_LAYER with its picture hidden.
 */
import type { Db, Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

/** Below the playout layer (10) and the overlay (20); its picture is hidden anyway (opacity 0). */
export const AUDIO_LAYER = 5;

export type AudioKind = "stream" | "soundcard" | "decklink";
export interface AudioRow {
  id: number;
  name: string;
  kind: AudioKind;
  address: string;
  studio_id: number | null;
  volume: number;
}

/** AMCP producer for a source and whether CasparCG should loop it (a stream that ends is opened again). */
export function audioProducer(src: Pick<AudioRow, "kind" | "address">): { producer: string; loop: boolean } {
  const a = src.address.trim();
  if (/["\r\n]/.test(a)) throw new Error("invalid address");
  if (src.kind === "stream") return { producer: `"${a}"`, loop: true };
  if (src.kind === "soundcard") return { producer: `"dshow://audio=${a}"`, loop: false };
  return { producer: `DECKLINK ${Number(a)}`, loop: false };
}

/** 0–150 % in the UI, CasparCG gain 0–1.5. */
export const audioGain = (volume: number) => Math.max(0, Math.min(150, volume)) / 100;

const sourceIn = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["stream", "soundcard", "decklink"]),
    address: z.string().trim().min(1).max(500),
    studioId: z.number().int().nullable().optional(),
    volume: z.number().int().min(0).max(150).default(70),
  })
  .superRefine((v, ctx) => {
    if (/["\r\n]/.test(v.address)) ctx.addIssue({ code: "custom", path: ["address"], message: "invalid_address" });
    if (v.kind === "stream" && !/^(https?|rtmps?|rtsp|srt):\/\/[^\s]+$/i.test(v.address)) ctx.addIssue({ code: "custom", path: ["address"], message: "invalid_url" });
    if (v.kind === "decklink" && !/^\d{1,2}$/.test(v.address)) ctx.addIssue({ code: "custom", path: ["address"], message: "invalid_device" });
    if (v.kind !== "stream" && !v.studioId) ctx.addIssue({ code: "custom", path: ["studioId"], message: "studio_required" });
  });

export const audioSource = (db: Db, id: number) => db.prepare("SELECT * FROM audio_sources WHERE id = ?").get(id) as unknown as AudioRow | undefined;

/** Blocks, items and beeldkranten that use a source. */
function usage(db: Db, id: number) {
  const key = String(id);
  const blocks = (db.prepare("SELECT COUNT(*) AS n FROM blocks WHERE audio = ?").get(key) as { n: number }).n;
  const items = (db.prepare("SELECT COUNT(*) AS n FROM block_items WHERE audio = ?").get(key) as { n: number }).n;
  const beeldkranten = (db.prepare("SELECT settings FROM beeldkranten").all() as { settings: string }[]).filter((b) => {
    try {
      return JSON.parse(b.settings || "{}").audioSourceId === id;
    } catch {
      return false;
    }
  }).length;
  return { blocks, items, beeldkranten };
}

const out = (db: Db, r: AudioRow) => ({ id: r.id, name: r.name, kind: r.kind, address: r.address, studioId: r.studio_id, volume: r.volume, usage: usage(db, r.id) });

export function registerAudio(app: FastifyInstance, platform: Platform, onChange: () => void) {
  const { db } = platform.ctx;
  const pid = (req: { params: unknown }) => Number((req.params as { id: string }).id);
  const parse = (body: unknown) => {
    const r = sourceIn.safeParse(body);
    if (!r.success) {
      const msg = r.error.issues.find((i) => i.code === "custom")?.message;
      throw new HttpError(400, msg ?? "invalid_request", r.error.issues.map((i) => i.message).join(", "));
    }
    return { ...r.data, studioId: r.data.kind === "stream" ? null : (r.data.studioId ?? null) };
  };

  app.get("/api/audio-sources", async () => ({ sources: (db.prepare("SELECT * FROM audio_sources ORDER BY name COLLATE NOCASE").all() as unknown as AudioRow[]).map((r) => out(db, r)) }));

  app.post("/api/audio-sources", async (req) => {
    requireRole(req, "editor");
    const b = parse(req.body);
    const r = db.prepare("INSERT INTO audio_sources (name, kind, address, studio_id, volume) VALUES (?, ?, ?, ?, ?)").run(b.name, b.kind, b.address, b.studioId, b.volume);
    onChange();
    return out(db, audioSource(db, Number(r.lastInsertRowid))!);
  });

  app.put("/api/audio-sources/:id", async (req) => {
    requireRole(req, "editor");
    const b = parse(req.body);
    const r = db.prepare("UPDATE audio_sources SET name = ?, kind = ?, address = ?, studio_id = ?, volume = ? WHERE id = ?").run(b.name, b.kind, b.address, b.studioId, b.volume, pid(req));
    if (!r.changes) throw new HttpError(404, "not_found");
    onChange();
    return out(db, audioSource(db, pid(req))!);
  });

  /** Removing a source also removes it from blocks, items and beeldkranten (they go silent). */
  app.delete("/api/audio-sources/:id", async (req) => {
    requireRole(req, "editor");
    const id = pid(req);
    if (!audioSource(db, id)) throw new HttpError(404, "not_found");
    const key = String(id);
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE blocks SET audio = NULL WHERE audio = ?").run(key);
      db.prepare("UPDATE block_items SET audio = NULL WHERE audio = ?").run(key);
      for (const b of db.prepare("SELECT id, settings FROM beeldkranten").all() as { id: number; settings: string }[]) {
        const s = JSON.parse(b.settings || "{}");
        if (s.audioSourceId === id) db.prepare("UPDATE beeldkranten SET settings = ? WHERE id = ?").run(JSON.stringify({ ...s, audioSourceId: null }), b.id);
      }
      db.prepare("DELETE FROM audio_sources WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    onChange();
    return { ok: true };
  });
}
