import { AGENT_API, fingerprintOf, type CommandResult, type EnrollResponse, type HeartbeatRequest, type HeartbeatResponse } from "@tvsm/platform/agent-protocol";
import { execute } from "./commands.js";
import { AGENT_VERSION, configPath, readConfig, writeConfig, type AgentConfig } from "./config.js";
import { facts, metrics } from "./metrics.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post<T>(cfg: AgentConfig, path: string, body: unknown, auth = true): Promise<{ status: number; data: T }> {
  const res = await fetch(new URL(`${AGENT_API}${path}`, cfg.orchestratorUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `tvsm-agent/${AGENT_VERSION}`,
      ...(auth && cfg.nodeId ? { Authorization: `Bearer ${cfg.nodeId}:${cfg.secret}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

async function enroll(url: string) {
  const orchestratorUrl = new URL(url).toString();
  const cfg: AgentConfig = { orchestratorUrl };
  const r = await post<EnrollResponse>(cfg, "/enroll", facts(), false);
  if (r.status !== 200) throw new Error(`Enrollment failed (${r.status}): ${JSON.stringify(r.data)}`);
  writeConfig({ orchestratorUrl, ...r.data });
  console.log(`Enrolled with ${orchestratorUrl}`);
  console.log(`Node ID:     ${r.data.nodeId}`);
  console.log(`Fingerprint: ${r.data.fingerprint}`);
  console.log("Approve this node in the orchestrator (Nodes) and check that the fingerprint matches.");
}

async function runLoop() {
  let interval = 10;
  let pendingResults: CommandResult[] = [];
  let failures = 0;
  log(`tvsm-agent ${AGENT_VERSION} starting, config ${configPath()}`);
  for (;;) {
    const cfg = readConfig();
    if (!cfg?.nodeId) {
      log("Not enrolled yet. Run: tvsm-agent enroll <orchestrator-url>");
      await sleep(30_000);
      continue;
    }
    try {
      const body: HeartbeatRequest = { ...facts(), metrics: await metrics(), results: pendingResults };
      const r = await post<HeartbeatResponse>(cfg, "/heartbeat", body);
      if (r.status === 401) {
        log("Orchestrator does not know this node any more (removed?). Re-enroll with: tvsm-agent enroll <url>");
        await sleep(60_000);
        continue;
      }
      if (r.status !== 200) throw new Error(`heartbeat ${r.status}`);
      pendingResults = [];
      failures = 0;
      const hb = r.data;
      if (hb.status === "pending") {
        interval = hb.intervalSeconds;
        log(`Waiting for approval in the orchestrator (fingerprint ${cfg.fingerprint ?? (await fingerprintOf(cfg.secret!))})`);
      } else if (hb.status === "rejected") {
        log("This node was rejected by the orchestrator.");
        interval = 300;
      } else {
        interval = hb.intervalSeconds;
        const afters: (() => void)[] = [];
        for (const cmd of hb.commands) {
          log(`Command ${cmd.id}: ${cmd.type}`);
          const { result, after } = await execute(cmd, hb.update);
          pendingResults.push(result);
          if (after) afters.push(after);
        }
        if (afters.length) {
          // Report results first, then restart/reboot.
          await post(cfg, "/heartbeat", { ...facts(), metrics: await metrics(), results: pendingResults }).catch(() => undefined);
          pendingResults = [];
          afters.forEach((f) => f());
        }
      }
    } catch (err) {
      failures++;
      log(`Cannot reach orchestrator: ${(err as Error).message}`);
    }
    await sleep(Math.min(interval * 1000 * 2 ** Math.min(failures, 3), 120_000));
  }
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "enroll":
    if (!arg) {
      console.error("Usage: tvsm-agent enroll <orchestrator-url>   e.g. tvsm-agent enroll http://10.40.6.201:8080");
      process.exit(1);
    }
    await enroll(arg).catch((e) => {
      console.error((e as Error).message);
      process.exit(1);
    });
    break;
  case "status": {
    const cfg = readConfig();
    console.log(cfg ? { orchestrator: cfg.orchestratorUrl, nodeId: cfg.nodeId, fingerprint: cfg.fingerprint, version: AGENT_VERSION } : "Not enrolled");
    break;
  }
  case "version":
    console.log(AGENT_VERSION);
    break;
  case "run":
  case undefined:
    await runLoop();
    break;
  default:
    console.error("Usage: tvsm-agent [run|enroll <url>|status|version]");
    process.exit(1);
}
