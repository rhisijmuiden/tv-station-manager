/**
 * Switch buttons ("Schakelen"): a few big, named buttons for editors to take a live source on air by hand, for
 * feeds that come in without a planning (a press conference, breaking news, a stream from an event).
 *
 * - Admins make the buttons per channel: a name ("IJmond360 Nieuws live"), a colour and the live source it switches
 *   to. The live source holds the switching scheme: the ATEM input, and for a remote stream the studio node and
 *   DeckLink output it plays on.
 * - Pressing a button takes the source live (the director's manual override): the schedule waits until "back to the
 *   schedule" is pressed. A remote stream asks first: record it? and if so: repeat it once it is finished?
 * - While the ATEM is locked in the orchestrator the buttons do nothing (409 atem_locked).
 */
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ChannelRow } from "./content.js";
import type { DeviceHub } from "./devices.js";
import type { Director } from "./director.js";
import type { Recorder } from "./recorder.js";
import { parseSourceRecording, repeatRuleSchema, type RepeatRule } from "./recordlogic.js";
import type { LiveRow, RemoteSources } from "./remote.js";

interface ButtonRow {
  id: number;
  channel_id: number;
  name: string;
  color: string;
  live_source_id: number;
  position: number;
}

export const pressSchema = z.object({
  /** Remote streams: record this live broadcast. */
  record: z.boolean().optional(),
  /** Plan repeats once the recording is finished. */
  repeat: z.boolean().default(false),
  /** When to repeat; omitted = the repeat times set for the source (Recordings > Sources). */
  repeatAt: repeatRuleSchema.pick({ dayOffset: true, time: true }).nullable().optional(),
});
export type PressChoice = z.infer<typeof pressSchema>;

/** The repeats for a live recording: the time chosen when going live, else the source's own repeat times. */
export function repeatRules(choice: PressChoice, sourceRules: RepeatRule[], channelId: number): RepeatRule[] | "needs_time" {
  if (!choice.record || !choice.repeat) return [];
  if (choice.repeatAt) return [{ dayOffset: choice.repeatAt.dayOffset, time: choice.repeatAt.time, channelId }];
  return sourceRules.length ? sourceRules.map((r) => ({ ...r, channelId: r.channelId ?? channelId })) : "needs_time";
}

