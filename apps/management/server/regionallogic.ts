/**
 * Regional information for the beeldkrant (pure, tested): traffic (NDW open data, DATEX II v3), events (iCal / RSS /
 * a list kept by the editors), municipal council meetings (iBabs, Notubiz, iCal) and P2000 alerts. Every source turns
 * into ordinary feed items (`rss_items`), so beeldkranten and the ticker use them like any other feed.
 *
 * Items can carry a `rank` (fixed order instead of newest first: jams before roadworks, the next meeting first), a
 * `hold` ('pending' = waits for an editor) and a `showFrom` (delay). P2000 items never show addresses, capcodes or
 * medical details: the public text is built from the kind of call and the place only.
 */
import { z } from "zod";
import { decodeEntities, htmlToText, type FeedItem } from "./rsslogic.js";
import { VILD_POINTS } from "./vildpoints.js";

export const REGIONAL_SOURCES = ["traffic", "events", "council", "p2000"] as const;
export type RegionalSource = (typeof REGIONAL_SOURCES)[number];

export interface RegionalItem extends FeedItem {
  /** Fixed order (low first); items without a rank are sorted by date. */
  rank: number | null;
  /** 'pending' = an editor must approve the item first. */
  hold: "pending" | null;
  /** Not on air before this time (delay). */
  showFrom: string | null;
  /** Context for the editors only (never on air), e.g. the original P2000 text. */
  note: string | null;
}

const lang = z.enum(["nl", "en"]).default("nl");
const tz = z.string().max(60).default("Europe/Amsterdam");

// ---- settings -----------------------------------------------------------------------------------

export const NDW_CURRENT_URL = "https://opendata.ndw.nu/actueel_beeld.xml.gz";
export const NDW_PLANNED_URL = "https://opendata.ndw.nu/planningsfeed_wegwerkzaamheden_en_evenementen.xml.gz";
export const DEFAULT_ROADS = ["A9", "A22", "A208", "N197", "N202", "N208", "N246"];
export const DEFAULT_MUNICIPALITIES = ["Velsen", "Beverwijk", "Heemskerk"];
/** Places in the three municipalities (P2000 and roadworks name the place, not the municipality). */
export const DEFAULT_PLACES = ["IJmuiden", "Velsen", "Velsen-Noord", "Velsen-Zuid", "Driehuis", "Santpoort-Noord", "Santpoort-Zuid", "Velserbroek", "Spaarndam", "Beverwijk", "Wijk aan Zee", "Heemskerk"];

export const trafficSchema = z.object({
  roads: z.array(z.string().trim().toUpperCase().max(10)).max(30).default(DEFAULT_ROADS),
  municipalities: z.array(z.string().trim().max(60)).max(10).default(DEFAULT_MUNICIPALITIES),
  jams: z.boolean().default(true),
  /** Accidents, broken-down vehicles and obstacles. */
  incidents: z.boolean().default(true),
  /** Closed roads and tunnels right now (not roadworks). */
  closures: z.boolean().default(true),
  roadworks: z.boolean().default(true),
  /** Planned roadworks starting within this many days (works already busy are always shown). */
  roadworksDaysAhead: z.number().int().min(0).max(60).default(7),
  /** Also works that hardly hinder traffic (speed limit, cyclists only, a crane on the pavement). */
  minorWorks: z.boolean().default(false),
  /** Works that last longer than this many days are left out (0 = keep all): months-long closures are no news. */
  maxWorkDays: z.number().int().min(0).max(3650).default(90),
  /** Road closures for events (fair, cycle race) from the municipalities. */
  eventClosures: z.boolean().default(true),
  /** Jams shorter than this are left out. */
  minJamKm: z.number().min(0).max(50).default(1),
  currentUrl: z.url().max(500).default(NDW_CURRENT_URL),
  plannedUrl: z.url().max(500).default(NDW_PLANNED_URL),
  language: lang,
  timeZone: tz,
});
export type TrafficSettings = z.infer<typeof trafficSchema>;

const manualEvent = z.object({
  id: z.string().max(40),
  title: z.string().trim().min(1).max(200),
  /** yyyy-mm-dd */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** hh:mm, empty = all day */
  time: z.string().regex(/^(\d{2}:\d{2})?$/).default(""),
  /** Last day (yyyy-mm-dd), empty = one day. */
  endDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).default(""),
  place: z.string().trim().max(200).default(""),
  text: z.string().trim().max(1000).default(""),
});
export type ManualEvent = z.infer<typeof manualEvent>;
export const eventsSchema = z.object({
  /** An iCal (.ics) or RSS feed with events; empty = only the list below. */
  feedUrl: z.union([z.literal(""), z.url().max(1000)]).default(""),
  manual: z.array(manualEvent).max(300).default([]),
  /** Events starting within this many days. */
  daysAhead: z.number().int().min(1).max(120).default(14),
  language: lang,
  timeZone: tz,
});
export type EventsSettings = z.infer<typeof eventsSchema>;

