import "@tvsm/ui/styles.css";
import { mountPlatformApp } from "@tvsm/ui";
import { AudioLines, Cable, CalendarDays, CalendarRange, Cast, Clapperboard, ClipboardList, Clock3, Film, FolderOpen, LayoutDashboard, Newspaper, Palette, Radio, Rss, Satellite, Tags, ToggleRight, Tv, Video, WandSparkles, Webcam } from "lucide-react";
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
import en from "./i18n/en.json";
import nl from "./i18n/nl.json";

mountPlatformApp({
  appName: "TV Station Manager",
  translations: { en, nl },
  nav: [
    {
      items: [{ to: "/", label: "nav.dashboard", icon: LayoutDashboard, end: true }],
    },
    {
      // The editorial work, in the order an editor does it: make an hour, plan it in the week, check the days.
      label: "mgmt.nav.editorial",
      items: [
        { to: "/new-hour", label: "mgmt.nav.newHour", icon: WandSparkles, minRole: "editor" },
        { to: "/switch", label: "mgmt.nav.switch", icon: ToggleRight, minRole: "operator" },
        { to: "/week", label: "mgmt.nav.week", icon: CalendarRange },
        { to: "/rundowns", label: "mgmt.nav.rundowns", icon: ClipboardList },
        { to: "/blocks", label: "mgmt.nav.blocks", icon: Clapperboard },
        { to: "/clocks", label: "mgmt.nav.clocks", icon: Clock3 },
        { to: "/media", label: "mgmt.nav.media", icon: FolderOpen },
        { to: "/recordings", label: "mgmt.nav.recordings", icon: Video },
        { to: "/categories", label: "mgmt.nav.categories", icon: Tags },
        { to: "/ads", label: "mgmt.nav.ads", icon: Film },
        { to: "/beeldkrant", label: "mgmt.nav.beeldkrant", icon: Rss },
        { to: "/webcams", label: "mgmt.nav.webcams", icon: Webcam },
      ],
    },
    {
      label: "mgmt.nav.broadcast",
      items: [
        { to: "/control", label: "mgmt.nav.control", icon: Radio },
        { to: "/schedule", label: "mgmt.nav.schedule", icon: CalendarDays },
        { to: "/epg", label: "mgmt.nav.epg", icon: Newspaper },
        { to: "/remote", label: "mgmt.nav.remote", icon: Satellite },
        { to: "/audio", label: "mgmt.nav.audio", icon: AudioLines },
        { to: "/outputs", label: "mgmt.nav.outputs", icon: Cast },
      ],
    },
    {
      label: "mgmt.nav.setup",
      minRole: "editor",
      items: [
        { to: "/graphics", label: "mgmt.nav.graphics", icon: Palette, minRole: "editor" },
        { to: "/channels", label: "mgmt.nav.channels", icon: Tv, minRole: "admin" },
        { to: "/devices", label: "mgmt.nav.devices", icon: Cable, minRole: "admin" },
        { to: "/switch-buttons", label: "mgmt.nav.switchButtons", icon: ToggleRight, minRole: "admin" },
      ],
    },
  ],
  routes: [
    { path: "/", element: <Dashboard /> },
    { path: "/control", element: <ControlPage /> },
    { path: "/switch", element: <SwitchPage /> },
    { path: "/switch-buttons", element: <SwitchButtonsPage /> },
    { path: "/remote", element: <RemoteSourcesPage /> },
    { path: "/audio", element: <AudioSourcesPage /> },
    { path: "/recordings", element: <RecordingsPage /> },
    { path: "/outputs", element: <OutputsPage /> },
    { path: "/schedule", element: <SchedulePage /> },
    { path: "/week", element: <WeekPage /> },
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
    { path: "/media", element: <MediaPage /> },
    { path: "/beeldkrant", element: <BeeldkrantPage /> },
    { path: "/beeldkrant/:id", element: <BeeldkrantPage /> },
    { path: "/webcams", element: <WebcamsPage /> },
    { path: "/epg", element: <EpgPage /> },
    { path: "/graphics", element: <GraphicsPage /> },
    { path: "/channels", element: <ChannelsPage /> },
    { path: "/devices", element: <DevicesPage /> },
  ],
});
// Keeps the icon import list honest for tree shaking.
