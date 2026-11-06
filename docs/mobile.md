# Phone layout

The management and orchestrator web apps switch to a phone layout on small screens.

- `packages/ui/src/mobile.ts`: `useMobile()` is true when the screen matches `(max-width: 767px), (pointer: coarse) and (max-height: 500px)` and the user has not chosen the desktop layout. The choice (`auto`/`desktop`) is stored in localStorage `tvsm.view`; the desktop choice sets the viewport meta to `width=1280`. `useViewChoice()` drives the toggle in the sidebar footer.
- `AppShell`: on a phone a top bar, `<main data-phone>` and a bottom bar with the nav items marked `mobile: true` (at most four, label `mobileLabel` if set) plus More, which opens the full menu.
- `Dialog` becomes a bottom sheet; `PageHeader` is compact.
- Touch drag: `apps/management/web/components/touchDrag.ts` turns a long press (350 ms) on any `[draggable="true"]` into synthetic HTML5 drag events, so the existing drop targets in `dnd.tsx` work unchanged. Moving earlier scrolls; the list auto-scrolls near the edges.
- Blocks: list or editor, not both; the media bin is not docked, clips are added through the Add media sheet. Week planning: one day at a time (`dayList` in `WeekPlan.tsx`), night hours folded.