const municipality = z.object({
  name: z.string().trim().min(1).max(60),
  system: z.enum(["ibabs", "notubiz", "ical"]),
  /** iBabs: the portal (https://beverwijk.bestuurlijkeinformatie.nl). Notubiz: the portal (only shown). iCal: the .ics. */
  url: z.union([z.literal(""), z.url().max(500)]).default(""),
  /** Notubiz organisation id; empty = looked up by name. */
  organisationId: z.number().int().positive().nullable().default(null),
  enabled: z.boolean().default(true),
});
export type Municipality = z.infer<typeof municipality>;
export const DEFAULT_COUNCILS: Municipality[] = [
  { name: "Velsen", system: "notubiz", url: "https://velsen.raadsinformatie.nl", organisationId: null, enabled: true },
  { name: "Beverwijk", system: "ibabs", url: "https://beverwijk.bestuurlijkeinformatie.nl", organisationId: null, enabled: true },
  { name: "Heemskerk", system: "notubiz", url: "https://heemskerk.raadsinformatie.nl", organisationId: null, enabled: true },
];
export const councilSchema = z.object({
  municipalities: z.array(municipality).max(10).default(DEFAULT_COUNCILS),
  daysAhead: z.number().int().min(1).max(60).default(14),
  /** Cancelled meetings stay on screen with "gaat niet door". */
  showCancelled: z.boolean().default(true),
  language: lang,
  timeZone: tz,
});
export type CouncilSettings = z.infer<typeof councilSchema>;

export const P2000_URL = "https://alarmeringen.nl/feeds/region/kennemerland.rss";
export const p2000Schema = z.object({
  feedUrl: z.url().max(500).default(P2000_URL),
  places: z.array(z.string().trim().max(60)).max(40).default(DEFAULT_PLACES),
  services: z
    .object({ fire: z.boolean().default(true), ambulance: z.boolean().default(false), police: z.boolean().default(false), rescue: z.boolean().default(true), helicopter: z.boolean().default(false) })
    .default({ fire: true, ambulance: false, police: false, rescue: true, helicopter: false }),
  /** Automatic fire alarms (mostly false alarms) are left out. */
  skipAutomaticAlarms: z.boolean().default(true),
  /** Only urgent calls (priority 1 / A1). */
  urgentOnly: z.boolean().default(false),
  /** Minutes before an alert may go on air. */
  delayMinutes: z.number().int().min(0).max(24 * 60).default(20),
  /** An editor approves every alert before it goes on air. */
  requireApproval: z.boolean().default(true),
  /** Show the street name. Off by default: never addresses on air. */
  showStreet: z.boolean().default(false),
  /** Alerts older than this disappear. */
  maxAgeHours: z.number().int().min(1).max(72).default(6),
  language: lang,
  timeZone: tz,
});
export type P2000Settings = z.infer<typeof p2000Schema>;

export const regionalSchemas = { traffic: trafficSchema, events: eventsSchema, council: councilSchema, p2000: p2000Schema } as const;
export const parseRegional = (source: RegionalSource, config: unknown) => regionalSchemas[source].parse(config ?? {});

// ---- shared helpers ------------------------------------------------------------------------------

const T = {
  nl: {
    jam: "File",
    accident: "Ongeval",
    breakdown: "Pechgeval",
    obstruction: "Obstakel",
    closure: "Afsluiting",
    roadworks: "Wegwerkzaamheden",
    eventClosure: "Evenement",
    on: "op de",
    at: "bij",
    between: "tussen",
    and: "en",
    delay: (m: number) => `Ongeveer ${m} minuten vertraging.`,
    length: (km: string) => `${km} km`,
    slow: "Langzaam rijdend verkeer.",
    standing: "Stilstaand verkeer.",
    careful: "Houd rekening met vertraging.",
    closed: "Weg afgesloten.",
    followSigns: "Volg de omleidingsborden.",
    until: "t/m",
    from: "vanaf",
    allDay: "hele dag",
    cancelled: "Gaat niet door.",
    meetingAt: "om",
    service: { fire: "Brandweer", ambulance: "Ambulance", police: "Politie", rescue: "Hulpdiensten op het water", helicopter: "Traumahelikopter" },
    deployed: (s: string, place: string) => `${s} in ${place}`,
    call: (s: string) => `${s} is uitgerukt.`,
    callAt: (time: string) => `Melding om ${time}.`,
    accidentIn: (p: string) => `Ongeval in ${p}`,
    council: (m: string) => `Gemeente ${m}`,
    impacts: {
      both: "Weg dicht in beide richtingen.",
      one: "Weg dicht in één richting.",
      lanes: "Minder rijstroken beschikbaar.",
      speed: "Snelheidsbeperking.",
      slowTraffic: "Beperking voor fietsers en voetgangers.",
    },
    locale: "nl-NL",
  },
  en: {
    jam: "Traffic jam",
    accident: "Accident",
    breakdown: "Broken-down vehicle",
    obstruction: "Obstacle",
    closure: "Closure",
    roadworks: "Roadworks",
    eventClosure: "Event",
    on: "on the",
    at: "near",
    between: "between",
    and: "and",
    delay: (m: number) => `About ${m} minutes delay.`,
    length: (km: string) => `${km} km`,
    slow: "Slow traffic.",
    standing: "Stationary traffic.",
    careful: "Expect delays.",
    closed: "Road closed.",
    followSigns: "Follow the diversion signs.",
    until: "to",
    from: "from",
    allDay: "all day",
    cancelled: "Cancelled.",
    meetingAt: "at",
    service: { fire: "Fire brigade", ambulance: "Ambulance", police: "Police", rescue: "Water rescue", helicopter: "Trauma helicopter" },
    deployed: (s: string, place: string) => `${s} in ${place}`,
    call: (s: string) => `${s} has been called out.`,
    callAt: (time: string) => `Alert at ${time}.`,
    accidentIn: (p: string) => `Accident in ${p}`,
    council: (m: string) => `Municipality of ${m}`,
    impacts: {
      both: "Road closed in both directions.",
      one: "Road closed in one direction.",
      lanes: "Fewer lanes available.",
      speed: "Speed limit.",
      slowTraffic: "Restrictions for cyclists and pedestrians.",
    },
    locale: "en-GB",
  },
};
type Tx = (typeof T)["nl"];

