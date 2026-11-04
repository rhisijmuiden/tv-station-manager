import { baseLayer } from "./layers.js";
import type { Platform } from "@tvsm/platform";
import { HttpError, requireRole } from "@tvsm/platform";
import type { FastifyInstance } from "fastify";
import { networkInterfaces } from "node:os";
import { z } from "zod";
import { AUDIO_LAYER, audioGain, audioProducer, audioSource } from "./audio.js";
import { channelOut, dbLoader, scheduleEntries, type ChannelRow, type Graphics } from "./content.js";
import type { DeviceHub } from "./devices.js";
import type { LiveRow, RemoteSources } from "./remote.js";
import { nextStationHour } from "./hourclock.js";
import { at, casparClip, compile, holdUntil, programAt, skipEvent, type EntryInfo, type TimelineEvent } from "./timeline.js";
import { webcamOf } from "./webcamdb.js";
import { playPlan } from "./webcamlogic.js";
import { tickerHeadlinesFromDb } from "./tickerdb.js";
import { tickerData, tickerHeight } from "./tickerlogic.js";

/**
 * The director ("regisseur"). For every channel with automation on it follows the compiled schedule:
 * it tells the studio node (CasparCG) what to play on its channel, switches the ATEM to the right input,
 * starts RTMP/live sources, keeps the graphics overlay up to date and writes the as-run log.
 *
 * Two studio nodes per channel: the channel's own studio node plays the schedule (playout node) and a remote source
 * can live on another node (live node, RTMP/SRT ingest from events). Then the director
 * - starts the stream on the live node's DeckLink output ahead of time (LIVE_PREROLL_MS) so the ATEM cut is clean,
 * - keeps the playout node on standby (filler loop) while the live node is on air,
 * - stays on (or goes back to) the playout node while the stream is not coming in, and cuts over once it is,
 * - puts the same graphics overlay (logo, clock, ...) on the live node's output.
 */

export const PLAYOUT_LAYER = 10;
/** Caption of a webcam ("LIVE · Strand Wijk aan Zee"), just above the playout layer and below the channel overlay. */
export const CAPTION_LAYER = 11;
const PRELOAD_MS = 3000;
const RETRY_MS = 5000;
/** A clip whose file CasparCG cannot find is skipped after this long; the rest of its programme moves up. */
export const SKIP_MISSING_MS = 10_000;
const WINDOW_BACK = 6 * 3600_000;
const WINDOW_AHEAD = 30 * 3600_000;
const ALERT_EVERY_MS = 5 * 60_000;
/** A timeline compiled longer ago than this is not what is on air any more: it is not held. */
const HOLD_STALE_MS = 5 * 60_000;
/** A live item on another studio node is started this long before it goes on air. */
export const LIVE_PREROLL_MS = 30_000;
/** A stream must have been playing on CasparCG this long before the ATEM cuts to it. */
export const LIVE_SETTLE_MS = 1500;

type Output = { studioId: number; casparChannel: number };

interface ChannelState {
  events: TimelineEvent[];
  /** Occurrence (hour block) and EPG flag per schedule entry, for the "now on TV" overview. */
  entries: Map<number, EntryInfo>;
  compiledAt: number;
  currentKey: string | null;
  executedAt: number;
  failedKey: string | null;
  /** When the failing item first failed, and whether CasparCG said its file does not exist. */
  failedSince: number;
  failedNotFound: boolean;
  /** Items skipped because their file was missing (key -> time skipped), applied again after every compile. */
  skips: Map<string, number>;
  preloadedKey: string | null;
  override: { liveSourceId: number; name: string; since: string } | null;
  activeRtmp: (Output & { liveId: number }) | null;
  /** Remote source of an upcoming live item, already started on its output. */
  prerolled: (Output & { key: string }) | null;
  /** A live item on another node is current but its stream is not playing: the playout node stays on air. */
  standby: { liveSourceId: number; name: string; since: string; input: number | null } | null;
  graphicsLoaded: boolean;
  /** CasparCG connection the current item was played on; a new one (restart) starts from a clean server. */
  playoutSession: number | undefined;
  graphicsJson: string | null;
  /** Graphics overlay on the live node's output. */
  liveGfx: (Output & { session: number | undefined; json: string }) | null;
  lastError: string | null;
  lastAlertAt: number;
  /** Audio source playing under the programme on AUDIO_LAYER (radio stream, line input). */
  audio: (Output & { sourceId: number; name: string; volume: number; session: number | undefined }) | null;
  audioError: { sourceId: number; message: string; at: number } | null;
  /** A webcam caption is on CAPTION_LAYER of the playout channel. */
  captionOn: boolean;
  /**
   * Changes to the hour on air wait for the next whole hour (`until`): the timeline as compiled before the change is
   * kept until then, so a block edited at 14:30 does not restart the clip playing; it goes on air at 15:00.
   * `changed` = the picture would change (shown to the editors), otherwise only keys differed (e.g. a republish).
   */
  hold: { until: number; events: TimelineEvent[]; entries: Map<number, EntryInfo>; changed: boolean } | null;
  /** "Apply now" was pressed: the next compile takes the new schedule at once. */
  applyNow: boolean;
}

export class Director {
  private states = new Map<number, ChannelState>();
  /** RSS headlines of each channel's ticker, re-read every `ticker.refreshMinutes` (or when its settings change). */
  private tickerCache = new Map<number, { key: string; at: number; headlines: string[] }>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = true;
  private busy = new Set<number>();
  now = () => Date.now();

  constructor(
    private platform: Platform,
    private hub: DeviceHub,
    private remote: RemoteSources,
  ) {}

