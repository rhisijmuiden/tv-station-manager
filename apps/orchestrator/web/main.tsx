import "@tvsm/ui/styles.css";
import { mountPlatformApp } from "@tvsm/ui";
import { LayoutDashboard, Server } from "lucide-react";
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
      ],
    },
  ],
  routes: [
    { path: "/", element: <Dashboard /> },
    { path: "/nodes", element: <NodesPage /> },
  ],
});