const fmt = (tx: Tx, timeZone: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(tx.locale, { timeZone, ...o });
const timeOf = (tx: Tx, timeZone: string, t: number) => fmt(tx, timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
const dayOf = (tx: Tx, timeZone: string, t: number) => fmt(tx, timeZone, { weekday: "short", day: "numeric", month: "long" }).format(t);
const dateKey = (timeZone: string, t: number) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);

/** "do 12 november 07:00 – 17:00", "9 t/m 20 november", "vanaf 3 november". */
export function period(start: number, end: number | null, language: "nl" | "en", timeZone: string, withTime = true): string {
  const tx = T[language];
  if (end == null || !Number.isFinite(end)) return `${tx.from} ${dayOf(tx, timeZone, start)}`;
  if (dateKey(timeZone, start) === dateKey(timeZone, end)) return withTime ? `${dayOf(tx, timeZone, start)} ${timeOf(tx, timeZone, start)} – ${timeOf(tx, timeZone, end)}` : dayOf(tx, timeZone, start);
  const long = end - start > 2 * 86400_000;
  if (long || !withTime) return `${dayOf(tx, timeZone, start)} ${tx.until} ${dayOf(tx, timeZone, end)}`;
  return `${dayOf(tx, timeZone, start)} ${timeOf(tx, timeZone, start)} ${tx.until} ${dayOf(tx, timeZone, end)} ${timeOf(tx, timeZone, end)}`;
}

/** UTC time of a local wall-clock time in `timeZone`. */
export function zonedTime(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t;
  };
  const o1 = off(guess);
  let t = guess - o1;
  const o2 = off(t);
  if (o2 !== o1) t = guess - o2;
  return t;
}

const iso = (t: number | null) => (t == null || !Number.isFinite(t) ? null : new Date(t).toISOString());
const base = (guid: string, title: string, summary: string, category: string, extra: Partial<RegionalItem> = {}): RegionalItem => ({
  guid,
  title,
  summary,
  body: summary,
  link: null,
  imageUrl: null,
  author: null,
  categories: category ? [category] : [],
  publishedAt: null,
  rank: null,
  hold: null,
  showFrom: null,
  note: null,
  ...extra,
});
const sentence = (s: string) => {
  const x = s.trim().replace(/\s+/g, " ");
  return !x ? "" : /[.!?]$/.test(x) ? x : `${x}.`;
};
const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" ");

// ---- traffic (NDW DATEX II v3) -------------------------------------------------------------------

export interface DatexRecord {
  id: string;
  type: string;
  source: string;
  start: number | null;
  end: number | null;
  /** AlertC location codes (primary, secondary, …). */
  locations: number[];
  points: [number, number][];
  cause: string | null;
  causeText: string | null;
  comments: { type: string; text: string }[];
  /** abnormalTrafficType, vehicleObstructionType, roadOrCarriagewayOrLaneManagementType, roadMaintenanceType, … */
  subtype: string | null;
  queueLength: number | null;
  delaySeconds: number | null;
}
export interface DatexSituation {
  id: string;
  records: DatexRecord[];
}

const one = (s: string, re: RegExp) => re.exec(s)?.[1] ?? null;
const all = (s: string, re: RegExp) => [...s.matchAll(re)].map((m) => m[1]!);
const xmlText = (s: string | null) => (s == null ? null : decodeEntities(s).trim());

/** Parses one `<sit:situation>…</sit:situation>` element (namespace prefixes as NDW writes them). */
export function parseSituation(xml: string): DatexSituation | null {
  const id = one(xml, /<sit:situation id="([^"]+)"/);
  if (!id) return null;
  const records = xml.split(/<sit:situationRecord\b/).slice(1).map((r): DatexRecord => {
    const points: [number, number][] = [];
    for (const m of r.matchAll(/<loc:latitude>([\d.]+)<\/loc:latitude>\s*<loc:longitude>([\d.]+)</g)) points.push([+m[1]!, +m[2]!]);
    for (const list of all(r, /<loc:posList>([^<]+)</g)) {
      const v = list.trim().split(/\s+/).map(Number);
      // First, middle and last point are enough to place a road stretch.
      for (const i of [0, Math.floor(v.length / 4) * 2, v.length - 2]) if (v[i] != null && v[i + 1] != null) points.push([v[i]!, v[i + 1]!]);
    }
    const commentBlocks = all(r, /<sit:generalPublicComment>([\s\S]*?)<\/sit:generalPublicComment>/g);
    const st = one(r, /<com:overallStartTime>([^<]+)</);
    const en = one(r, /<com:overallEndTime>([^<]+)</);
    return {
      id: one(r, /^[^>]*\bid="([^"]+)"/) ?? "",
      type: one(r, /^[^>]*xsi:type="sit:(\w+)"/) ?? "",
      source: xmlText(one(r, /<sit:source>[\s\S]*?<com:value(?: [^>]*)?>([^<]*)</)) ?? "",
      start: st ? Date.parse(st) : null,
      end: en ? Date.parse(en) : null,
      locations: all(r, /<loc:specificLocation>(\d+)</g).map(Number),
      points,
      cause: one(r, /<sit:causeType>([^<]+)</),
      causeText: xmlText(one(r, /<sit:causeDescription>[\s\S]*?<com:value(?: [^>]*)?>([^<]*)</)),
      comments: commentBlocks.map((c) => ({ type: one(c, /<sit:commentType>([^<]+)</) ?? "", text: xmlText(one(c, /<com:value(?: [^>]*)?>([^<]*)</)) ?? "" })).filter((c) => c.text),
      subtype: one(r, /<sit:(?:abnormalTrafficType|vehicleObstructionType|obstructionType|roadOrCarriagewayOrLaneManagementType|roadMaintenanceType|publicEventType|constructionWorkType)>([^<]+)</),
      queueLength: Number(one(r, /<sit:queueLength>([\d.]+)</)) || null,
      delaySeconds: Number(one(r, /<sit:delayTimeValue>([\d.]+)</)) || null,
    };
  });
  return { id, records };
}