  start(intervalMs = 200) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  /** Schedule, blocks or media changed: recompile on the next tick. */
  invalidate() {
    this.dirty = true;
  }

  private channels() {
    return this.platform.ctx.db.prepare("SELECT * FROM channels WHERE enabled = 1").all() as unknown as ChannelRow[];
  }
  private state(id: number): ChannelState {
    let s = this.states.get(id);
    if (!s) {
      s = { events: [], entries: new Map(), compiledAt: 0, currentKey: null, executedAt: 0, failedKey: null, failedSince: 0, failedNotFound: false, skips: new Map(), preloadedKey: null, override: null, activeRtmp: null, prerolled: null, standby: null, graphicsLoaded: false, playoutSession: undefined, graphicsJson: null, liveGfx: null, lastError: null, lastAlertAt: 0, audio: null, audioError: null, captionOn: false, hold: null, applyNow: false };
      this.states.set(id, s);
    }
    return s;
  }

  recompile(ch: ChannelRow) {
    const now = this.now();
    const s = this.state(ch.id);
    const from = now - WINDOW_BACK;
    const to = now + WINDOW_AHEAD;
    const entries = scheduleEntries(this.platform.ctx.db, ch.id, from, to);
    for (const [key, t] of s.skips) if (t < from) s.skips.delete(key);
    let fresh = compile(dbLoader(this.platform.ctx.db), entries, from, to).events;
    for (const [key, t] of s.skips) fresh = skipEvent(fresh, key, t);
    const freshEntries = new Map<number, EntryInfo>(entries.map((e) => [e.id, { group: e.group ?? null, inEpg: e.inEpg }]));
    if (s.hold && (now >= s.hold.until || s.applyNow || !ch.automation)) s.hold = null;
    // Only a channel that is playing holds its hour; the first compile, manual control, a stale timeline (the
    // director was not running) and "apply now" take the new schedule at once.
    if (!s.hold && ch.automation && s.compiledAt > 0 && now - s.compiledAt < HOLD_STALE_MS && !s.applyNow) {
      const until = nextStationHour(now, this.timeZone());
      s.hold = { until, events: s.events.filter((e) => e.start < until), entries: s.entries, changed: false };
    }
    s.applyNow = false;
    const r = s.hold ? holdUntil(s.hold.events, fresh, now, s.hold.until) : null;
    if (s.hold && r?.differs) {
      if (r.changed && !s.hold.changed) this.asrun(ch.id, "control", "Schedule changed", `Goes on air at ${new Date(s.hold.until).toISOString()} (the hour on air plays on)`, true);
      s.hold.changed = r.changed;
      s.events = r.events;
      s.entries = new Map([...s.hold.entries, ...freshEntries]);
    } else {
      s.hold = null;
      s.events = fresh;
      s.entries = freshEntries;
    }
    s.compiledAt = now;
  }

  private timeZone() {
    return this.platform.ctx.settings.get<string>("station.timezone", "Europe/Amsterdam");
  }

  /** Schedule changes waiting for the next hour on this channel, if any. */
  pending(channelId: number) {
    const h = this.states.get(channelId)?.hold;
    return h?.changed && h.until > this.now() ? { from: new Date(h.until).toISOString() } : null;
  }

  /** Takes the changed schedule on air now instead of at the next hour (the item on air may restart). */
  applyNow(channelId: number) {
    const s = this.state(channelId);
    s.applyNow = true;
    s.hold = null;
    this.dirty = true;
  }

  async tick() {
    const now = this.now();
    const chans = this.channels();
    const recompileAll = this.dirty;
    this.dirty = false;
    for (const ch of chans) {
      const s = this.state(ch.id);
      if (recompileAll || now - s.compiledAt > 60_000) this.recompile(ch);
      if (!ch.automation || this.busy.has(ch.id)) continue;
      this.busy.add(ch.id);
      try {
        await this.step(ch, s, now);
      } finally {
        this.busy.delete(ch.id);
      }
    }
  }

  private async step(ch: ChannelRow, s: ChannelState, now: number): Promise<void> {
    const { current, upcoming } = at(s.events, now);
    this.checkPlayoutSession(ch, s);
    if (s.override) {
      const live = this.live(s.override.liveSourceId);
      if (live) await this.switchTo(ch, live.atem_input).catch((e) => this.fail(ch, s, `override: ${(e as Error).message}`));
    } else if (current) {
      if (current.type === "media" && s.failedKey === current.key && s.failedNotFound && now - s.failedSince >= SKIP_MISSING_MS) {
        // The file is not there: skip it so the picture does not stand still, the rest of the programme moves up.
        s.skips.set(current.key, now);
        s.events = skipEvent(s.events, current.key, now);
        if (s.hold) s.hold.events = skipEvent(s.hold.events, current.key, now);
        s.failedKey = null;
        s.lastError = null;
        this.asrun(ch.id, "media", current.title, `Skipped: file not found (${current.leaf?.path ?? ""})`, false);
        return this.step(ch, s, now);
      }
      const changed = current.key !== s.currentKey;
      const retry = s.failedKey === current.key && now - s.executedAt > RETRY_MS;
      if (changed || retry) await this.execute(ch, s, current, now);
      else if (current.type === "live" && s.failedKey !== current.key) await this.followLive(ch, s, current).catch((e) => this.fail(ch, s, (e as Error).message, current));
      // Preload the next clip on the playout layer so the switch is seamless.
      const next = upcoming[0];
      if (next && next.type === "media" && next.leaf?.path && s.preloadedKey !== next.key && next.start - now <= PRELOAD_MS && next.start > now) {
        s.preloadedKey = next.key;
        await this.playout(ch)
          ?.loadbg(ch.caspar_channel, PLAYOUT_LAYER, casparClip(next.leaf.path))
          .catch(() => (s.preloadedKey = null));
      }
      await this.preroll(ch, s, current, upcoming, now).catch((e) => this.fail(ch, s, `preroll: ${(e as Error).message}`));
    }
    await this.syncAudio(ch, s, current, now).catch(() => undefined);
    await this.updateGraphics(ch, s, current, upcoming, now).catch(() => undefined);
  }

