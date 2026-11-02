import "@tvsm/ui/styles.css";
import { mountPlatformApp } from "@tvsm/ui";
import { AudioLines, Cable, CalendarDays, CalendarRange, Cast, ClipboardList, Clock3, Layers, LayoutGrid, Library, MonitorPlay, Newspaper, Radio, Rss, SlidersHorizontal, Tags, ToggleRight, Tv, WandSparkles, Wrench } from "lucide-react";
import { AudioSourcesPage } from "./pages/AudioSources";
import { BeeldkrantPage } from "./pages/Beeldkrant";
import { BlocksPage } from "./pages/Blocks";
import { CategoriesPage } from "./pages/Categories";
import { ClocksPage } from "./pages/Clocks";
import { ChannelsPage } from "./pages/Channels";
import { ControlPage } from "./pages/Control";
import { Dashboard } from "./pages/Dashboard";
import { DevicesPage } from "./pages/Devices";
import { EpgPage } from "./pages/Epg";
import { GraphicsPage } from "./pages/Graphics";
import { MediaPage } from "./pages/Media";
import { NewHourPage } from "./pages/NewHour";
import { OutputsPage } from "./pages/Outputs";
import { RecordingsPage } from "./pages/Recordings";
import { RemoteSourcesPage } from "./pages/RemoteSources";
import { RundownsPage } from "./pages/Rundowns";
import { SchedulePage } from "./pages/Schedule";
import { SwitchButtonsPage, SwitchPage } from "./pages/Switch";
import { WebcamsPage } from "./pages/Webcams";
import { WeekPage } from "./pages/Week";
import { WeekPlanPage } from "./pages/WeekPlan";
import { LibraryTabs } from "./components/LibraryTabs";
import en from "./i18n/en.json";
import nl from "./i18n/nl.json";

mountPlatformApp({
  appName: "TV Station Manager",
  translations: { en, nl },
  nav: [
    {
      // The editors' work in three ideas: what can go on air (library), hour blocks, and the week they are planned in.
      label: "mgmt.nav.editorial",
      items: [
        { to: "/", label: "mgmt.plan.nav.now", icon: MonitorPlay, end: true },
        { to: "/week", label: "mgmt.plan.nav.week", icon: CalendarRange, end: true },
        { to: "/blocks", label: "mgmt.plan.nav.blocks", icon: LayoutGrid, also: ["/ads"] },
        { to: "/media", label: "mgmt.plan.nav.library", icon: Library, also: ["/recordings", "/beeldkrant", "/webcams", "/remote"] },
      ],
    },
    {
      label: "mgmt.nav.broadcast",
      items: [
        { to: "/switch", label: "mgmt.nav.switch", icon: ToggleRight, minRole: "operator" },
        { to: "/control", label: "mgmt.nav.control", icon: Radio },
        { to: "/schedule", label: "mgmt.nav.schedule", icon: CalendarDays },
        { to: "/epg", label: "mgmt.nav.epg", icon: Newspaper },
        { to: "/outputs", label: "mgmt.nav.outputs", icon: Cast },
      ],
    },
    {
      label: "mgmt.nav.setup",
      minRole: "editor",
      items: [
        { to: "/graphics", label: "mgmt.plan.nav.channel", icon: Layers, minRole: "editor" },
        {
          to: "sources",
          label: "mgmt.plan.nav.sources",
          icon: Rss,
          minRole: "editor",
          children: [
            { to: "/audio", label: "mgmt.nav.audio", icon: AudioLines },
            { to: "/categories", label: "mgmt.nav.categories", icon: Tags },
          ],
        },
        { to: "/channels", label: "mgmt.nav.channels", icon: Tv, minRole: "admin" },
        { to: "/devices", label: "mgmt.nav.devices", icon: Cable, minRole: "admin" },
        { to: "/switch-buttons", label: "mgmt.nav.switchButtons", icon: SlidersHorizontal, minRole: "admin" },
        {
          // The older, more technical planning tools: still there for special cases, out of the editors' way.
          to: "advanced",
          label: "mgmt.plan.nav.advanced",
          icon: Wrench,
          minRole: "admin",
          children: [
            { to: "/week/advanced", label: "mgmt.nav.week", icon: CalendarRange },
            { to: "/rundowns", label: "mgmt.nav.rundowns", icon: ClipboardList },
            { to: "/clocks", label: "mgmt.nav.clocks", icon: Clock3 },
            { to: "/new-hour", label: "mgmt.nav.newHour", icon: WandSparkles },
          ],
        },
      ],
    },
  ],
  routes: [
    { path: "/", element: <Dashboard /> },
    { path: "/control", element: <ControlPage /> },
    { path: "/switch", element: <SwitchPage /> },
    { path: "/switch-buttons", element: <SwitchButtonsPage /> },
    { path: "/remote", element: <LibraryTabs><RemoteSourcesPage /></LibraryTabs> },
    { path: "/audio", element: <AudioSourcesPage /> },
    { path: "/recordings", element: <LibraryTabs><RecordingsPage /></LibraryTabs> },
    { path: "/outputs", element: <OutputsPage /> },
    { path: "/schedule", element: <SchedulePage /> },
    { path: "/week", element: <WeekPlanPage /> },
    { path: "/week/advanced", element: <WeekPage /> },
    { path: "/new-hour", element: <NewHourPage /> },
    { path: "/rundowns", element: <RundownsPage /> },
    { path: "/rundowns/:slot/:date", element: <RundownsPage /> },
    { path: "/clocks", element: <ClocksPage /> },
    { path: "/clocks/:id", element: <ClocksPage /> },
    { path: "/categories", element: <CategoriesPage /> },
    { path: "/blocks", element: <BlocksPage kind="program" /> },
    { path: "/blocks/:id", element: <BlocksPage kind="program" /> },
    { path: "/ads", element: <BlocksPage kind="commercial" /> },
    { path: "/ads/:id", element: <BlocksPage kind="commercial" /> },
    { path: "/media", element: <LibraryTabs><MediaPage /></LibraryTabs> },
    { path: "/beeldkrant", element: <LibraryTabs><BeeldkrantPage /></LibraryTabs> },
    { path: "/beeldkrant/:id", element: <LibraryTabs><BeeldkrantPage /></LibraryTabs> },
    { path: "/webcams", element: <LibraryTabs><WebcamsPage /></LibraryTabs> },
    { path: "/epg", element: <EpgPage /> },
    { path: "/graphics", element: <GraphicsPage /> },
    { path: "/channels", element: <ChannelsPage /> },
    { path: "/devices", element: <DevicesPage /> },
  ],
});
// Keeps the icon import list honest for tree shaking.