/** The IJmond, roughly: from Spaarndam to Heemskerk and from the beach to the A9. */
export const IJMOND_AREA = { minLat: 52.42, maxLat: 52.512, minLon: 4.54, maxLon: 4.73 };
const inArea = ([lat, lon]: [number, number]) => lat >= IJMOND_AREA.minLat && lat <= IJMOND_AREA.maxLat && lon >= IJMOND_AREA.minLon && lon <= IJMOND_AREA.maxLon;

/** Quick text test before a situation is parsed (the planning feed is 200 MB): in the area, a known location or a municipality. */
export function situationMayMatter(xml: string, municipalities: string[]): boolean {
  for (const m of municipalities) if (xml.includes(`>Gemeente ${m}<`)) return true;
  for (const c of xml.matchAll(/<loc:specificLocation>(\d+)</g)) if (VILD_POINTS[Number(c[1])]) return true;
  return /52\.(4[2-9]|5[0-3])\d*(<\/loc:latitude>\s*<loc:longitude>|\s)4\.(5[4-9]|6\d|7[0-3])/.test(xml);
}

const dist2 = (a: [number, number], b: [number, number]) => {
  const dy = (a[0] - b[0]) * 111;
  const dx = (a[1] - b[1]) * 68;
  return dx * dx + dy * dy;
};
/** Road and place names of a record: AlertC codes first, else the nearest known point (within 1.5 km). */
export function placeOnRoad(r: Pick<DatexRecord, "locations" | "points">, roads: string[]): { road: string; names: string[] } | null {
  const wanted = new Set(roads.map((x) => x.toUpperCase()));
  const hits = r.locations.map((l) => VILD_POINTS[l]).filter((p): p is NonNullable<typeof p> => !!p && wanted.has(p[2]));
  // A stretch that touches the IJmond (A9 from Haarlem to Velsen counts, Haarlem alone does not).
  if (hits.length && hits.some((h) => inArea([h[0], h[1]]))) {
    const road = hits[0]![2];
    return { road, names: [...new Set(hits.filter((h) => h[2] === road).map((h) => h[3]).filter(Boolean))] };
  }
  if (r.locations.some((l) => VILD_POINTS[l])) return null; // known codes, other roads or outside the area
  const pts = r.points.filter(inArea);
  if (!pts.length) return null;
  let best: { d: number; p: (typeof VILD_POINTS)[number] } | null = null;
  for (const p of Object.values(VILD_POINTS)) {
    if (!wanted.has(p[2]) || !p[3]) continue;
    for (const pt of pts) {
      const d = dist2(pt, [p[0], p[1]]);
      if (!best || d < best.d) best = { d, p };
    }
  }
  return best && best.d <= 1.5 * 1.5 ? { road: best.p[2], names: [best.p[3]] } : null;
}

const where = (tx: Tx, names: string[]) => (names.length >= 2 ? `${tx.between} ${names[0]} ${tx.and} ${names[names.length - 1]}` : names.length ? `${tx.at} ${names[0]}` : "");

const IMPACT: [RegExp, keyof Tx["impacts"], boolean][] = [
  [/weg dicht in beide richtingen/i, "both", true],
  [/weg dicht in (een|één) richting/i, "one", true],
  [/verminderd aantal rijstroken/i, "lanes", true],
  [/snelheidsbeperking/i, "speed", false],
  [/beperking voor langzaam verkeer/i, "slowTraffic", false],
];
const impactOf = (r: DatexRecord) => {
  for (const c of r.comments) for (const [re, key, major] of IMPACT) if (re.test(c.text)) return { key, major };
  return null;
};
const NO_EFFECT = /geen gevolgen voor (het )?verkeer/i;
const TESTY = /^(test|volg route.*|omleiding \d*|.*\bntb)$/i;

