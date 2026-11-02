import "@tvsm/ui/styles.css";
import { mountPlatformApp } from "@tvsm/ui";
import { LayoutDashboard, Network, Server, SlidersHorizontal, Video } from "lucide-react";
import { AtemPage } from "./Atem";
import { Dashboard } from "./Dashboard";
import { DiagramPage } from "./Diagram";
import { HyperdeckPage } from "./Hyperdeck";
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
        { to: "/hyperdeck", label: "orch.nav.hyperdeck", icon: Video },
        { to: "/diagram", label: "orch.nav.diagram", icon: Network },
      ],
    },
  ],
  routes: [
    { path: "/", element: <Dashboard /> },
    { path: "/nodes", element: <NodesPage /> },
    { path: "/atem", element: <AtemPage /> },
    { path: "/atem/:id", element: <AtemPage /> },
    { path: "/hyperdeck", element: <HyperdeckPage /> },
    { path: "/hyperdeck/:id", element: <HyperdeckPage /> },
    { path: "/diagram", element: <DiagramPage /> },
  ],
});
