/**
 * Device drivers. The director talks to these interfaces only, so tests can swap in fakes.
 * - SwitcherDriver: Blackmagic ATEM (any model) via atem-connection; model, inputs and M/E count are read from the device.
 * - PlayoutDriver:  CasparCG server on a studio node (AMCP over TCP 5250) via casparcg-connection.
 */
import { Atem, Enums } from "atem-connection";
import { CasparCG } from "casparcg-connection";
import { EventEmitter } from "node:events";

export interface SwitcherInput {
  id: number;
  longName: string;
  shortName: string;
  external: boolean;
}
export interface SwitcherInfo {
  connected: boolean;
  model: string | null;
  productName: string | null;
  mixEffects: number;
  inputs: SwitcherInput[];
  program: (number | null)[];
  preview: (number | null)[];
}
export interface SwitcherDriver extends EventEmitter {
  info(): SwitcherInfo;
  /** Put `input` on program; "mix" goes via preview + auto transition. */
  program(input: number, me: number, transition: "cut" | "mix"): Promise<void>;
  preview(input: number, me: number): Promise<void>;
  cut(me: number): Promise<void>;
  auto(me: number): Promise<void>;
  close(): Promise<void>;
}

export interface PlayOptions {
  loop?: boolean;
  /** Frames to skip into the clip. */
  seek?: number;
}
export interface PlayoutInfo {
  connected: boolean;
  version: string | null;
  /** CasparCG channel numbers (= DeckLink outputs), when known. */
  channels?: number[] | null;
  /** Goes up every time the connection to CasparCG is (re)made, e.g. after a CasparCG restart. */
  session?: number;
}
export interface PlayoutDriver extends EventEmitter {
  info(): PlayoutInfo;
  /** Plays a clip or URL; without clip, plays what LOADBG prepared. */
  play(channel: number, layer: number, clip?: string, opts?: PlayOptions): Promise<void>;
  loadbg(channel: number, layer: number, clip: string, opts?: PlayOptions): Promise<void>;
  stop(channel: number, layer: number): Promise<void>;
  /** Plays a web page (CasparCG HTML producer). */
  playHtml(channel: number, layer: number, url: string): Promise<void>;
  clear(channel: number, layer?: number): Promise<void>;
  cgAdd(channel: number, layer: number, template: string, data: unknown): Promise<void>;
  cgUpdate(channel: number, layer: number, data: unknown): Promise<void>;
  cgStop(channel: number, layer: number): Promise<void>;
  /** Audio level of a layer, 0 = muted, 1 = normal (Visual Radio plays clips without sound). Optional: fakes may leave it out. */
  volume?(channel: number, layer: number, volume: number): Promise<void>;
  close(): Promise<void>;
}

// ---- ATEM ------------------------------------------------------------------

const modelName = (m: number | undefined) => (m == null ? null : ((Enums.Model as unknown as Record<number, string>)[m] ?? `Model ${m}`));

export class AtemSwitcher extends EventEmitter implements SwitcherDriver {
  private atem = new Atem({ disableMultithreaded: true });
  private connected = false;
  constructor(host: string) {
    super();
    this.atem.on("connected", () => {
      this.connected = true;
      this.emit("change");
    });
    this.atem.on("disconnected", () => {
      this.connected = false;
      this.emit("change");
    });
    this.atem.on("stateChanged", () => this.emit("change"));
    this.atem.on("error", (e) => this.emit("log", e));
    void this.atem.connect(host).catch((e) => this.emit("log", String(e)));
  }
  info(): SwitcherInfo {
    const s = this.atem.state;
    const mes = s?.info.capabilities?.mixEffects ?? s?.video.mixEffects.length ?? 1;
    const inputs = Object.values(s?.inputs ?? {})
      .filter((i) => !!i)
      .filter((i) =>
        [Enums.InternalPortType.External, Enums.InternalPortType.Black, Enums.InternalPortType.ColorBars, Enums.InternalPortType.ColorGenerator, Enums.InternalPortType.MediaPlayerFill, Enums.InternalPortType.SuperSource].includes(
          i!.internalPortType,
        ),
      )
      .map((i) => ({ id: i!.inputId, longName: i!.longName, shortName: i!.shortName, external: i!.internalPortType === Enums.InternalPortType.External }))
      .sort((a, b) => a.id - b.id);
    return {
      connected: this.connected,
      model: modelName(s?.info.model),
      productName: s?.info.productIdentifier ?? null,
      mixEffects: mes,
      inputs,
      program: Array.from({ length: mes }, (_, i) => s?.video.mixEffects[i]?.programInput ?? null),
      preview: Array.from({ length: mes }, (_, i) => s?.video.mixEffects[i]?.previewInput ?? null),
    };
  }
  private need() {
    if (!this.connected) throw new Error("ATEM not connected");
  }
  async program(input: number, me: number, transition: "cut" | "mix") {
    this.need();
    if (transition === "mix") {
      await this.atem.changePreviewInput(input, me);
      await this.atem.autoTransition(me);
    } else await this.atem.changeProgramInput(input, me);
  }
  async preview(input: number, me: number) {
    this.need();
    await this.atem.changePreviewInput(input, me);
  }
  async cut(me: number) {
    this.need();
    await this.atem.cut(me);
  }
  async auto(me: number) {
    this.need();
    await this.atem.autoTransition(me);
  }
  async close() {
    this.atem.removeAllListeners();
    await this.atem.destroy().catch(() => undefined);
  }
}

