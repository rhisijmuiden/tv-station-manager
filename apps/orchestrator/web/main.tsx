import "@tvsm/ui/styles.css";
import { mountPlatformApp } from "@tvsm/ui";
import { Activity, ArrowLeftRight, LayoutDashboard, Network, Server, Repeat, SlidersHorizontal } from "lucide-react";
import { AtemPage } from "./Atem";
import { Dashboard } from "./Dashboard";
import { DiagramPage } from "./Diagram";
import { KiloviewPage } from "./Kiloview";
import { MonitoringPage } from "./Monitoring";
import { NodesPage } from "./Nodes";
import { TeranexPage } from "./Teranex";
import en from "./i18n/en.json";
import nl from "./i18n/nl.json";

mountPlatformApp({
  appName: "TV Station Orchestrator",
  translations: { en, nl },
  nav: [
    {
      items: [
        { to: "/", label: "nav.dashboard", icon: LayoutDashboard, end: true },
        { to: "/monitoring", label: "orch.nav.monitoring", icon: Activity },
        { to: "/nodes", label: "orch.nav.nodes", icon: Server },
        { to: "/atem", label: "orch.nav.atem", icon: SlidersHorizontal },
        { to: "/teranex", label: "orch.nav.teranex", icon: Repeat },
        { to: "/kiloview", label: "orch.nav.kiloview", icon: ArrowLeftRight },
        { to: "/diagram", label: "orch.nav.diagram", icon: Network },
      ],
    },
  ],
  routes: [
    { path: "/", element: <Dashboard /> },
    { path: "/monitoring", element: <MonitoringPage /> },
    { path: "/nodes", element: <NodesPage /> },
    { path: "/atem", element: <AtemPage /> },
    { path: "/atem/:id", element: <AtemPage /> },
    { path: "/teranex", element: <TeranexPage /> },
    { path: "/teranex/:id", element: <TeranexPage /> },
    { path: "/kiloview", element: <KiloviewPage /> },
    { path: "/kiloview/:id", element: <KiloviewPage /> },
    { path: "/diagram", element: <DiagramPage /> },
  ],
});