/** "J.C. van Neckstraat IJmuiden Kabels / Leidingen 740786 (631430)" -> street + place, without house numbers or codes. */
export function municipalPlace(r: DatexRecord, places: string[]): { street: string; place: string } | null {
  const category = (r.causeText ?? "").split(",")[0]!.trim();
  const note = r.comments.find((c) => c.type === "internalNote")?.text ?? "";
  let loc = category && note.includes(category) ? note.slice(0, note.indexOf(category)) : "";
  if (!loc) {
    const other = r.comments.find((c) => c.type === "other" && !NO_EFFECT.test(c.text) && !IMPACT.some(([re]) => re.test(c.text)) && !/^gemeente /i.test(c.text));
    loc = other?.text ?? "";
  }
  loc = loc
    .replace(/\(\d+\)/g, " ")
    .replace(/\b\d{4}\s?[A-Z]{2}\b/g, " ") // postcode
    .replace(/\b\d+[a-z]?\b/gi, " ") // house numbers, permit numbers
    .replace(/\b(NH)\b/g, " ")
    .replace(/[,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!loc || loc.length > 90) return null;
  // "Wilhelmina Druckerstraat Wilhelmina Druckerstraat Velserbroek": the street twice.
  const words = loc.split(" ");
  for (let n = Math.floor(words.length / 2); n >= 1; n--) if (words.slice(0, n).join(" ") === words.slice(n, 2 * n).join(" ")) words.splice(n, n);
  loc = words.join(" ");
  const place = [...places].sort((a, b) => b.length - a.length).find((p) => new RegExp(`(^|\\s)${p.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}$`, "i").test(loc));
  if (!place) return { street: loc, place: "" };
  return { street: loc.slice(0, loc.length - place.length).trim(), place };
}

/** "Herinrichting / onderhoud van, Kruising, Aanleg rotonde" -> "Aanleg rotonde"; "Overig, , Afsluiting" -> "Afsluiting". */
export const causeShort = (t: string | null) => {
  const parts = (t ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  return /^(overig|other)$/i.test(last) ? "" : last;
};
const kmText = (m: number, language: "nl" | "en") => (m / 1000).toLocaleString(language === "nl" ? "nl-NL" : "en-GB", { maximumFractionDigits: 1 });
const isWorks = (r: DatexRecord) => ["MaintenanceWorks", "ConstructionWorks", "RoadworksManagement"].includes(r.type) || r.cause === "roadMaintenance" || r.cause === "constructionWork";

/**
 * Items for the traffic source from the current situation and the planning feed. One item per situation; jams first
 * (longest first), then accidents and other incidents, closures, and roadworks (busy now first, then by start).
 */
export function trafficItems(current: DatexSituation[], planned: DatexSituation[], s: TrafficSettings, now: number): RegionalItem[] {
  const tx = T[s.language];
  const out: { item: RegionalItem; group: number; order: number }[] = [];
  const titles = new Set<string>();
  const add = (item: RegionalItem, group: number, order: number) => {
    const key = `${item.title}|${item.summary}`.toLowerCase();
    if (titles.has(key)) return;
    titles.add(key);
    out.push({ item, group, order });
  };
  const muniOf = (r: DatexRecord) => s.municipalities.find((m) => r.source === `Gemeente ${m}`) ?? null;

  for (const sit of current) {
    const r = sit.records.find((x) => ["AbnormalTraffic", "Accident", "VehicleObstruction", "GeneralObstruction", "RoadOrCarriagewayOrLaneManagement"].includes(x.type));
    if (!r || (r.end != null && r.end < now)) continue;
    const onRoad = placeOnRoad(r, s.roads);
    const at = r.start ?? now;
    if (r.type === "AbnormalTraffic") {
      if (!s.jams || !onRoad || !["stationaryTraffic", "queuingTraffic", "slowTraffic", "heavyTraffic"].includes(r.subtype ?? "")) continue;
      const len = r.queueLength ?? 0;
      if (len < s.minJamKm * 1000) continue;
      const title = join(`${tx.jam} ${tx.on} ${onRoad.road}`, where(tx, onRoad.names));
      const delay = r.delaySeconds ? Math.max(1, Math.round(r.delaySeconds / 60)) : 0;
      const text = join(len ? `${tx.length(kmText(len, s.language))}.` : "", r.subtype === "stationaryTraffic" ? tx.standing : r.subtype === "slowTraffic" ? tx.slow : "", delay >= 2 ? tx.delay(delay) : "");
      add(base(`ndw:${sit.id}`, title, text, tx.jam, { publishedAt: iso(at) }), 0, -len);
    } else if (r.type === "Accident" || r.type === "VehicleObstruction" || r.type === "GeneralObstruction") {
      if (!s.incidents || !onRoad) continue;
      // Arrow trucks of road inspectors and other "vehicle" messages are not news.
      if (r.type === "VehicleObstruction" && r.subtype !== "brokenDownVehicle") continue;
      const label = r.type === "Accident" ? tx.accident : r.type === "VehicleObstruction" ? tx.breakdown : tx.obstruction;
      add(base(`ndw:${sit.id}`, join(`${label} ${tx.on} ${onRoad.road}`, where(tx, onRoad.names)), tx.careful, label, { publishedAt: iso(at) }), 1, -at);
    } else if (r.type === "RoadOrCarriagewayOrLaneManagement") {
      if (!s.closures || !onRoad || !["carriagewayClosures", "roadClosed", "lanesClosed", "laneClosures"].includes(r.subtype ?? "")) continue;
      // Roadworks come with their own text from the planning feed.
      if (isWorks(r) && s.roadworks && planned.length) continue;
      add(base(`ndw:${sit.id}`, join(`${tx.closure} ${onRoad.road}`, where(tx, onRoad.names)), join(tx.closed, r.end ? period(at, r.end, s.language, s.timeZone) + "." : ""), tx.closure, { publishedAt: iso(at) }), 2, at);
    }
  }

  const horizon = now + s.roadworksDaysAhead * 86400_000;
  for (const sit of planned) {
    const r = sit.records.find((x) => isWorks(x) || x.type === "PublicEvent" || x.cause === "publicEvent") ?? sit.records[0];
    if (!r || r.start == null) continue;
    const end = sit.records.reduce<number | null>((m, x) => (x.end != null && (m == null || x.end > m) ? x.end : m), r.end);
    if ((end != null && end < now) || r.start > horizon) continue;
    if (s.maxWorkDays > 0 && end != null && end - r.start > s.maxWorkDays * 86400_000) continue;
    const event = r.type === "PublicEvent" || r.cause === "publicEvent";
    if (event ? !s.eventClosures : !s.roadworks) continue;
    const allComments = sit.records.flatMap((x) => x.comments);
    if (allComments.some((c) => NO_EFFECT.test(c.text))) continue;
    const merged: DatexRecord = { ...r, comments: allComments, locations: sit.records.flatMap((x) => x.locations), points: sit.records.flatMap((x) => x.points) };
    const impact = impactOf(merged);
    const muni = muniOf(r);
    const when = period(r.start, end, s.language, s.timeZone);
    const busy = r.start <= now;
    const label = event ? tx.eventClosure : tx.roadworks;
    if (muni) {
      if (!impact || (!impact.major && !s.minorWorks)) continue;
      const place = municipalPlace(merged, DEFAULT_PLACES);
      if (!place) continue;
      const what = event ? (r.causeText ?? "").split(",")[0]!.trim() : "";
      const street = place.street.length > 45 ? what : place.street;
      const title = join(street, street ? `– ${place.place || muni}` : place.place || muni);
      add(base(`ndw:${sit.id}`, title, join(what ? sentence(what) : "", tx.impacts[impact.key], sentence(when)), label), 3, busy ? -1e15 + r.start : r.start);
    } else {
      const onRoad = placeOnRoad(merged, s.roads);
      if (!onRoad) continue;
      const desc = [causeShort(r.causeText), ...allComments.map((c) => c.text)].find((t) => t && !TESTY.test(t.trim()) && !/^\w{2,4}(-\w)? \[RWS|^RWS|^Provincie|^NDW/.test(t) && !IMPACT.some(([re]) => re.test(t)));
      if (!desc && !impact) continue;
      if (impact && !impact.major && !s.minorWorks) continue;
      const reroute = sit.records.some((x) => x.type === "ReroutingManagement");
      const title = join(`${label} ${onRoad.road}`, where(tx, onRoad.names));
      add(base(`ndw:${sit.id}`, title, join(desc ? sentence(desc) : "", impact ? tx.impacts[impact.key] : "", reroute ? tx.followSigns : "", sentence(when)), label), 3, busy ? -1e15 + r.start : r.start);
    }
  }
  return out
    .sort((a, b) => a.group - b.group || a.order - b.order)
    .map(({ item }, i) => ({ ...item, rank: i }));
}

// ---- iCal ---------------------------------------------------------------------------------------

export interface CalendarEvent {
  uid: string;
  title: string;
  start: number;
  end: number | null;
  allDay: boolean;
  location: string;
  description: string;
  cancelled: boolean;
  url: string | null;
}

const icalText = (v: string) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();
function icalDate(value: string, params: string, timeZone: string): { t: number; allDay: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, z] = m;
  if (h == null) return { t: zonedTime(+y!, +mo!, +d!, 0, 0, 0, timeZone), allDay: true };
  if (z) return { t: Date.UTC(+y!, +mo! - 1, +d!, +h, +mi!, +(sec ?? 0)), allDay: false };
  const tzid = /TZID=("?)([^;:"]+)\1/i.exec(params)?.[2];
  let zone = timeZone;
  if (tzid) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tzid });
      zone = tzid;
    } catch {
      /* Windows zone names ("W. Europe Standard Time"): use the station time zone. */
    }
  }
  return { t: zonedTime(+y!, +mo!, +d!, +h, +mi!, +(sec ?? 0), zone), allDay: false };
}