  private playout(ch: ChannelRow) {
    return this.hub.playout(ch.studio_id);
  }

  /**
   * CasparCG came back with empty layers (service restart, crash, reconnect): play the current item again (at its
   * offset), preload the next one and add the overlay again. A restart shorter than one tick is not seen as a
   * disconnect, so compare the connection session instead of waiting for `connected` to drop.
   */
  private checkPlayoutSession(ch: ChannelRow, s: ChannelState) {
    const info = this.playout(ch)?.info();
    if (!info?.connected) return;
    if (s.playoutSession !== undefined && info.session !== s.playoutSession) {
      s.currentKey = null;
      s.preloadedKey = null;
      s.graphicsLoaded = false;
      s.captionOn = false;
      this.asrun(ch.id, "control", "CasparCG reconnected", "Current item and overlay played again", true);
    }
    s.playoutSession = info.session;
  }
  private live(id: number) {
    return this.remote.live(id);
  }

  private async switchTo(ch: ChannelRow, input: number | null) {
    if (input == null) return;
    const sw = this.hub.switcher(ch.atem_id);
    if (!sw) throw new Error("no ATEM switcher configured for this channel");
    if (sw.info().program[ch.atem_me] === input) return;
    await sw.program(input, ch.atem_me, ch.transition);
  }

  /** Stops the remote source this channel started, unless it is `keep` or the prerolled upcoming live item. */
  private async stopRtmp(s: ChannelState, keep?: Output) {
    const a = s.activeRtmp;
    const k = keep ?? s.prerolled;
    if (!a || (k && sameOutput(k, a))) return;
    s.activeRtmp = null;
    await this.remote.unroute(a.studioId, a.casparChannel);
  }

  /** Remote source: CasparCG plays the stream to its DeckLink output (started as soon as the stream arrives). */
  private async takeRemote(s: ChannelState, live: LiveRow) {
    if (live.kind !== "rtmp" || !live.studio_id || !live.caspar_channel) return this.stopRtmp(s);
    const keep = { studioId: live.studio_id, casparChannel: live.caspar_channel };
    await this.stopRtmp(s, keep);
    await this.remote.route(live);
    s.activeRtmp = { ...keep, liveId: live.id };
  }

  /** The remote source plays on another DeckLink output than the channel's playout (usually the live node). */
  private separate(ch: ChannelRow, live: LiveRow) {
    return live.kind === "rtmp" && !!live.studio_id && !!live.caspar_channel && !(live.studio_id === ch.studio_id && live.caspar_channel === ch.caspar_channel);
  }

  /** Is the live source's picture on its DeckLink output, so the ATEM can cut to it? */
  private streamReady(live: LiveRow) {
    if (live.kind !== "rtmp") return true;
    const since = this.remote.playingSince(live);
    return since != null && this.remote.now() - since >= LIVE_SETTLE_MS;
  }

  /** Filler loop on the playout node (or the fallback input); returns the ATEM input to show it. */
  private async playStandby(ch: ChannelRow): Promise<number | null> {
    const filler = ch.filler_media_id ? (this.platform.ctx.db.prepare("SELECT path FROM media WHERE id = ? AND missing = 0").get(ch.filler_media_id) as { path: string } | undefined) : undefined;
    const p = this.playout(ch);
    if (filler && p) {
      this.remote.forget(ch.studio_id, ch.caspar_channel);
      await p.play(ch.caspar_channel, PLAYOUT_LAYER, casparClip(filler.path), { loop: true });
      return ch.playout_input;
    }
    if (ch.fallback_input != null) return ch.fallback_input;
    await p?.stop(ch.caspar_channel, PLAYOUT_LAYER).catch(() => undefined);
    return ch.playout_input;
  }

  /** Starts the stream of the next live item on its own output well before it goes on air. */
  private async preroll(ch: ChannelRow, s: ChannelState, current: TimelineEvent, upcoming: TimelineEvent[], now: number) {
    if (s.prerolled && current.key !== s.prerolled.key && !upcoming.some((e) => e.key === s.prerolled!.key)) {
      // The live item was taken out of the schedule.
      const gone = s.prerolled;
      s.prerolled = null;
      if (s.activeRtmp && sameOutput(s.activeRtmp, gone) && current.type !== "live") await this.stopRtmp(s);
    }
    const next = upcoming[0];
    if (!next || next.type !== "live" || !next.leaf?.liveSourceId || next.start <= now || next.start - now > LIVE_PREROLL_MS || s.prerolled?.key === next.key) return;
    const live = this.live(next.leaf.liveSourceId);
    if (!live || !this.separate(ch, live)) return;
    const out = { studioId: live.studio_id!, casparChannel: live.caspar_channel! };
    // A stream on air right now is never stopped for a preroll.
    if (current.type === "live" && s.activeRtmp && s.activeRtmp.liveId !== live.id) return;
    s.prerolled = { ...out, key: next.key };
    await this.takeRemote(s, live).catch((e) => {
      s.prerolled = null;
      throw e;
    });
  }

