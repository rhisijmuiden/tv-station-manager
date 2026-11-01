import "@tvsm/ui/styles.css";
import { mountPlatformApp } from "@tvsm/ui";
import { LayoutDashboard, Server, SlidersHorizontal } from "lucide-react";
import { AtemPage } from "./Atem";
import { Dashboard } from "./Dashboard";
import { NodesPage } from "./Nodes";
import en from "./i18n/en.json";
import nl from "./i18n/nl.json";

mountPlatformApp({
  appName: "TV Station Orchestrator",
  translations: { en, nl },
  nav: [
    {
      items: [
        { to: "/", label: "nav.dashboard", icon: LayoutDashboard, end: true },
        { to: "/nodes", label: "orch.nav.nodes", icon: Server },
        { to: "/atem", label: "orch.nav.atem", icon: SlidersHorizontal },
      ],
    },
  ],
  routes: [
    { path: "/", element: <Dashboard /> },
    { path: "/nodes", element: <NodesPage /> },
    { path: "/atem", element: <AtemPage /> },
    { path: "/atem/:id", element: <AtemPage /> },
  ],
});