// ---- CasparCG ----------------------------------------------------------------

type Sent = { error: Error | undefined; request: Promise<{ responseCode: number; message: string; data: unknown }> | undefined };

export class CasparPlayout extends EventEmitter implements PlayoutDriver {
  private c: CasparCG;
  private version: string | null = null;
  private channels: number[] | null = null;
  private session = 0;
  constructor(host: string, port: number) {
    super();
    this.c = new CasparCG({ host, port, autoConnect: true, reconnectTime: 3000 });
    this.c.on("connect", () => {
      this.session++;
      this.emit("change");
      void this.c
        .version()
        .then((r) => (r as unknown as Sent).request)
        .then((res) => {
          const d = res?.data as { fullVersion?: string } | string | undefined;
          this.version = typeof d === "string" ? d : (d?.fullVersion ?? null);
          this.emit("change");
        })
        .catch(() => undefined);
      void this.c
        .info({})
        .then((r) => (r as unknown as Sent).request)
        .then((res) => {
          const d = res?.data as { channel: number }[] | undefined;
          if (Array.isArray(d)) this.channels = d.map((e) => e.channel).filter((n) => Number.isInteger(n));
          this.emit("change");
        })
        .catch(() => undefined);
    });
    this.c.on("disconnect", () => this.emit("change"));
    this.c.on("error", (e) => this.emit("log", e.message));
  }
  info(): PlayoutInfo {
    return { connected: this.c.connected, version: this.c.connected ? this.version : null, channels: this.c.connected ? this.channels : null, session: this.session };
  }
  private async send(p: Promise<unknown>) {
    if (!this.c.connected) throw new Error("CasparCG not connected");
    const r = (await p) as Sent;
    if (r.error) throw r.error;
    const res = await r.request!;
    if (res.responseCode >= 400) throw new Error(`CasparCG ${res.responseCode} ${res.message ?? ""}`.trim());
  }
  play(channel: number, layer: number, clip?: string, opts: PlayOptions = {}) {
    return this.send(this.c.play({ channel, layer, clip, loop: opts.loop, seek: opts.seek || undefined }));
  }
  loadbg(channel: number, layer: number, clip: string, opts: PlayOptions = {}) {
    return this.send(this.c.loadbg({ channel, layer, clip, loop: opts.loop, seek: opts.seek || undefined }));
  }
  stop(channel: number, layer: number) {
    return this.send(this.c.stop({ channel, layer }));
  }
  playHtml(channel: number, layer: number, url: string) {
    return this.send(this.c.playHtml({ channel, layer, url }));
  }
  clear(channel: number, layer?: number) {
    return this.send(this.c.clear({ channel, layer }));
  }
  cgAdd(channel: number, layer: number, template: string, data: unknown) {
    return this.send(this.c.cgAdd({ channel, layer, cgLayer: 1, template, playOnLoad: true, data: JSON.stringify(data) }));
  }
  cgUpdate(channel: number, layer: number, data: unknown) {
    return this.send(this.c.cgUpdate({ channel, layer, cgLayer: 1, data: JSON.stringify(data) }));
  }
  cgStop(channel: number, layer: number) {
    return this.send(this.c.cgStop({ channel, layer, cgLayer: 1 }));
  }
  volume(channel: number, layer: number, volume: number) {
    return this.send(this.c.mixerVolume({ channel, layer, value: volume }));
  }
  async close() {
    this.c.removeAllListeners();
    this.c.disconnect();
  }
}

export interface DriverFactory {
  switcher(host: string): SwitcherDriver;
  playout(host: string, port: number): PlayoutDriver;
}
export const realDrivers: DriverFactory = {
  switcher: (host) => new AtemSwitcher(host),
  playout: (host, port) => new CasparPlayout(host, port),
};