  /** While a live item on another node is current: cut to it once its stream plays, back to standby when it drops. */
  private async followLive(ch: ChannelRow, s: ChannelState, ev: TimelineEvent) {
    const live = this.live(ev.leaf!.liveSourceId!);
    if (!live || !this.separate(ch, live)) return;
    const ready = this.streamReady(live);
    if (s.standby && ready) {
      s.standby = null;
      await this.switchTo(ch, live.atem_input);
      this.asrun(ch.id, "live", live.name, "Stream is in: live node on air", true);
    } else if (!s.standby && !ready) {
      s.standby = { liveSourceId: live.id, name: live.name, since: new Date(this.now()).toISOString(), input: ch.filler_media_id ? ch.playout_input : (ch.fallback_input ?? ch.playout_input) };
      await this.switchTo(ch, s.standby.input);
      this.fail(ch, s, `Stream of ${live.name} dropped: back to the playout node until it returns`, ev);
    } else if (s.standby) await this.switchTo(ch, s.standby.input);
  }

  private async execute(ch: ChannelRow, s: ChannelState, ev: TimelineEvent, now: number) {
    s.currentKey = ev.key;
    s.executedAt = now;
    const elapsed = now - ev.start + ev.offsetMs;
    try {
      if (s.captionOn && ev.type !== "webcam") await this.clearCaption(ch, s);
      if (ev.type === "media" && ev.leaf?.path) {
        const p = this.playout(ch);
        if (!p) throw new Error("no studio node configured for this channel");
        this.remote.forget(ch.studio_id, ch.caspar_channel);
        const preloaded = s.preloadedKey === ev.key && elapsed < 1000;
        if (preloaded) await p.play(ch.caspar_channel, PLAYOUT_LAYER);
        else await p.play(ch.caspar_channel, PLAYOUT_LAYER, casparClip(ev.leaf.path), { seek: elapsed > 1000 ? Math.floor((elapsed / 1000) * (ev.leaf.fps || 25)) : 0 });
        s.standby = null;
        await this.stopRtmp(s);
        await this.switchTo(ch, ch.playout_input);
      } else if (ev.type === "beeldkrant" && ev.leaf?.beeldkrantId) {
        // Full-screen news pages: a web page on the playout layer (CasparCG HTML producer), the playout node on air.
        const p = this.playout(ch);
        if (!p) throw new Error("no studio node configured for this channel");
        this.remote.forget(ch.studio_id, ch.caspar_channel);
        await p.playHtml(ch.caspar_channel, PLAYOUT_LAYER, beeldkrantUrl(this.platform, ev.leaf.beeldkrantId, ev.start - ev.offsetMs, this.tickerSpace(ch, ev, now)));
        s.standby = null;
        await this.stopRtmp(s);
        await this.switchTo(ch, ch.playout_input);
      } else if (ev.type === "lineup") {
        // "Coming up" slide: a static page with the programmes of the coming hour, made from the schedule.
        const p = this.playout(ch);
        if (!p) throw new Error("no studio node configured for this channel");
        this.remote.forget(ch.studio_id, ch.caspar_channel);
        await p.playHtml(ch.caspar_channel, PLAYOUT_LAYER, lineupUrl(this.platform, ch.id, ev.start - ev.offsetMs));
        s.standby = null;
        await this.stopRtmp(s);
        await this.switchTo(ch, ch.playout_input);
      } else if (ev.type === "info" && ev.leaf?.infoPageId) {
        // Fixed info page made by the editors: a static page in the channel's house style.
        const p = this.playout(ch);
        if (!p) throw new Error("no studio node configured for this channel");
        this.remote.forget(ch.studio_id, ch.caspar_channel);
        await p.playHtml(ch.caspar_channel, PLAYOUT_LAYER, infoPageUrl(this.platform, ev.leaf.infoPageId, ch.id));
        s.standby = null;
        await this.stopRtmp(s);
        await this.switchTo(ch, ch.playout_input);
      } else if (ev.type === "webcam" && ev.leaf?.webcamId) {
        await this.playWebcam(ch, s, ev.leaf.webcamId);
      } else if (ev.type === "live" && ev.leaf?.liveSourceId) {
        const live = this.live(ev.leaf.liveSourceId);
        if (!live) throw new Error("live source was removed");
        if (s.prerolled?.key === ev.key) s.prerolled = null;
        await this.takeRemote(s, live);
        if (this.separate(ch, live)) {
          // Live node on air; the playout node goes to standby so it can take over if the stream drops.
          const standbyInput = await this.playStandby(ch);
          if (this.streamReady(live)) {
            s.standby = null;
            await this.switchTo(ch, live.atem_input);
          } else {
            s.standby = { liveSourceId: live.id, name: live.name, since: new Date(now).toISOString(), input: standbyInput };
            await this.switchTo(ch, standbyInput);
            if (this.remote.status(live).state === "waiting") this.asrun(ch.id, "live", live.name, "Waiting for the stream: playout node stays on air", false);
          }
        } else {
          s.standby = null;
          await this.switchTo(ch, live.atem_input);
        }
      } else {
        // Gap in the schedule: filler clip in a loop, or the fallback ATEM input (e.g. a station ident / colour bars).
        s.standby = null;
        await this.stopRtmp(s);
        await this.switchTo(ch, await this.playStandby(ch));
      }
      if (s.failedKey === ev.key) s.failedKey = null;
      s.lastError = null;
      this.asrun(ch.id, ev.type, ev.type === "filler" ? "Filler" : ev.title, ev.programTitle || null, true);
    } catch (e) {
      const message = (e as Error).message;
      if (s.failedKey !== ev.key) s.failedSince = now;
      s.failedKey = ev.key;
      s.failedNotFound = /\b404\b|not found/i.test(message);
      this.fail(ch, s, message, ev);
    }
  }