/** Parses the VEVENTs of an iCalendar file (recurring events: only their first date). */
export function parseIcal(text: string, timeZone = "Europe/Amsterdam"): CalendarEvent[] {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: CalendarEvent[] = [];
  let cur: Record<string, { v: string; p: string }> | null = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) cur = {};
    else if (/^END:VEVENT/i.test(line) && cur) {
      const st = cur.DTSTART && icalDate(cur.DTSTART.v, cur.DTSTART.p, timeZone);
      const en = cur.DTEND && icalDate(cur.DTEND.v, cur.DTEND.p, timeZone);
      if (st && cur.SUMMARY) {
        out.push({
          uid: cur.UID?.v ?? `${cur.SUMMARY.v}@${st.t}`,
          title: icalText(cur.SUMMARY.v),
          start: st.t,
          // DTEND of an all-day event is the day after.
          end: en ? (st.allDay ? en.t - 1 : en.t) : null,
          allDay: st.allDay,
          location: icalText(cur.LOCATION?.v ?? ""),
          description: htmlToText(icalText(cur.DESCRIPTION?.v ?? "")),
          cancelled: /CANCELLED/i.test(cur.STATUS?.v ?? ""),
          url: cur.URL?.v?.trim() || null,
        });
      }
      cur = null;
    } else if (cur) {
      const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/i.exec(line);
      if (m && !cur[m[1]!.toUpperCase()]) cur[m[1]!.toUpperCase()] = { p: m[2] ?? "", v: m[3] ?? "" };
    }
  }
  return out;
}

// ---- events -------------------------------------------------------------------------------------

const whenText = (e: Pick<CalendarEvent, "start" | "end" | "allDay">, language: "nl" | "en", timeZone: string) => {
  const tx = T[language];
  if (e.end != null && dateKey(timeZone, e.start) !== dateKey(timeZone, e.end)) return period(e.start, e.end, language, timeZone, false);
  return e.allDay ? dayOf(tx, timeZone, e.start) : `${dayOf(tx, timeZone, e.start)} ${tx.meetingAt} ${timeOf(tx, timeZone, e.start)}`;
};
export function manualToEvent(m: ManualEvent, timeZone: string): CalendarEvent {
  const [y, mo, d] = m.date.split("-").map(Number);
  const [h, mi] = m.time ? m.time.split(":").map(Number) : [0, 0];
  const start = zonedTime(y!, mo!, d!, h!, mi!, 0, timeZone);
  let end: number | null = null;
  if (m.endDate && m.endDate > m.date) {
    const [ey, em, ed] = m.endDate.split("-").map(Number);
    end = zonedTime(ey!, em!, ed!, 23, 59, 0, timeZone);
  }
  return { uid: `manual:${m.id}`, title: m.title, start, end, allDay: !m.time, location: m.place, description: m.text, cancelled: false, url: null };
}

