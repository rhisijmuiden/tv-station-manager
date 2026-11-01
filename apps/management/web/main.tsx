import "@tvsm/ui/styles.css";
import { mountPlatformApp } from "@tvsm/ui";
import { Cable, CalendarDays, CalendarRange, Cast, Clapperboard, ClipboardList, Clock3, Film, FolderOpen, LayoutDashboard, Newspaper, Palette, Radio, Satellite, Tags, Tv } from "lucide-react";
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
import { OutputsPage } from "./pages/Outputs";
import { RemoteSourcesPage } from "./pages/RemoteSources";
import { RundownsPage } from "./pages/Rundowns";
import { SchedulePage } from "./pages/Schedule";
import { WeekPage } from "./pages/Week";
import en from "./i18n/en.json";
import nl from "./i18n/nl.json";

mountPlatformApp({
  appName: "TV Station Manager",
  translations: { en, nl },
  nav: [
    {
      items: [
        { to: "/", label: "nav.dashboard", icon: LayoutDashboard, end: true },
        { to: "/control", label: "mgmt.nav.control", icon: Radio },
        { to: "/remote", label: "mgmt.nav.remote", icon: Satellite },
        { to: "/outputs", label: "mgmt.nav.outputs", icon: Cast },
      ],
    },
    {
      label: "mgmt.nav.planning",
      items: [
        { to: "/week", label: "mgmt.nav.week", icon: CalendarRange },
        { to: "/rundowns", label: "mgmt.nav.rundowns", icon: ClipboardList },
        { to: "/schedule", label: "mgmt.nav.schedule", icon: CalendarDays },
        { to: "/clocks", label: "mgmt.nav.clocks", icon: Clock3 },
        { to: "/blocks", label: "mgmt.nav.blocks", icon: Clapperboard },
        { to: "/ads", label: "mgmt.nav.ads", icon: Film },
        { to: "/media", label: "mgmt.nav.media", icon: FolderOpen },
        { to: "/categories", label: "mgmt.nav.categories", icon: Tags },
        { to: "/epg", label: "mgmt.nav.epg", icon: Newspaper },
        { to: "/graphics", label: "mgmt.nav.graphics", icon: Palette, minRole: "editor" },
      ],
    },
    {
      label: "mgmt.nav.setup",
      minRole: "admin",
      items: [
        { to: "/channels", label: "mgmt.nav.channels", icon: Tv },
        { to: "/devices", label: "mgmt.nav.devices", icon: Cable },
      ],
    },
  ],
  routes: [
    { path: "/", element: <Dashboard /> },
    { path: "/control", element: <ControlPage /> },
    { path: "/remote", element: <RemoteSourcesPage /> },
    { path: "/outputs", element: <OutputsPage /> },
    { path: "/schedule", element: <SchedulePage /> },
    { path: "/week", element: <WeekPage /> },
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
    { path: "/epg", element: <EpgPage /> },
    { path: "/graphics", element: <GraphicsPage /> },
    { path: "/channels", element: <ChannelsPage /> },
    { path: "/devices", element: <DevicesPage /> },
  ],
});
// Keeps the icon import list honest for tree shaking.