  /**
   * Webcam / external stream on the playout layer, the playout node on air. Video streams play with the FFmpeg
   * producer (by default relayed by the management node), pictures and web pages with the HTML producer; the caption
   * goes on the layer above. When the stream does not come in, an "picture not available" card is shown and the
   * director tries again (RETRY_MS) until it does.
   */
  private async playWebcam(ch: ChannelRow, s: ChannelState, webcamId: number) {
    const p = this.playout(ch);
    if (!p) throw new Error("no studio node configured for this channel");
    const cam = webcamOf(this.platform.ctx.db, webcamId);
    if (!cam) throw new Error("webcam was removed");
    const base = publicUrl(this.platform);
    const plan = playPlan(cam, base);
    this.remote.forget(ch.studio_id, ch.caspar_channel);
    s.standby = null;
    await this.stopRtmp(s);
    await this.switchTo(ch, ch.playout_input);
    try {
      if (plan.mode === "video") await p.play(ch.caspar_channel, PLAYOUT_LAYER, plan.url);
      else await p.playHtml(ch.caspar_channel, PLAYOUT_LAYER, plan.url);
    } catch (e) {
      await p.playHtml(ch.caspar_channel, PLAYOUT_LAYER, `${base}/webcam/page.html?id=${cam.id}&offline=1`).catch(() => undefined);
      if (s.captionOn) await this.clearCaption(ch, s);
      throw new Error(`webcam ${cam.name}: ${(e as Error).message}`);
    }
    if (plan.captionUrl) {
      await p.playHtml(ch.caspar_channel, CAPTION_LAYER, plan.captionUrl).catch(() => undefined);
      s.captionOn = true;
    } else if (s.captionOn) await this.clearCaption(ch, s);
  }

  private async clearCaption(ch: ChannelRow, s: ChannelState) {
    s.captionOn = false;
    await this.playout(ch)
      ?.clear(ch.caspar_channel, CAPTION_LAYER)
      .catch(() => undefined);
  }

  private fail(ch: ChannelRow, s: ChannelState, message: string, ev?: TimelineEvent) {
    const first = s.lastError !== message;
    s.lastError = message;
    if (first) {
      this.platform.ctx.log.warn({ channel: ch.name, err: message }, "playout error");
      this.asrun(ch.id, ev?.type ?? "error", ev?.title || "Error", message, false);
    }
    const now = this.now();
    if (now - s.lastAlertAt > ALERT_EVERY_MS) {
      s.lastAlertAt = now;
      void this.platform.mail.alert(`Playout problem on ${ch.name}`, `${ch.name}: ${message}${ev ? `\nItem: ${ev.title} (${new Date(ev.start).toISOString()})` : ""}`);
    }
  }

  private asrun(channelId: number, kind: string, title: string, detail: string | null, ok: boolean) {
    this.platform.ctx.db.prepare("INSERT INTO asrun (channel_id, kind, title, detail, ok) VALUES (?, ?, ?, ?, ?)").run(channelId, kind, title, detail, ok ? 1 : 0);
  }

  // ---- audio under the programme ---------------------------------------------------

  /** The audio source that should sound now: only while the playout node itself is on air (clip, beeldkrant or webcam). */
  private wantedAudio(s: ChannelState, current: TimelineEvent | null) {
    if (s.override || s.standby || !current || (current.type !== "media" && current.type !== "beeldkrant" && current.type !== "webcam" && current.type !== "lineup" && current.type !== "info")) return null;
    return current.leaf?.audioSourceId ?? null;
  }

  /**
   * Keeps AUDIO_LAYER in line with the current item. The same source on consecutive items keeps playing
   * (no gap between two beeldkrant pages or clips); a CasparCG restart starts it again.
   */
  private async syncAudio(ch: ChannelRow, s: ChannelState, current: TimelineEvent | null, now: number) {
    const wantId = this.wantedAudio(s, current);
    const src = wantId != null ? audioSource(this.platform.ctx.db, wantId) : undefined;
    const p = this.playout(ch);
    const info = p?.info();
    const cur = s.audio;
    // A physical input only exists on its own studio node.
    const wrongNode = src && src.kind !== "stream" && src.studio_id !== ch.studio_id;
    const want = src && !wrongNode && p && info?.connected ? src : undefined;
    if (wrongNode && s.audioError?.sourceId !== src.id) this.audioFailed(ch, s, src.id, "input is on another studio node than this channel");
    if (cur && (!want || cur.sourceId !== want.id || cur.studioId !== ch.studio_id || cur.casparChannel !== ch.caspar_channel || cur.session !== info?.session)) {
      s.audio = null;
      // After a CasparCG restart the layer is gone already.
      if (cur.session === this.hub.playout(cur.studioId)?.info().session) await this.hub.playout(cur.studioId)?.clear(cur.casparChannel, AUDIO_LAYER).catch(() => undefined);
    }
    if (!want || !p?.playAudio) return;
    if (s.audio) {
      if (s.audio.volume !== want.volume) {
        s.audio.volume = want.volume;
        await p.volume?.(ch.caspar_channel, AUDIO_LAYER, audioGain(want.volume));
      }
      return;
    }
    if (s.audioError?.sourceId === want.id && now - s.audioError.at < RETRY_MS) return;
    try {
      const { producer, loop } = audioProducer(want);
      await p.playAudio(ch.caspar_channel, AUDIO_LAYER, producer, audioGain(want.volume), loop);
      s.audio = { studioId: ch.studio_id!, casparChannel: ch.caspar_channel, sourceId: want.id, name: want.name, volume: want.volume, session: info?.session };
      if (s.audioError) this.asrun(ch.id, "audio", want.name, "Audio under the programme plays again", true);
      s.audioError = null;
    } catch (e) {
      this.audioFailed(ch, s, want.id, (e as Error).message, want.name);
    }
  }