export function registerSwitching(app: FastifyInstance, platform: Platform, deps: { hub: DeviceHub; director: Director; remote: RemoteSources; recorder: Recorder }) {
  const { db } = platform.ctx;
  const { hub, director, remote, recorder } = deps;
  const pid = (req: { params: unknown }) => Number((req.params as { id: string }).id);
  const channel = (id: number) => {
    const c = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;
    if (!c) throw new HttpError(404, "not_found");
    return c;
  };
  const button = (id: number) => {
    const b = db.prepare("SELECT * FROM switch_buttons WHERE id = ?").get(id) as ButtonRow | undefined;
    if (!b) throw new HttpError(404, "not_found");
    return b;
  };
  const sourceOf = (b: ButtonRow) => db.prepare("SELECT * FROM live_sources WHERE id = ?").get(b.live_source_id) as (LiveRow & { recording: string }) | undefined;

  const buttonOut = (b: ButtonRow, onAirSource: number | null) => {
    const live = sourceOf(b);
    const cfg = parseSourceRecording(live?.recording);
    return {
      id: b.id,
      channelId: b.channel_id,
      name: b.name,
      color: b.color,
      position: b.position,
      liveSourceId: b.live_source_id,
      source: live
        ? {
            id: live.id,
            name: live.name,
            kind: live.kind,
            atemInput: live.atem_input,
            /** Remote streams: is the picture coming in? */
            state: live.kind === "rtmp" ? remote.status(live).state : null,
            /** Default answers for the "record?" question and the source's own repeat times. */
            recordDefault: cfg.enabled,
            repeatRules: cfg.repeats,
          }
        : null,
      onAir: onAirSource === b.live_source_id,
    };
  };

  /** Everything the editors' switch page shows, per channel. */
  app.get("/api/switch", async () => {
    const channels = db.prepare("SELECT * FROM channels WHERE enabled = 1 ORDER BY id").all() as unknown as ChannelRow[];
    return {
      channels: channels.map((c) => {
        const st = director.status(c);
        const ov = st.override;
        const buttons = db.prepare("SELECT * FROM switch_buttons WHERE channel_id = ? ORDER BY position, id").all(c.id) as unknown as ButtonRow[];
        const rec = ov ? recorder.active().find((a) => a.liveSourceId === ov.liveSourceId) : undefined;
        const intent = ov ? recorder.intent(ov.liveSourceId) : null;
        return {
          channel: { id: c.id, name: c.name, color: c.color },
          automation: st.automation,
          atemConnected: !!st.atem?.connected,
          atemLock: st.atemLock,
          current: st.current,
          next: st.upcoming[0] ?? null,
          override: ov,
          recording: ov && remote.live(ov.liveSourceId)?.kind === "rtmp" ? { active: !!rec, since: rec?.since ?? null, repeat: !!intent?.repeats.length, record: intent?.record ?? null } : null,
          buttons: buttons.map((b) => buttonOut(b, ov?.liveSourceId ?? null)),
        };
      }),
    };
  });

  // ---- admin: the buttons --------------------------------------------------------------
  const buttonIn = z.object({
    channelId: z.number().int(),
    name: z.string().trim().min(1).max(60),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#3B6CFF"),
    liveSourceId: z.number().int(),
  });
  const check = (b: z.infer<typeof buttonIn>) => {
    channel(b.channelId);
    if (!remote.live(b.liveSourceId)) throw new HttpError(404, "not_found");
  };
  app.get("/api/switch/buttons", async () => ({
    buttons: (db.prepare("SELECT * FROM switch_buttons ORDER BY channel_id, position, id").all() as unknown as ButtonRow[]).map((b) => buttonOut(b, director.override(b.channel_id)?.liveSourceId ?? null)),
  }));
  app.post("/api/switch/buttons", async (req) => {
    requireRole(req, "admin");
    const b = buttonIn.parse(req.body);
    check(b);
    const pos = (db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM switch_buttons WHERE channel_id = ?").get(b.channelId) as { p: number }).p;
    const r = db.prepare("INSERT INTO switch_buttons (channel_id, name, color, live_source_id, position) VALUES (?, ?, ?, ?, ?)").run(b.channelId, b.name, b.color, b.liveSourceId, pos);
    return { ok: true, id: Number(r.lastInsertRowid) };
  });
  app.put("/api/switch/buttons/:id", async (req) => {
    requireRole(req, "admin");
    const cur = button(pid(req));
    const b = buttonIn.parse(req.body);
    check(b);
    db.prepare("UPDATE switch_buttons SET channel_id = ?, name = ?, color = ?, live_source_id = ? WHERE id = ?").run(b.channelId, b.name, b.color, b.liveSourceId, cur.id);
    return { ok: true };
  });
  app.delete("/api/switch/buttons/:id", async (req) => {
    requireRole(req, "admin");
    db.prepare("DELETE FROM switch_buttons WHERE id = ?").run(button(pid(req)).id);
    return { ok: true };
  });
  /** New order of a channel's buttons (ids, first to last). */
  app.post("/api/switch/buttons/order", async (req) => {
    requireRole(req, "admin");
    const { ids } = z.object({ ids: z.array(z.number().int()).max(200) }).parse(req.body);
    const set = db.prepare("UPDATE switch_buttons SET position = ? WHERE id = ?");
    ids.forEach((id, i) => set.run(i, id));
    return { ok: true };
  });

  // ---- editors: press a button, back to the schedule ------------------------------------
  app.post("/api/switch/buttons/:id/press", async (req) => {
    requireRole(req, "operator");
    const b = button(pid(req));
    const choice = pressSchema.parse(req.body ?? {});
    const c = channel(b.channel_id);
    const live = sourceOf(b);
    if (!live) throw new HttpError(404, "not_found");
    if (hub.lock(c.atem_id)) throw new HttpError(409, "atem_locked");
    let repeats: RepeatRule[] = [];
    if (live.kind === "rtmp") {
      const cfg = parseSourceRecording(live.recording);
      const record = choice.record ?? cfg.enabled;
      const r = repeatRules({ ...choice, record }, cfg.repeats, c.id);
      if (r === "needs_time") throw new HttpError(400, "repeat_needs_time");
      repeats = r;
      await director.takeLive(c, live, req.user!.username);
      recorder.goLive(live, { record, repeats, channelId: c.id, title: b.name });
      platform.ctx.log.info({ button: b.name, channel: c.name, record, repeats: repeats.length, by: req.user!.username }, "switch button: remote stream live");
    } else {
      await director.takeLive(c, live, req.user!.username);
      platform.ctx.log.info({ button: b.name, channel: c.name, by: req.user!.username }, "switch button: live");
    }
    return { ok: true };
  });

  app.post("/api/switch/:id/back", async (req) => {
    requireRole(req, "operator");
    // Allowed while the ATEM is locked: the automation then holds its switches until the lock is released.
    await director.resume(channel(pid(req)), req.user!.username);
    return { ok: true };
  });
}