/** Upcoming events (the editors' list and the feed), soonest first; events already busy stay until their end. */
export function eventItems(events: CalendarEvent[], s: EventsSettings, now: number): RegionalItem[] {
  const horizon = now + s.daysAhead * 86400_000;
  const dayEnd = (e: CalendarEvent) => e.end ?? (e.allDay ? e.start + 86400_000 - 1 : e.start + 3 * 3600_000);
  return events
    .filter((e) => !e.cancelled && dayEnd(e) >= now && e.start <= horizon)
    .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title))
    .map((e, i) =>
      base(`event:${e.uid}`, e.title, join(sentence([whenText(e, s.language, s.timeZone), e.location].filter(Boolean).join(" · ")), e.description.replace(/\s+/g, " ").trim()), "", { rank: i, link: e.url }),
    );
}

// ---- council meetings ---------------------------------------------------------------------------

export interface Meeting {
  id: string;
  municipality: string;
  title: string;
  start: number;
  end: number | null;
  location: string;
  cancelled: boolean;
  url: string | null;
}

const localIso = (v: string, timeZone: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(v);
  return m ? zonedTime(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0), timeZone) : NaN;
};

/** iBabs public portal: `/Calendar/GetAgendasForCalendar?start=&end=` (FullCalendar JSON, local times). */
export function ibabsMeetings(json: unknown, m: Pick<Municipality, "name" | "url">, timeZone: string): Meeting[] {
  if (!Array.isArray(json)) throw new Error("unexpected iBabs answer");
  return (json as Record<string, unknown>[])
    .map((e) => {
      const title = htmlToText(String(e.title ?? ""));
      const location = htmlToText(String(e.location ?? ""));
      const description = String(e.description ?? "");
      return {
        id: `ibabs:${m.name}:${String(e.id ?? e.start)}`,
        municipality: m.name,
        title,
        start: localIso(String(e.start ?? ""), timeZone),
        end: e.end ? localIso(String(e.end), timeZone) : null,
        location: /geannuleerd|vervalt|gaat niet door/i.test(location) ? "" : location,
        cancelled: /geannuleerd|vervalt|gaat niet door/i.test(`${title} ${location} ${description.slice(0, 200)}`),
        url: e.url && m.url ? new URL(String(e.url), m.url).toString() : null,
      };
    })
    .filter((x) => x.title && Number.isFinite(x.start));
}

/** Notubiz API `GET https://api.notubiz.nl/events?organisation_id=…&format=json` (attribute 1 = title, 50 = location). */
export function notubizMeetings(json: unknown, m: Pick<Municipality, "name" | "url">, timeZone: string): Meeting[] {
  const events = (json as { events?: unknown })?.events;
  if (!Array.isArray(events)) throw new Error("unexpected Notubiz answer");
  const attr = (e: Record<string, unknown>, id: number) => {
    const a = (Array.isArray(e.attributes) ? e.attributes : []).find((x: Record<string, unknown>) => Number(x.id) === id) as Record<string, unknown> | undefined;
    return a?.value != null ? htmlToText(String(a.value)).replace(/^'(.*)'$/, "$1") : "";
  };
  return (events as Record<string, unknown>[])
    .filter((e) => (e.permission_group ?? "public") === "public" && !Number(e.confidential) && !e.inactive)
    .map((e) => {
      const plan = (Array.isArray(e.plannings) ? e.plannings[0] : null) as Record<string, unknown> | null;
      return {
        id: `notubiz:${m.name}:${String(e.id)}`,
        municipality: m.name,
        title: attr(e, 1),
        start: localIso(String(plan?.start_date ?? ""), timeZone),
        end: plan?.end_date ? localIso(String(plan.end_date), timeZone) : null,
        location: attr(e, 50),
        cancelled: !!e.canceled,
        url: m.url ? `${m.url.replace(/\/$/, "")}/vergadering/${String(e.id)}` : null,
      };
    })
    .filter((x) => x.title && Number.isFinite(x.start));
}

/** The Notubiz organisation id of a municipality in `GET /organisations?format=json`. */
export function notubizOrganisationId(json: unknown, name: string): number | null {
  const raw = json as Record<string, unknown>;
  const list = (Array.isArray(raw) ? raw : Array.isArray(raw?.organisations) ? raw.organisations : Array.isArray((raw?.organisations as Record<string, unknown>)?.organisation) ? (raw.organisations as Record<string, unknown>).organisation : []) as Record<string, unknown>[];
  const norm = (s: string) => s.toLowerCase().replace(/^gemeente\s+/, "").trim();
  const hit = list.find((o) => norm(String(o.name ?? o.organisation_name ?? "")) === norm(name)) ?? list.find((o) => norm(String(o.name ?? "")).startsWith(norm(name)));
  return hit ? Number(hit.id) || null : null;
}

export function councilItems(meetings: Meeting[], s: CouncilSettings, now: number): RegionalItem[] {
  const tx = T[s.language];
  const horizon = now + s.daysAhead * 86400_000;
  return meetings
    .filter((m) => (m.end ?? m.start + 4 * 3600_000) >= now && m.start <= horizon && (s.showCancelled || !m.cancelled))
    .sort((a, b) => a.start - b.start || a.municipality.localeCompare(b.municipality))
    .map((m, i) => {
      const when = `${dayOf(tx, s.timeZone, m.start)} ${tx.meetingAt} ${timeOf(tx, s.timeZone, m.start)}`;
      const title = new RegExp(m.municipality, "i").test(m.title) ? m.title : `${m.title} ${m.municipality}`;
      return base(m.id, title, m.cancelled ? join(sentence(when), tx.cancelled) : sentence([when, m.location].filter(Boolean).join(" · ")), tx.council(m.municipality), { rank: i, link: m.url });
    });
}

// ---- P2000 --------------------------------------------------------------------------------------