  private audioFailed(ch: ChannelRow, s: ChannelState, sourceId: number, message: string, name?: string) {
    const first = s.audioError?.sourceId !== sourceId || s.audioError.message !== message;
    s.audioError = { sourceId, message, at: this.now() };
    if (!first) return;
    this.platform.ctx.log.warn({ channel: ch.name, err: message }, "audio under the programme failed");
    this.asrun(ch.id, "audio", name ?? `Audio ${sourceId}`, message, false);
  }

  // ---- graphics overlay -------------------------------------------------------

  graphicsData(ch: ChannelRow, current: TimelineEvent | null, upcoming: TimelineEvent[], now: number) {
    const g = channelOut(ch).graphics as Graphics;
    // The base layer (logo, clock, ticker) follows the channel's rule for this kind of content: a beeldkrant has its own
    // logo and clock, a commercial goes without (unless "hide in commercials" was switched off before the rules existed).
    const base = baseLayer(g.layers, current);
    const rule = base.kind === "commercial" && !g.hideInCommercials ? g.layers.media : base;
    const hidden = !g.enabled || (!rule.logo && !rule.clock && !rule.ticker);
    // "Up next" shows the next programme (schedule entry) shortly before the current one ends.
    const nextProgram = upcoming.find((e) => e.scheduleId != null && !e.fill && e.scheduleId !== current?.scheduleId && e.offsetMs === 0);
    const untilNext = nextProgram ? nextProgram.start - now : Infinity;
    const upNextVisible = g.upNext.enabled && !hidden && untilNext <= g.upNext.secondsBeforeEnd * 1000 && untilNext > (g.upNext.secondsBeforeEnd - g.upNext.durationSeconds) * 1000;
    return {
      channel: ch.name,
      hidden,
      logo: { ...g.logo, enabled: g.logo.enabled && rule.logo, url: g.logo.file ? `${publicUrl(this.platform)}/graphics/${ch.id}/logo?v=${encodeURIComponent(g.logo.file)}` : null },
      clock: { ...g.clock, enabled: g.clock.enabled && rule.clock },
      ticker: tickerData(g.ticker, g.ticker.enabled && rule.ticker, this.tickerHeadlines(ch.id, g.ticker, now)),
      now: { title: current?.programTitle || current?.title || "" },
      upNext: { visible: upNextVisible, title: nextProgram?.programTitle ?? "", startAt: nextProgram ? new Date(nextProgram.start).toISOString() : null },
      subtitles: this.subtitlesFor(g, current),
    };
  }

  /** The ticker's RSS headlines; kept for `refreshMinutes` so the running line does not change on every feed fetch. */
  tickerHeadlines(channelId: number, t: Graphics["ticker"], now: number): string[] {
    if (t.source === "text" || !t.feedIds.length) return [];
    const key = JSON.stringify([t.source, t.feedIds, t.maxItems, t.maxAgeHours, t.showTime]);
    const c = this.tickerCache.get(channelId);
    if (c && c.key === key && now - c.at < t.refreshMinutes * 60_000) return c.headlines;
    const headlines = tickerHeadlinesFromDb(this.platform.ctx.db, t, now, this.platform.ctx.settings.get("station.timezone", "Europe/Amsterdam"));
    this.tickerCache.set(channelId, { key, at: now, headlines });
    return headlines;
  }

  /** Room the beeldkrant page keeps free at the bottom for the channel's ticker (0 = no ticker during this item). */
  private tickerSpace(ch: ChannelRow, ev: TimelineEvent, now: number) {
    const g = channelOut(ch).graphics as Graphics;
    if (!g.enabled || !g.ticker.enabled || !baseLayer(g.layers, ev).ticker) return 0;
    return tickerData(g.ticker, true, this.tickerHeadlines(ch.id, g.ticker, now)).enabled ? tickerHeight(g.ticker.fontSize) : 0;
  }

  /** Cues URL + the wall-clock time of the clip's first frame; the overlay times the cues itself (NTP-synced clocks). */
  private subtitlesFor(g: Graphics, current: TimelineEvent | null) {
    const off = { enabled: false, url: null, clipStart: null, size: g.subtitles.size };
    if (!g.enabled || !g.subtitles.enabled || current?.type !== "media" || !current.leaf?.mediaId) return off;
    const m = this.platform.ctx.db.prepare("SELECT subtitle_path FROM media WHERE id = ?").get(current.leaf.mediaId) as { subtitle_path: string | null } | undefined;
    if (!m?.subtitle_path) return off;
    return { enabled: true, url: `${publicUrl(this.platform)}/graphics/subtitles/${current.leaf.mediaId}?v=${encodeURIComponent(m.subtitle_path)}`, clipStart: current.start - current.offsetMs, size: g.subtitles.size };
  }

  private async updateGraphics(ch: ChannelRow, s: ChannelState, current: TimelineEvent | null, upcoming: TimelineEvent[], now: number) {
    const g = channelOut(ch).graphics;
    const data = this.graphicsData(ch, current, upcoming, now);
    const json = JSON.stringify(data);
    await this.updateLiveGraphics(ch, s, g, data, json).catch(() => undefined);
    const p = this.playout(ch);
    if (!p || !p.info().connected) {
      s.graphicsLoaded = false;
      return;
    }
    if (!s.graphicsLoaded) {
      s.graphicsLoaded = true;
      s.graphicsJson = json;
      await p.cgAdd(ch.caspar_channel, g.layer, g.template, data).catch((e) => {
        s.graphicsLoaded = false;
        throw e;
      });
    } else if (json !== s.graphicsJson) {
      s.graphicsJson = json;
      await p.cgUpdate(ch.caspar_channel, g.layer, data);
    }
  }

