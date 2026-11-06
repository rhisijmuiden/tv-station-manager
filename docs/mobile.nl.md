# Telefoonweergave

De webapps van management en orchestrator schakelen op een klein scherm naar een telefoonweergave.

- `packages/ui/src/mobile.ts`: `useMobile()` is waar als het scherm past bij `(max-width: 767px), (pointer: coarse) and (max-height: 500px)` en de gebruiker niet voor desktop heeft gekozen. De keuze (`auto`/`desktop`) staat in localStorage `tvsm.view`; bij desktop wordt de viewport `width=1280`. `useViewChoice()` stuurt de knop onderaan het menu.
- `AppShell`: op een telefoon een balk bovenin, `<main data-phone>` en een menu onderin met de items die `mobile: true` hebben (hooguit vier, label `mobileLabel` als dat er is) plus Meer, dat het volledige menu opent.
- `Dialog` schuift van onderen omhoog; `PageHeader` is compacter.
- Slepen met de vinger: `apps/management/web/components/touchDrag.ts` maakt van lang indrukken (350 ms) op een `[draggable="true"]` nagebootste HTML5-sleepgebeurtenissen, zodat de bestaande neerzetplekken in `dnd.tsx` gewoon werken. Eerder bewegen is scrollen; bij de rand schuift de lijst mee.
- Blokken: lijst of blok, niet allebei; de mediabak staat er niet naast, clips voeg je toe via Media toevoegen. Weekplanning: één dag tegelijk (`dayList` in `WeekPlan.tsx`), nachturen ingeklapt.
