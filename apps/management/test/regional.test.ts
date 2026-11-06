import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { createPlatform, type Platform } from "@tvsm/platform";
import { managementOptions } from "../server/app.ts";
import type { DriverFactory } from "../server/drivers.ts";
import {
  causeShort,
  classifyP2000,
  councilItems,
  councilSchema,
  eventItems,
  eventsSchema,
  ibabsMeetings,
  manualToEvent,
  municipalPlace,
  notubizMeetings,
  notubizOrganisationId,
  p2000Items,
  p2000Schema,
  parseIcal,
  parseSituation,
  period,
  placeOnRoad,
  situationMayMatter,
  trafficItems,
  trafficSchema,
  type P2000Raw,
} from "../server/regionallogic.ts";
import { beeldkrantSchema, buildPages } from "../server/rsslogic.ts";
import { tickerHeadlines } from "../server/tickerlogic.ts";

// ---- DATEX II fixtures (shaped like the NDW files) ------------------------------------------------

const NOW = Date.parse("2026-11-06T16:00:00Z");
const values = (v: string) => `<com:values><com:value lang="nl">${v}</com:value></com:values>`;
const validity = (start: string, end?: string) =>
  `<sit:validity><com:validityStatus>definedByValidityTimeSpec</com:validityStatus><com:validityTimeSpecification><com:overallStartTime>${start}</com:overallStartTime>${end ? `<com:overallEndTime>${end}</com:overallEndTime>` : ""}</com:validityTimeSpecification></sit:validity>`;
const alertC = (...codes: number[]) =>
  `<sit:locationReference xsi:type="loc:ItineraryByIndexedLocations"><loc:locationContainedInItinerary index="1"><loc:location xsi:type="loc:SingleRoadLinearLocation"><loc:alertCLinear xsi:type="loc:AlertCMethod4Linear">${codes.map((c, i) => `<loc:alertCMethod4${i ? "Secondary" : "Primary"}PointLocation><loc:alertCLocation><loc:specificLocation>${c}</loc:specificLocation></loc:alertCLocation></loc:alertCMethod4${i ? "Secondary" : "Primary"}PointLocation>`).join("")}</loc:alertCLinear></loc:location></loc:locationContainedInItinerary></sit:locationReference>`;