  /** The same overlay on the live node's output while this channel uses it, so the logo stays on air. */
  private async updateLiveGraphics(ch: ChannelRow, s: ChannelState, g: Graphics, data: unknown, json: string) {
    const a = s.activeRtmp;
    const target = a && !(a.studioId === ch.studio_id && a.casparChannel === ch.caspar_channel) ? a : null;
    const cur = s.liveGfx;
    if (cur && (!target || !sameOutput(cur, target))) {
      s.liveGfx = null;
      await this.hub.playout(cur.studioId)?.clear(cur.casparChannel, g.layer);
    }
    if (!target) return;
    const lp = this.hub.playout(target.studioId);
    const info = lp?.info();
    if (!lp || !info?.connected) {
      s.liveGfx = null;
      return;
    }
    if (!s.liveGfx || s.liveGfx.session !== info.session) {
      s.liveGfx = { studioId: target.studioId, casparChannel: target.casparChannel, session: info.session, json };
      await lp.cgAdd(target.casparChannel, g.layer, g.template, data).catch((e) => {
        s.liveGfx = null;
        throw e;
      });
    } else if (json !== s.liveGfx.json) {
      s.liveGfx.json = json;
      await lp.cgUpdate(target.casparChannel, g.layer, data);
    }
  }

  /** Which node is on air: the playout node, the live node, the fallback input or something else. */
  private onAir(ch: ChannelRow, s: ChannelState, program: number | null | undefined) {
    if (program == null) return null;
    const name = (id: number | null | undefined) => (id == null ? null : (this.hub.playouts.get(id)?.name ?? null));
    const a = s.activeRtmp;
    const live = a ? this.live(a.liveId) : undefined;
    if (live && program === live.atem_input) return { input: program, node: "live" as const, studio: name(live.studio_id), source: live.name };
    if (program === ch.playout_input) return { input: program, node: "playout" as const, studio: name(ch.studio_id), source: null };
    if (program === ch.fallback_input) return { input: program, node: "fallback" as const, studio: null, source: null };
    return { input: program, node: "other" as const, studio: null, source: null };
  }

  // ---- control API -----------------------------------------------------------------

  status(ch: ChannelRow) {
    const s = this.state(ch.id);
    const now = this.now();
    const { current, upcoming } = at(s.events, now);
    const ev = (e: TimelineEvent) => ({ key: e.key, type: e.type, title: e.title, programTitle: e.programTitle, startAt: new Date(e.start).toISOString(), endAt: new Date(e.end).toISOString(), blockKind: e.leaf?.blockKind ?? null, warning: e.leaf?.warning ?? null });
    const sw = this.hub.switcher(ch.atem_id);
    const p = this.playout(ch);
    return {
      channel: channelOut(ch),
      automation: !!ch.automation,
      override: s.override,
      current: current ? ev(current) : null,
      upcoming: upcoming.slice(0, 8).map(ev),
      program: this.programNow(s, now, ev),
      atem: sw ? sw.info() : null,
      playout: p ? p.info() : null,
      onAir: this.onAir(ch, s, sw?.info().program[ch.atem_me]),
      atemLock: this.hub.lock(ch.atem_id),
      pending: this.pending(ch.id),
      standby: s.standby ? { liveSourceId: s.standby.liveSourceId, name: s.standby.name, since: s.standby.since } : null,
      audio: this.audioStatus(s, current),
      lastError: s.lastError,
      graphics: this.graphicsData(ch, current, upcoming, now),
      asrun: this.platform.ctx.db.prepare("SELECT at, kind, title, detail, ok FROM asrun WHERE channel_id = ? ORDER BY id DESC LIMIT 12").all(ch.id),
    };
  }

  /** The hour block on air: its items, which one plays now, and the next programme after it. */
  private programNow<T>(s: ChannelState, now: number, ev: (e: TimelineEvent) => T) {
    const p = programAt(s.events, now, (id) => s.entries.get(id));
    if (!p) return null;
    const next = s.events.find((e) => e.start >= p.end && e.scheduleId != null && !e.fill && e.offsetMs === 0);
    return {
      title: p.title,
      startAt: new Date(p.start).toISOString(),
      endAt: new Date(p.end).toISOString(),
      index: p.index,
      items: p.items.map(ev),
      next: next ? { title: next.programTitle || next.title, startAt: new Date(next.start).toISOString() } : null,
    };
  }

  /** Called when a live source taken by hand goes off air again (back to the schedule, or another source taken). */
  overrideEnded: ((channelId: number, liveSourceId: number) => void)[] = [];

  /** Live source on air by hand: it stays on air (the schedule waits) until `resume` or another source is taken. */
  async takeLive(c: ChannelRow, live: LiveRow, by: string) {
    if (this.hub.lock(c.atem_id)) throw new HttpError(409, "atem_locked");
    const s = this.state(c.id);
    const before = s.override;
    try {
      await this.takeRemote(s, live);
      await this.switchTo(c, live.atem_input);
    } catch (e) {
      throw new HttpError(502, "live_failed", (e as Error).message);
    }
    s.override = { liveSourceId: live.id, name: live.name, since: new Date(this.now()).toISOString() };
    this.asrun(c.id, "live", live.name, `Taken live by ${by}`, true);
    if (before && before.liveSourceId !== live.id) this.overrideEnded.forEach((f) => f(c.id, before.liveSourceId));
  }

  /** Back to the schedule after a live source taken by hand. */
  async resume(c: ChannelRow, by: string) {
    const s = this.state(c.id);
    const before = s.override;
    s.override = null;
    s.currentKey = null;
    s.preloadedKey = null;
    s.prerolled = null;
    s.standby = null;
    await this.stopRtmp(s);
    this.asrun(c.id, "control", "Back to schedule", by, true);
    if (before) this.overrideEnded.forEach((f) => f(c.id, before.liveSourceId));
  }

