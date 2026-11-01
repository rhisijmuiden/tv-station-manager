import type { Platform, PlatformOptions } from "@tvsm/platform";
import { join } from "node:path";
import { registerContent } from "./content.js";
import { MANAGEMENT_MIGRATIONS } from "./db.js";
import { DeviceHub, registerDevices } from "./devices.js";
import { Director } from "./director.js";
import { realDrivers, type DriverFactory } from "./drivers.js";
import { registerEpgAndGraphics } from "./epg.js";
import { registerMedia } from "./media.js";
import { registerOutputs, StreamOutputs } from "./outputs.js";
import { Recorder, registerRecordings } from "./recorder.js";
import { RemoteSources } from "./remote.js";
import { RssFeeds, registerRss } from "./rss.js";
import { VisualRadio, registerVisualRadio } from "./visualradio.js";
import { WeekPlanner, registerWeek } from "./weekplan.js";

export interface ManagementHandles {
  hub: DeviceHub;
  director: Director;
  remote: RemoteSources;
  outputs: StreamOutputs;
  planner: WeekPlanner;
  visualRadio: VisualRadio;
  rss: RssFeeds;
  recorder: Recorder;
}

/** Platform options for the management node. `drivers` can be replaced in tests. */
export function managementOptions(opts: { webDir?: string; drivers?: DriverFactory; autostart?: boolean; onReady?: (h: ManagementHandles) => void } = {}): PlatformOptions {
  return {
    app: { id: "management", name: "TV Station Manager", defaultPort: 8080 },
    webDir: opts.webDir,
    migrations: MANAGEMENT_MIGRATIONS,
    backupSources: (ctx) => ({ graphics: join(ctx.config.dataDir, "graphics") }),
    register: async (server, platform: Platform) => {
      const hub = new DeviceHub(platform, opts.drivers ?? realDrivers);
      const remote = new RemoteSources(platform, hub);
      const director = new Director(platform, hub, remote);
      const planner = new WeekPlanner(platform, () => director.invalidate());
      const visualRadio = new VisualRadio(platform, hub);
      director.yieldTo = (channelId) => visualRadio.owns(channelId);
      // Content changed (blocks, media, manual schedule): the director recompiles and the week schedule is published again.
      const changed = () => {
        director.invalidate();
        planner.requestPublish();
        recorder.invalidate();
      };
      const recorder = new Recorder(platform, remote, () => changed());
      const outputs = new StreamOutputs(platform, hub, remote);
      const rss = new RssFeeds(platform, changed);
      registerMedia(server, platform, changed);
      registerDevices(server, platform, hub, remote);
      registerContent(server, platform, changed);
      registerEpgAndGraphics(server, platform, changed);
      registerWeek(server, platform, planner);
      registerVisualRadio(server, platform, visualRadio, () => director.invalidate());
      director.register(server);
      registerOutputs(server, platform, outputs, hub);
      registerRss(server, platform, rss, changed);
      registerRecordings(server, platform, recorder);

      server.get("/api/management/overview", async () => {
        const { db } = platform.ctx;
        const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
        return {
          channels: n("SELECT COUNT(*) AS n FROM channels"),
          atems: [...hub.switchers.values()].map((s) => ({ name: s.name, ...s.driver.info(), inputs: undefined })),
          studios: [...hub.playouts.values()].map((p) => ({ name: p.name, host: p.host, ...p.driver.info() })),
          mediaSources: n("SELECT COUNT(*) AS n FROM media_sources"),
          mediaFiles: n("SELECT COUNT(*) AS n FROM media WHERE missing = 0"),
          blocks: n("SELECT COUNT(*) AS n FROM blocks"),
          upcomingEntries: (db.prepare("SELECT COUNT(*) AS n FROM schedule WHERE start_at > ?").get(new Date().toISOString()) as { n: number }).n,
          mailConfigured: platform.mail.getConfig().enabled,
          backupTargets: platform.backup.listTargets().length,
        };
      });

      await hub.reload();
      if (opts.autostart !== false) {
        director.start();
        remote.start();
        planner.start();
        visualRadio.start();
        rss.start();
        recorder.start();
      }
      server.addHook("onClose", async () => {
        planner.stop();
        recorder.stop();
        rss.stop();
        visualRadio.stop();
        director.stop();
        remote.stop();
        outputs.stop();
        await hub.close();
      });
      opts.onReady?.({ hub, director, remote, planner, outputs, visualRadio, rss, recorder });
    },
  };
}