const point = (lat: number, lon: number) => `<sit:locationReference xsi:type="loc:PointLocation"><loc:pointByCoordinates><loc:pointCoordinates><loc:latitude>${lat}</loc:latitude><loc:longitude>${lon}</loc:longitude></loc:pointCoordinates></loc:pointByCoordinates></sit:locationReference>`;
const comment = (text: string, type: string) => `<sit:generalPublicComment><sit:comment>${values(text)}</sit:comment><sit:commentType>${type}</sit:commentType></sit:generalPublicComment>`;
const record = (type: string, id: string, source: string, inner: string) => `<sit:situationRecord xsi:type="sit:${type}" id="${id}" version="1"><sit:source><com:sourceName>${values(source)}</com:sourceName></sit:source>${inner}</sit:situationRecord>`;
const situation = (id: string, ...records: string[]) => `<sit:situation id="${id}"><sit:overallSeverity>low</sit:overallSeverity>${records.join("")}</sit:situation>`;
const publication = (...situations: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><mc:messageContainer xmlns:sit="http://datex2.eu/schema/3/situation"><mc:payload xsi:type="sit:SituationPublication" lang="nl">${situations.join("")}</mc:payload></mc:messageContainer>`;

const CURRENT = publication(
  // 4.3 km jam on the A9 between Velsen and Beverwijk (VILD 10591 and 10594).
  situation("JAM1", record("AbnormalTraffic", "JAM1_1", "NLRWS", `${validity("2026-11-06T15:46:00Z")}<sit:impact><sit:delays><sit:delayTimeValue>597.0</sit:delayTimeValue></sit:delays></sit:impact>${alertC(10591, 10594)}<sit:abnormalTrafficType>slowTraffic</sit:abnormalTrafficType><sit:queueLength>4300</sit:queueLength>`)),
  // A short jam (left out: shorter than 1 km) and a jam near Utrecht (other road, not in the area).
  situation("JAM2", record("AbnormalTraffic", "JAM2_1", "NLRWS", `${validity("2026-11-06T15:50:00Z")}${alertC(8233)}<sit:abnormalTrafficType>queuingTraffic</sit:abnormalTrafficType><sit:queueLength>500</sit:queueLength>`)),
  situation("FAR", record("AbnormalTraffic", "FAR_1", "NLRWS", `${validity("2026-11-06T15:50:00Z")}${point(52.09, 5.12)}<sit:abnormalTrafficType>stationaryTraffic</sit:abnormalTrafficType><sit:queueLength>9000</sit:queueLength>`)),
  // Broken-down car near the Wijkertunnel (only coordinates) and an arrow truck of the road inspectors (not news).
  situation("PECH", record("VehicleObstruction", "PECH_1", "NDW", `${validity("2026-11-06T15:31:00Z")}${point(52.4585, 4.6702)}<sit:vehicleObstructionType>brokenDownVehicle</sit:vehicleObstructionType>`)),
  situation("PIJL", record("VehicleObstruction", "PIJL_1", "Pijlwagen", `${validity("2026-11-06T12:27:00Z")}${point(52.4585, 4.6702)}<sit:vehicleObstructionType>other</sit:vehicleObstructionType>`)),
  // Rush-hour lane open: not news.
  situation("SPITS", record("RoadOrCarriagewayOrLaneManagement", "SPITS_1", "RWS10", `${validity("2026-11-06T15:00:00Z")}${alertC(10591)}<sit:roadOrCarriagewayOrLaneManagementType>hardShoulderRunningInOperation</sit:roadOrCarriagewayOrLaneManagementType>`)),
  // Velsertunnel closed after an accident.
  situation("TUN", record("RoadOrCarriagewayOrLaneManagement", "TUN_1", "RWS", `${validity("2026-11-06T15:40:00Z", "2026-11-06T17:00:00Z")}<sit:cause><sit:causeType>accident</sit:causeType></sit:cause>${alertC(8233)}<sit:roadOrCarriagewayOrLaneManagementType>carriagewayClosures</sit:roadOrCarriagewayOrLaneManagementType>`)),
);

const PLANNED = publication(
  // Municipal works with street, place, a permit number and an editors' note.
  situation(
    "NDW03_631430",
    record("MaintenanceWorks", "M1", "Gemeente Velsen", `${validity("2026-11-09T06:00:00Z", "2026-11-20T17:00:00Z")}<sit:cause><sit:causeDescription>${values("Kabels / Leidingen, 740786")}</sit:causeDescription><sit:causeType>roadMaintenance</sit:causeType></sit:cause>${comment("J.C. van Neckstraat IJmuiden Kabels / Leidingen 740786 (631430)", "internalNote")}${comment("Weg dicht in beide richtingen", "warning")}${point(52.46276, 4.615)}`),
    record("ReroutingManagement", "M1_DET", "Gemeente Velsen", `${validity("2026-11-09T06:00:00Z", "2026-11-20T17:00:00Z")}${comment("Omleiding 1", "other")}`),
  ),
  // A crane in front of a house: only a "minor" hindrance, with a house number.
  situation("NDW03_636230", record("MaintenanceWorks", "M2", "Gemeente Velsen", `${validity("2026-11-16T07:00:00Z", "2026-11-16T12:00:00Z")}<sit:cause><sit:causeDescription>${values("Bouw/Takel, 1991 TK-21")}</sit:causeDescription><sit:causeType>roadMaintenance</sit:causeType></sit:cause>${comment("Wilhelmina Druckerstraat Wilhelmina Druckerstraat 21 Velserbroek Bouw/Takel 1991 TK-21 (636230)", "internalNote")}${comment("Snelheidsbeperking", "warning")}${point(52.44, 4.64)}`)),
  // No effect on traffic, too far ahead, and works of a month-long-plus project (more than 90 days).
  situation("NDW03_1", record("MaintenanceWorks", "M3", "Gemeente Velsen", `${validity("2026-11-10T07:00:00Z", "2026-11-10T12:00:00Z")}<sit:cause><sit:causeDescription>${values("Kabels / Leidingen")}</sit:causeDescription></sit:cause>${comment("Saturnusstraat IJmuiden Kabels / Leidingen (638185)", "internalNote")}${comment("Geen gevolgen voor verkeer", "warning")}`)),
  situation("NDW03_2", record("MaintenanceWorks", "M4", "Gemeente Heemskerk", `${validity("2026-12-25T07:00:00Z", "2026-12-26T12:00:00Z")}<sit:cause><sit:causeDescription>${values("Kabels / Leidingen")}</sit:causeDescription></sit:cause>${comment("Luttik Cie Heemskerk Kabels / Leidingen (634991)", "internalNote")}${comment("Weg dicht in beide richtingen", "warning")}`)),
  situation("NDW03_3", record("MaintenanceWorks", "M5", "Gemeente Beverwijk", `${validity("2026-04-17T05:00:00Z", "2027-12-17T08:00:00Z")}<sit:cause><sit:causeDescription>${values("Herinrichting / onderhoud van, Weg, ")}</sit:causeDescription></sit:cause>${comment("Elink Sterkstraat Beverwijk Herinrichting / onderhoud van Weg (561689)", "internalNote")}${comment("Weg dicht in beide richtingen", "warning")}`)),
  // Works of Rijkswaterstaat in the Velsertunnel tonight.
  situation(
    "RWS_TUN",
    record("MaintenanceWorks", "R1", "WNN [RWS West-Nederland Noord]", `${validity("2026-11-06T20:00:00Z", "2026-11-07T04:00:00Z")}<sit:cause><sit:causeDescription>${values("Regulier onderhoud tunnel")}</sit:causeDescription><sit:causeType>roadMaintenance</sit:causeType></sit:cause>${comment("WNN [RWS West-Nederland Noord]", "other")}${alertC(8232, 8234)}`),
    record("ReroutingManagement", "R1_DET", "WNN [RWS West-Nederland Noord]", `${validity("2026-11-06T20:00:00Z", "2026-11-07T04:00:00Z")}${comment("Volg route 1", "other")}`),
  ),
  // A cycle race in Beverwijk next week.
  situation("EVT", record("PublicEvent", "E1", "Gemeente Beverwijk", `${validity("2026-11-08T10:00:00Z", "2026-11-08T16:00:00Z")}<sit:cause><sit:causeDescription>${values("Wielerronde, ")}</sit:causeDescription><sit:causeType>publicEvent</sit:causeType></sit:cause>${comment("Weg dicht in beide richtingen", "warning")}${comment("Zeestraat Beverwijk", "other")}`)),
  // Works in Haarlem: other municipality, outside the area.
  situation("HAARLEM", record("MaintenanceWorks", "H1", "Gemeente Haarlem", `${validity("2026-11-05T07:00:00Z", "2026-11-12T12:00:00Z")}${comment("Kennemerplein Haarlem", "internalNote")}${comment("Weg dicht in beide richtingen", "warning")}${point(52.387, 4.638)}`)),
);

const sits = (xml: string) => xml.split("</sit:situation>").slice(0, -1).map((x) => parseSituation(`${x.slice(x.indexOf("<sit:situation "))}</sit:situation>`)!);

test("regional: DATEX situations become traffic items for the IJmond", () => {
  const s = trafficSchema.parse({});
  const cur = sits(CURRENT);
  assert.equal(cur.length, 7);
  assert.equal(cur[0]!.records[0]!.queueLength, 4300);
  assert.deepEqual(cur[0]!.records[0]!.locations, [10591, 10594]);
  assert.equal(situationMayMatter(CURRENT.slice(CURRENT.indexOf('<sit:situation id="FAR"'), CURRENT.indexOf('<sit:situation id="PECH"')), s.municipalities), false);
  assert.deepEqual(placeOnRoad(cur[0]!.records[0]!, s.roads), { road: "A9", names: ["Velsen", "Beverwijk"] });
  assert.deepEqual(placeOnRoad(cur[3]!.records[0]!, s.roads), { road: "A9", names: ["Wijkertunnel"] });
  assert.equal(placeOnRoad(cur[2]!.records[0]!, s.roads), null);

  const items = trafficItems(cur, sits(PLANNED), s, NOW);
  const titles = items.map((i) => i.title);
  assert.deepEqual(titles, [
    "File op de A9 tussen Velsen en Beverwijk",
    "Pechgeval op de A9 bij Wijkertunnel",
    "Afsluiting A22 bij Velsertunnel",
    "Wegwerkzaamheden A22 tussen IJmuiden en Beverwijk",
    "Zeestraat – Beverwijk",
    "J.C. van Neckstraat – IJmuiden",
  ]);
  assert.equal(items[0]!.summary, "4,3 km. Langzaam rijdend verkeer. Ongeveer 10 minuten vertraging.");
  assert.equal(items[0]!.categories[0], "File");
  assert.equal(items[0]!.publishedAt, "2026-11-06T15:46:00.000Z");
  assert.equal(items[2]!.summary, "Weg afgesloten. vr 6 november 16:40 – 18:00.");
  assert.equal(items[3]!.summary, "Regulier onderhoud tunnel. Volg de omleidingsborden. vr 6 november 21:00 t/m za 7 november 05:00.");
  assert.equal(items[4]!.summary, "Wielerronde. Weg dicht in beide richtingen. zo 8 november 11:00 – 17:00.");
  assert.equal(items[5]!.summary, "Weg dicht in beide richtingen. ma 9 november t/m vr 20 november.");
  assert.deepEqual(items.map((i) => i.rank), [0, 1, 2, 3, 4, 5]);

  // Minor works on request (without the house number), longer horizon, English, switches.
  const more = trafficItems(cur, sits(PLANNED), { ...s, minorWorks: true, roadworksDaysAhead: 60, maxWorkDays: 0 }, NOW).map((i) => i.title);
  assert.ok(more.includes("Wilhelmina Druckerstraat – Velserbroek"), more.join("\n"));
  assert.ok(more.includes("Luttik Cie – Heemskerk"));
  assert.ok(more.includes("Elink Sterkstraat – Beverwijk"));
  assert.ok(!more.some((t) => /Saturnus|Kennemerplein/.test(t)));
  const en = trafficItems(cur, [], { ...s, language: "en", roadworks: false }, NOW);
  assert.equal(en[0]!.title, "Traffic jam on the A9 between Velsen and Beverwijk");
  assert.equal(trafficItems(cur, [], { ...s, jams: false, incidents: false, closures: false }, NOW).length, 0);
  assert.equal(trafficItems(cur, [], { ...s, minJamKm: 5 }, NOW)[0]!.title, "Pechgeval op de A9 bij Wijkertunnel");
});

test("regional: municipal places without numbers, cause texts and periods", () => {
  const r = sits(PLANNED)[1]!.records[0]!;
  assert.deepEqual(municipalPlace(r, ["IJmuiden", "Velserbroek"]), { street: "Wilhelmina Druckerstraat", place: "Velserbroek" });
  assert.equal(causeShort("Herinrichting / onderhoud van, Kruising, Aanleg rotonde"), "Aanleg rotonde");
  assert.equal(causeShort("Overig, , "), "");
  assert.equal(period(Date.parse("2026-11-12T06:00:00Z"), Date.parse("2026-11-12T15:00:00Z"), "nl", "Europe/Amsterdam"), "do 12 november 07:00 – 16:00");
  assert.equal(period(Date.parse("2026-11-09T06:00:00Z"), Date.parse("2026-11-20T17:00:00Z"), "nl", "Europe/Amsterdam"), "ma 9 november t/m vr 20 november");
  assert.equal(period(Date.parse("2026-11-09T06:00:00Z"), null, "en", "Europe/Amsterdam"), "from Mon 9 November");
});

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:a1",
  "SUMMARY:Sinterklaasintocht IJmuiden",
  "DTSTART;TZID=Europe/Amsterdam:20261114T130000",
  "DTEND;TZID=Europe/Amsterdam:20261114T160000",
  "LOCATION:Haven\\, IJmuiden",
  "DESCRIPTION:Intocht met de boot.\\nGratis.",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:a2",
  "SUMMARY:Kerstmarkt Beverwijk",
  "DTSTART;VALUE=DATE:20261212",
  "DTEND;VALUE=DATE:20261214",
  "LOCATION:Breestraat",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:a3",
  "SUMMARY:Afgelast",
  "DTSTART:20261110T180000Z",
  "STATUS:CANCELLED",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:a4",
  "SUMMARY:Gisteren",
  "DTSTART:20261105T180000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("regional: events from iCal and the editors' list, soonest first", () => {
  const ev = parseIcal(ICS);
  assert.equal(ev.length, 4);
  assert.equal(ev[0]!.start, Date.parse("2026-11-14T12:00:00Z"));
  assert.equal(ev[0]!.location, "Haven, IJmuiden");
  assert.equal(ev[1]!.allDay, true);
  assert.equal(ev[2]!.cancelled, true);
  const manual = manualToEvent({ id: "m1", title: "Pubquiz", date: "2026-11-07", time: "20:00", endDate: "", place: "Café De Zon", text: "Teams van vier." }, "Europe/Amsterdam");
  assert.equal(manual.start, Date.parse("2026-11-07T19:00:00Z"));
  const items = eventItems([...ev, manual], eventsSchema.parse({ daysAhead: 40 }), NOW);
  assert.deepEqual(items.map((i) => i.title), ["Pubquiz", "Sinterklaasintocht IJmuiden", "Kerstmarkt Beverwijk"]);
  assert.equal(items[0]!.summary, "za 7 november om 20:00 · Café De Zon. Teams van vier.");
  assert.equal(items[1]!.summary, "za 14 november om 13:00 · Haven, IJmuiden. Intocht met de boot. Gratis.");
  assert.equal(items[2]!.summary, "za 12 december t/m zo 13 december · Breestraat.");
  assert.equal(eventItems([...ev, manual], eventsSchema.parse({ daysAhead: 7 }), NOW).length, 1);
});

const IBABS = [
  { id: "x1", title: "Raadsvergadering", start: "2026-11-19T19:30:00", end: "2026-11-19T22:30:00", url: "/Agenda/Index/x1", location: "Raadszaal", description: "Openbare vergadering" },
  { id: "x2", title: "Commissievergadering", start: "2026-11-12T19:30:00", end: "2026-11-12T22:30:00", url: "/Agenda/Index/x2", location: "GEANNULEERD", description: "Deze vergadering is geannuleerd." },
  { id: "x3", title: "Oud", start: "2026-10-01T19:30:00", url: "/Agenda/Index/x3", location: "" },
];
const NOTUBIZ = {
  pagination: { has_more_pages: false },
  events: [
    { id: 101, type: "meeting", permission_group: "public", confidential: 0, canceled: false, inactive: false, attributes: [{ id: 1, value: "Gemeenteraad" }, { id: 50, value: "'Raadszaal stadhuis'" }], plannings: [{ start_date: "2026-11-10 20:00:00", end_date: null }] },
    { id: 102, type: "meeting", permission_group: "public", confidential: 1, attributes: [{ id: 1, value: "Geheim" }], plannings: [{ start_date: "2026-11-11 20:00:00" }] },
  ],
};

test("regional: council meetings from iBabs and Notubiz", () => {
  const ib = ibabsMeetings(IBABS, { name: "Beverwijk", url: "https://beverwijk.bestuurlijkeinformatie.nl" }, "Europe/Amsterdam");
  assert.equal(ib[0]!.start, Date.parse("2026-11-19T18:30:00Z"));
  assert.equal(ib[1]!.cancelled, true);
  assert.equal(ib[0]!.url, "https://beverwijk.bestuurlijkeinformatie.nl/Agenda/Index/x1");
  const nb = notubizMeetings(NOTUBIZ, { name: "Velsen", url: "https://velsen.raadsinformatie.nl" }, "Europe/Amsterdam");
  assert.equal(nb.length, 1);
  assert.equal(nb[0]!.location, "Raadszaal stadhuis");
  assert.equal(notubizOrganisationId({ organisations: [{ id: 5, name: "Gemeente Velsen" }, { id: 6, name: "Heemskerk" }] }, "Velsen"), 5);
  assert.equal(notubizOrganisationId([{ id: 6, name: "Heemskerk" }], "Velsen"), null);
  const items = councilItems([...ib, ...nb], councilSchema.parse({}), NOW);
  assert.deepEqual(items.map((i) => i.title), ["Gemeenteraad Velsen", "Commissievergadering Beverwijk", "Raadsvergadering Beverwijk"]);
  assert.equal(items[0]!.summary, "di 10 november om 20:00 · Raadszaal stadhuis.");
  assert.equal(items[1]!.summary, "do 12 november om 19:30. Gaat niet door.");
  assert.equal(items[1]!.categories[0], "Gemeente Beverwijk");
  assert.equal(councilItems([...ib, ...nb], councilSchema.parse({ showCancelled: false }), NOW).length, 2);
});

const P2000: P2000Raw[] = [
  { guid: "g1", raw: "p 1 bnh-01 br woning radarstraat ijmuiden 123456", description: "Woningbrand op Radarstraat in Ijmuiden", link: "https://alarmeringen.nl/noord-holland/kennemerland/ijmuiden/1/x.html", publishedAt: "2026-11-06T15:30:00Z" },
  { guid: "g2", raw: "p 1 bnh-02 br woning radarstraat ijmuiden 123457", description: "Woningbrand op Radarstraat in Ijmuiden", link: "https://alarmeringen.nl/noord-holland/kennemerland/ijmuiden/2/x.html", publishedAt: "2026-11-06T15:31:00Z" },
  { guid: "g3", raw: "a1 dia: ja 12156 rit 167531 n197 - binnenduinrandweg beverwijk", description: "Ambulance met spoed naar Binnenduinrandweg in Beverwijk", link: "https://alarmeringen.nl/noord-holland/kennemerland/beverwijk/3/x.html", publishedAt: "2026-11-06T15:20:00Z" },
  { guid: "g4", raw: "p 1 bnh-01 oms brandmelding unicum zandvoortselaan zandvoort 123340", description: "Automatisch brandalarm op Zandvoortselaan in Zandvoort", link: "https://alarmeringen.nl/noord-holland/kennemerland/zandvoort/4/x.html", publishedAt: "2026-11-06T15:10:00Z" },
  { guid: "g5", raw: "p 1 oms brandmelding tata steel velsen-noord 121212", description: "Automatisch brandalarm op Wenckebachstraat in Velsen-Noord", link: "https://alarmeringen.nl/noord-holland/kennemerland/velsen-noord/5/x.html", publishedAt: "2026-11-06T15:05:00Z" },
  { guid: "g6", raw: "p 5 proefalarm geplande actie tata steel velsen-noord", description: "Ambulance met spoed naar Breedbandweg in Velsen-Noord", link: "https://alarmeringen.nl/noord-holland/kennemerland/velsen-noord/", publishedAt: "2026-11-06T15:00:00Z" },
  { guid: "g7", raw: "p 2 bnh-05 ongeval gev. stof gaslekkage binnen peperstraat beverwijk 121291", description: "Gaslek op Peperstraat in Beverwijk", link: "https://alarmeringen.nl/noord-holland/kennemerland/beverwijk/7/x.html", publishedAt: "2026-11-06T14:00:00Z" },
  { guid: "g8", raw: "p 1 br buiten strand heemskerk", description: "Buitenbrand op Strand in Heemskerk", link: null, publishedAt: "2026-11-05T14:00:00Z" },
];

test("regional: P2000 alerts for the three municipalities, without addresses", () => {
  assert.equal(classifyP2000(P2000[5]!, ["Velsen-Noord"]), null); // test alarm
  assert.equal(classifyP2000(P2000[2]!, ["Beverwijk"])!.service, "ambulance");
  assert.equal(classifyP2000(P2000[4]!, ["Velsen-Noord"])!.automatic, true);
  const s = p2000Schema.parse({});
  const items = p2000Items(P2000, s, NOW);
  assert.deepEqual(items.map((i) => i.title), ["Woningbrand in IJmuiden", "Gaslek in Beverwijk"]);
  const fire = items[0]!;
  assert.equal(fire.summary, "De brandweer is uitgerukt. Melding om 16:30.");
  assert.doesNotMatch(`${fire.title} ${fire.summary}`, /radarstraat|123456/i);
  assert.equal(fire.hold, "pending");
  assert.equal(fire.showFrom, "2026-11-06T15:50:00.000Z");
  assert.match(fire.note!, /Radarstraat/);
  // Ambulances on request: no patient details, only the place. Street names on request (never for ambulances).
  const amb = p2000Items(P2000, { ...s, services: { ...s.services, ambulance: true }, showStreet: true, requireApproval: false, delayMinutes: 0 }, NOW);
  assert.deepEqual(amb.map((i) => i.title), ["Woningbrand, Radarstraat in IJmuiden", "Ambulance in Beverwijk", "Gaslek, Peperstraat in Beverwijk"]);
  assert.equal(amb[0]!.hold, null);
  assert.equal(p2000Items(P2000, { ...s, urgentOnly: true }, NOW).length, 1);
  assert.equal(p2000Items(P2000, { ...s, skipAutomaticAlarms: false }, NOW)[1]!.title, "Automatisch brandalarm in Velsen-Noord");
  assert.equal(p2000Items(P2000, { ...s, maxAgeHours: 48 }, NOW).at(-1)!.title, "Buitenbrand in Heemskerk");
});

test("regional: ranked items keep their order on the beeldkrant and in the ticker", () => {
  const now = NOW;
  const items = [
    { id: 1, feedId: 1, title: "Nieuws", summary: "", body: "", imageUrl: null, categories: [], publishedAt: "2026-11-06T15:59:00Z", seenAt: "" },
    { id: 2, feedId: 2, title: "Tweede", summary: "", body: "", imageUrl: null, categories: [], publishedAt: null, seenAt: "2020-01-01T00:00:00Z", rank: 1 },
    { id: 3, feedId: 2, title: "Eerste", summary: "", body: "", imageUrl: null, categories: [], publishedAt: null, seenAt: "2020-01-01T00:00:00Z", rank: 0 },
  ];
  assert.deepEqual(buildPages(items, beeldkrantSchema.parse({ maxAgeHours: 24 }), new Map(), now, () => null).map((p) => p.title), ["Eerste", "Tweede", "Nieuws"]);
  assert.deepEqual(tickerHeadlines(items, { maxItems: 10, maxAgeHours: 24, showTime: true }, now, "Europe/Amsterdam"), ["Eerste", "Tweede", "16:59 Nieuws"]);
});

// ---- server -------------------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "tvsm-regional-"));
process.env.TVSM_DATA_DIR = join(root, "data");
process.env.TVSM_CONF_DIR = join(root, "conf");
process.env.TVSM_DEFAULT_ADMIN = "admin:admin-password";
let p: Platform;
let site: Server;
let base = "";
let cookie = "";
const hits: string[] = [];
const drivers: DriverFactory = { switcher: () => ({}) as never, playout: () => ({}) as never };
const api = async (method: string, url: string, payload?: unknown) => {
  const res = await p.server.inject({ method: method as "GET", url, payload: payload as object, headers: cookie ? { cookie } : {} });
  const set = res.headers["set-cookie"];
  if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(";")[0]!;
  return { status: res.statusCode, body: res.headers["content-type"]?.includes("json") ? JSON.parse(res.body) : res.body };
};
const P2000_RSS = (msgs: P2000Raw[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Alarmeringen</title>${msgs.map((m) => `<item><title>${m.raw}</title><link>${m.link ?? ""}</link><description>${m.description}</description><pubDate>${new Date(m.publishedAt!).toUTCString()}</pubDate><guid isPermaLink="false">${m.guid}</guid></item>`).join("")}</channel></rss>`;
let p2000Now: P2000Raw[] = [];
// The fixtures are written for NOW; the server runs on the real clock, so their dates move by whole days.
const OFFSET_DAYS = Math.max(0, Math.floor((Date.now() - NOW) / 86400_000));
const addDays = (y: string, m: string, d: string) => new Date(Date.UTC(+y, +m - 1, +d + OFFSET_DAYS)).toISOString().slice(0, 10);
const shift = (text: string) =>
  text
    .replace(/\b(20\d\d)-(\d\d)-(\d\d)(?=[T ])/g, (_, y: string, m: string, d: string) => addDays(y, m, d))
    .replace(/\b(20\d\d)(\d\d)(\d\d)(?=T\d|\r?\n|$)/gm, (_, y: string, m: string, d: string) => addDays(y, m, d).replace(/-/g, ""));

test.before(async () => {
  site = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    hits.push(u.pathname + u.search);
    if (u.pathname === "/actueel_beeld.xml.gz") return res.writeHead(200, { "content-type": "application/octet-stream" }).end(gzipSync(shift(CURRENT)));
    if (u.pathname === "/planning.xml.gz") return res.writeHead(200).end(gzipSync(shift(PLANNED)));
    if (u.pathname === "/Calendar/GetAgendasForCalendar") return res.writeHead(200, { "content-type": "application/json" }).end(shift(JSON.stringify(IBABS)));
    if (u.pathname === "/organisations") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ organisations: [{ id: 77, name: "Velsen" }] }));
    if (u.pathname === "/events") return res.writeHead(200, { "content-type": "application/json" }).end(shift(JSON.stringify(u.searchParams.get("organisation_id") === "77" ? NOTUBIZ : { events: [] })));
    if (u.pathname === "/agenda.ics") return res.writeHead(200, { "content-type": "text/calendar" }).end(shift(ICS));
    if (u.pathname === "/p2000.rss") return res.writeHead(200, { "content-type": "application/rss+xml" }).end(P2000_RSS(p2000Now));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  process.env.TVSM_NOTUBIZ_API = base;
  p = await createPlatform(managementOptions({ drivers, autostart: false }));
  assert.equal((await api("POST", "/api/auth/login", { username: "admin", password: "admin-password" })).status, 200);
});
test.after(async () => {
  await p.server.close();
  site.close();
  rmSync(root, { recursive: true, force: true });
});