  /** Live source taken by hand on this channel, if any. */
  override(channelId: number) {
    return this.states.get(channelId)?.override ?? null;
  }

  /** What sounds under the programme now (for the control room and the dashboard). */
  private audioStatus(s: ChannelState, current: TimelineEvent | null) {
    const wantId = this.wantedAudio(s, current);
    if (wantId == null) return null;
    const src = audioSource(this.platform.ctx.db, wantId);
    if (!src) return null;
    const err = s.audioError?.sourceId === wantId ? s.audioError.message : null;
    return { sourceId: src.id, name: src.name, kind: src.kind, playing: s.audio?.sourceId === wantId, error: err };
  }

  register(app: FastifyInstance) {
    const { db } = this.platform.ctx;
    const channel = (id: number) => {
      const c = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;
      if (!c) throw new HttpError(404, "not_found");
      return c;
    };
    const pid = (req: { params: unknown }) => Number((req.params as { id: string }).id);

    app.get("/api/control", async () => ({ serverTime: new Date(this.now()).toISOString(), channels: (db.prepare("SELECT * FROM channels WHERE enabled = 1 ORDER BY id").all() as unknown as ChannelRow[]).map((c) => this.status(c)) }));

    app.post("/api/control/:id/automation", async (req) => {
      requireRole(req, "operator");
      const c = channel(pid(req));
      const { on } = z.object({ on: z.boolean() }).parse(req.body);
      db.prepare("UPDATE channels SET automation = ? WHERE id = ?").run(on ? 1 : 0, c.id);
      const s = this.state(c.id);
      s.currentKey = null; // re-cue the current item when switching back on
      s.preloadedKey = null;
      // Manual control: the audio under the programme stops too.
      if (!on && s.audio) {
        const a = s.audio;
        s.audio = null;
        await this.hub.playout(a.studioId)?.clear(a.casparChannel, AUDIO_LAYER).catch(() => undefined);
      }
      this.asrun(c.id, "control", on ? "Automation on" : "Automation off", req.user!.username, true);
      return { ok: true };
    });

    app.post("/api/control/:id/live", async (req) => {
      requireRole(req, "operator");
      const c = channel(pid(req));
      const { liveSourceId } = z.object({ liveSourceId: z.number().int() }).parse(req.body);
      const live = this.live(liveSourceId);
      if (!live) throw new HttpError(404, "not_found");
      await this.takeLive(c, live, req.user!.username);
      return { ok: true };
    });

    app.post("/api/control/:id/apply-now", async (req) => {
      requireRole(req, "editor");
      const c = channel(pid(req));
      this.applyNow(c.id);
      this.asrun(c.id, "control", "Schedule change applied now", req.user!.username, true);
      return { ok: true };
    });

    app.post("/api/control/:id/resume", async (req) => {
      requireRole(req, "operator");
      await this.resume(channel(pid(req)), req.user!.username);
      return { ok: true };
    });

    app.post("/api/control/:id/atem", async (req) => {
      requireRole(req, "operator");
      const c = channel(pid(req));
      const b = z.object({ action: z.enum(["program", "preview", "cut", "auto"]), input: z.number().int().optional() }).parse(req.body);
      const sw = this.hub.switcher(c.atem_id);
      if (!sw) throw new HttpError(400, "no_atem");
      if (sw.locked()) throw new HttpError(409, "atem_locked");
      try {
        if (b.action === "program" && b.input != null) await sw.program(b.input, c.atem_me, "cut");
        else if (b.action === "preview" && b.input != null) await sw.preview(b.input, c.atem_me);
        else if (b.action === "cut") await sw.cut(c.atem_me);
        else if (b.action === "auto") await sw.auto(c.atem_me);
      } catch (e) {
        throw new HttpError(502, "atem_failed", (e as Error).message);
      }
      return { ok: true };
    });

    app.get("/api/asrun", async (req) => {
      const q = z.object({ channel: z.coerce.number().int(), from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).parse(req.query);
      return { items: db.prepare("SELECT at, kind, title, detail, ok FROM asrun WHERE channel_id = ? AND at >= ? AND at < ? ORDER BY id").all(q.channel, q.from, q.to) };
    });
  }
}

export function publicUrl(platform: Platform) {
  const configured = platform.ctx.settings.get<string>("management.publicUrl", "");
  if (configured) return configured.replace(/\/+$/, "");
  const ip = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  return `http://${ip ?? "127.0.0.1"}:${platform.ctx.config.port}`;
}

/** Page CasparCG plays for a "coming up" slide: `at` is the slide's start, the list shows what starts after it. */
export const lineupUrl = (platform: Platform, channelId: number, at: number) => `${publicUrl(platform)}/lineup/page.html?channel=${channelId}&at=${Math.round(at)}`;

/** Page CasparCG plays for an info page, in the house style (colours, logo) of the channel it is on. */
export const infoPageUrl = (platform: Platform, id: number, channelId: number) => `${publicUrl(platform)}/infopage/page.html?id=${id}&channel=${channelId}`;

/** Page CasparCG plays for a beeldkrant: `start` is the wall-clock time of its first page, so a restart shows the right page. */
export const beeldkrantUrl = (platform: Platform, id: number, start: number, tickerSpace = 0) =>
  `${publicUrl(platform)}/beeldkrant/page.html?id=${id}&start=${Math.round(start)}${tickerSpace > 0 ? `&ticker=${tickerSpace}` : ""}`;

const sameOutput = (a: Output, b: Output) => a.studioId === b.studioId && a.casparChannel === b.casparChannel;