export interface P2000Raw {
  guid: string;
  /** The raw message ("p 1 bnh-01 br woning radarstraat ijmuiden 123456"). */
  raw: string;
  /** The readable text of the site ("Buitenbrand op Linnaeusstraat in Zandvoort"). */
  description: string;
  link: string | null;
  publishedAt: string | null;
}
type Service = keyof P2000Settings["services"];

const titleCase = (s: string) => s.replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()).replace(/^Ijmuiden$/, "IJmuiden");

/** Kind of call, urgency and place of one P2000 message; null = a test or not readable. */
export function classifyP2000(m: P2000Raw, places: string[]): { service: Service; urgent: boolean; automatic: boolean; what: string | null; street: string | null; place: string | null; accident: boolean } | null {
  const raw = m.raw.toLowerCase();
  const d = m.description.trim();
  if (/proefalarm|test(alarm|bericht)?\b|^test/i.test(`${raw} ${d}`)) return null;
  let service: Service | null = null;
  if (/trauma ?heli|lifeliner|mmt\b/i.test(`${raw} ${d}`)) service = "helicopter";
  else if (/knrm|reddingsbrigade|waterongeval|water ongeval|zee\s?redding/i.test(`${raw} ${d}`)) service = "rescue";
  else if (/^ambulance/i.test(d) || /^(a[12]|b[12])\b/.test(raw)) service = "ambulance";
  else if (/^politie/i.test(d) || /\bpolitie\b/.test(raw)) service = "police";
  else if (/^p\s?[123]\b/.test(raw) || /brand|brandweer|gaslek|dienstverlening|hulpverlening|stormschade|wateroverlast/i.test(d)) service = "fire";
  if (!service) return null;
  const urgent = /^(p\s?1|a1)\b/.test(raw) || /met spoed|prio 1/i.test(d) && !/gepaste spoed/i.test(d);
  const automatic = /automatisch brandalarm|\boms\b|brandmelding/i.test(`${raw} ${d}`);
  // "Buitenbrand op Linnaeusstraat in Zandvoort", "Ambulance met spoed naar Radarstraat in IJmuiden voor …"
  let what: string | null = null;
  let street: string | null = null;
  let place: string | null = null;
  const a = /^(.+?) op (.+?) in (.+)$/i.exec(d);
  const b = /^(?:ambulance|brandweer|politie|traumaheli\w*|knrm)\b.*? naar (?:(.+?) in )?(.+?)(?: voor (.+))?$/i.exec(d);
  if (a && !/^(ambulance|brandweer|politie)\b/i.test(a[1]!)) [what, street, place] = [a[1]!, a[2]!, a[3]!];
  else if (b) [street, place, what] = [b[1] ?? null, b[2]!, b[3] ?? null];
  const slug = m.link ? /\/[a-z-]+\/[a-z-]+\/([a-z-]+)\//.exec(new URL(m.link, "https://x").pathname)?.[1] : null;
  const known = places.find((p) => p.toLowerCase().replace(/\s+/g, "-") === slug) ?? places.find((p) => place && p.toLowerCase() === place.trim().toLowerCase());
  if (known) place = known;
  else if (place) place = titleCase(place.trim());
  const accident = /ongeval/i.test(`${what ?? ""} ${raw}`);
  return { service, urgent, automatic, what: what ? what.trim() : null, street: street ? titleCase(street.trim()) : null, place, accident };
}

/** Public items from P2000 messages: only the chosen services and places, no addresses (unless asked), no medical details. */
export function p2000Items(messages: P2000Raw[], s: P2000Settings, now: number): RegionalItem[] {
  const tx = T[s.language];
  const places = new Set(s.places.map((p) => p.toLowerCase()));
  const seen = new Map<string, number>();
  const out: RegionalItem[] = [];
  const sorted = [...messages].sort((x, y) => Date.parse(x.publishedAt ?? "") - Date.parse(y.publishedAt ?? ""));
  for (const m of sorted) {
    const at = Date.parse(m.publishedAt ?? "");
    if (!Number.isFinite(at) || at < now - s.maxAgeHours * 3600_000) continue;
    const c = classifyP2000(m, s.places);
    if (!c || !c.place || !places.has(c.place.toLowerCase())) continue;
    if (!s.services[c.service] || (s.skipAutomaticAlarms && c.automatic) || (s.urgentOnly && !c.urgent)) continue;
    const svc = tx.service[c.service];
    // Ambulance calls say nothing about the patient: only an accident is named.
    let title: string;
    if (c.service === "ambulance") title = c.accident ? tx.accidentIn(c.place) : tx.deployed(svc, c.place);
    else if (c.what && c.service === "fire" && !/dienstverlening|hulpverlening/i.test(c.what)) title = `${titleCase(c.what.toLowerCase()).replace(/^(\p{L})(.*)$/u, (_, x: string, y: string) => x + y.toLowerCase())} in ${c.place}`;
    else title = tx.deployed(svc, c.place);
    if (s.showStreet && c.street && c.service !== "ambulance") title = title.replace(` in ${c.place}`, `, ${c.street} in ${c.place}`);
    // Several units for one call: once per title within an hour.
    const key = title.toLowerCase();
    if (at - (seen.get(key) ?? -Infinity) < 3600_000) continue;
    seen.set(key, at);
    out.push(
      base(`p2000:${m.guid}`, title, join(tx.call(svc), tx.callAt(timeOf(tx, s.timeZone, at))), svc, {
        publishedAt: iso(at),
        hold: s.requireApproval ? "pending" : null,
        showFrom: iso(at + s.delayMinutes * 60_000),
        note: [m.description, m.raw].filter(Boolean).join(" — ").slice(0, 500),
      }),
    );
  }
  return out.reverse();
}