test("regional: sources switched on by the editors feed beeldkranten", async () => {
  const list = (await api("GET", "/api/regional")).body;
  assert.deepEqual(list.sources.map((s: { source: string }) => s.source), ["traffic", "events", "council", "p2000"]);
  assert.equal(list.sources[0].feed, null);
  assert.deepEqual(list.sources[0].defaults.roads, ["A9", "A22", "A208", "N197", "N202", "N208", "N246"]);

  // Traffic: streamed, gzip detected by the file name.
  const tr = await api("POST", "/api/regional/traffic", { config: { currentUrl: `${base}/actueel_beeld.xml.gz`, plannedUrl: `${base}/planning.xml.gz`, roadworksDaysAhead: 30 } });
  assert.equal(tr.status, 200, JSON.stringify(tr.body));
  assert.equal(tr.body.source, "traffic");
  assert.equal(tr.body.lastError, null);
  assert.ok(tr.body.itemCount >= 5, JSON.stringify(tr.body));
  assert.equal((await api("POST", "/api/regional/traffic", {})).body.id, tr.body.id); // one feed per source
  assert.equal((await api("PUT", `/api/rss/feeds/${tr.body.id}`, { name: "x", kind: "rss", url: "https://x.nl/feed" })).status, 409);
  assert.equal((await api("PUT", "/api/regional/traffic", { config: { roads: ["A9"], minJamKm: -1 } })).status, 400);

  // Council: iBabs portal + Notubiz (organisation looked up by name) + a municipality that fails.
  const co = await api("POST", "/api/regional/council", {
    config: {
      municipalities: [
        { name: "Beverwijk", system: "ibabs", url: base },
        { name: "Velsen", system: "notubiz", url: "https://velsen.raadsinformatie.nl" },
        { name: "Heemskerk", system: "ical", url: `${base}/missing.ics` },
      ],
    },
  });
  assert.equal(co.body.itemCount, 3, JSON.stringify(co.body));
  assert.match(co.body.lastError, /Heemskerk: HTTP 404/);
  assert.ok(hits.some((h) => h.startsWith("/events?organisation_id=77")));

  // Events: iCal feed + the editors' list.
  const ev = await api("POST", "/api/regional/events", { config: { feedUrl: `${base}/agenda.ics`, daysAhead: 60, manual: [{ id: "m1", title: "Pubquiz", date: "2099-01-01", time: "20:00" }] } });
  assert.equal(ev.body.itemCount, 2, JSON.stringify(ev.body)); // two iCal events ahead; 2099 is too far
  const test1 = await api("POST", "/api/regional/events/test", { config: { manual: [{ id: "a", title: "Morgen", date: new Date(Date.now() + 86400_000).toISOString().slice(0, 10) }] } });
  assert.equal(test1.body.items[0].title, "Morgen");

  // P2000: waits for the delay and an editor's approval, and stays after the site's feed moves on.
  const fresh = new Date(Date.now() - 30 * 60_000).toISOString();
  p2000Now = [{ ...P2000[0]!, publishedAt: fresh }, { ...P2000[6]!, publishedAt: new Date(Date.now() - 2 * 60_000).toISOString() }];
  const pk = await api("POST", "/api/regional/p2000", { config: { feedUrl: `${base}/p2000.rss` } });
  assert.equal(pk.body.itemCount, 2, JSON.stringify(pk.body));
  const items = (await api("GET", "/api/regional/p2000/items")).body.items as { id: number; title: string; state: string; note: string }[];
  assert.deepEqual(items.map((i) => [i.title, i.state]), [["Gaslek in Beverwijk", "pending"], ["Woningbrand in IJmuiden", "pending"]]);
  assert.match(items[1]!.note, /Radarstraat/);
  assert.equal((await api("GET", "/api/regional")).body.sources[3].pending, 2);

  const bk = await api("POST", "/api/regional/p2000/beeldkrant");
  assert.equal(bk.status, 200, JSON.stringify(bk.body));
  const data = async () => (await api("GET", `/beeldkrant/${bk.body.beeldkrantId}/data.json`)).body;
  assert.equal((await data()).pages.length, 0); // nothing approved yet
  assert.equal((await data()).settings.headerText, "112 IJmond");
  for (const i of items) await api("POST", `/api/regional/items/${i.id}/approve`);
  // The fire is 30 minutes old (delay 20): on air. The gas leak is 2 minutes old: waits.
  assert.deepEqual((await data()).pages.map((x: { title: string }) => x.title), ["Woningbrand in IJmuiden"]);
  const after = (await api("GET", "/api/regional/p2000/items")).body.items as { title: string; state: string }[];
  assert.deepEqual(after.map((i) => i.state), ["delayed", "on_air"]);
  await api("POST", `/api/regional/items/${items[1]!.id}/reject`);
  assert.equal((await data()).pages.length, 0);
  p2000Now = [];
  await api("POST", `/api/rss/feeds/${pk.body.id}/refresh`);
  assert.equal((await api("GET", "/api/regional/p2000/items")).body.items.length, 2);
  // The block to plan it.
  const block = (await api("GET", `/api/blocks/${bk.body.blockId}`)).body;
  assert.equal(block.items[0].type, "beeldkrant");

  // Traffic beeldkrant: fixed order, jams first.
  const tb = (await api("POST", "/api/regional/traffic/beeldkrant")).body;
  const tp = (await api("GET", `/beeldkrant/${tb.beeldkrantId}/data.json`)).body.pages;
  assert.match(tp[0].title, /^File op de A9/);
});
