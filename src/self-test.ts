import { ApexClient } from "./apex/client";
import { buildPlan } from "./core/planner";
import { renderReport } from "./core/report";
import { runPlan, type RunEvent } from "./core/runner";
import { startMockApex } from "./mock/apex-mock";
import { RECIPES } from "./recipes/catalog";
import { startServer } from "./server";

/**
 * End-to-end check of a built executable (used by CI on Windows):
 * deploy every recipe on the simulated APEX, then exercise the local HTTP server.
 */
export async function selfTest(): Promise<boolean> {
  const required: Record<string, Record<string, string>> = {
    zigbee2mqtt: { coordinatorHost: "192.168.1.11" },
    cloudflared: { token: "self-test" },
    tailscale: { authKey: "self-test" },
    mcp: { apexUser: "self-test", apexPassword: "self-test" },
  };
  const mock = startMockApex({ pullDelayMs: 50, oneShotMs: 50 });
  let ok = true;
  const check = (label: string, cond: boolean) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
    ok &&= cond;
  };
  try {
    const client = new ApexClient({ host: mock.host, username: mock.username, password: mock.password, scheme: "http" });
    const plan = buildPlan({ selection: Object.fromEntries(RECIPES.map((r) => [r.id, required[r.id] ?? {}])), apexIp: "192.168.1.2" });
    check("plan without errors", plan.ok);
    const events: RunEvent[] = [];
    const deployed = await runPlan(client, plan, (e) => events.push(e), { pollMs: 30, checkSeconds: 1 });
    check(`deployment of ${plan.containers.length} containers`, deployed);
    check("report generated", renderReport(plan, events, "fr", true).includes("Rapport de déploiement"));

    const server = startServer({ port: 0, runOptions: { pollMs: 50, checkSeconds: 1 } });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const headers = { "x-apexpress-token": server.token, "Content-Type": "application/json" };
      const home = await fetch(`${base}/`);
      check("interface served", home.ok && (await home.text()).includes("Open Apexpress"));
      check("API protected by token", (await fetch(`${base}/api/meta`)).status === 403);
      const meta = (await (await fetch(`${base}/api/meta`, { headers })).json()) as { recipes: unknown[] };
      check("recipes listed", meta.recipes.length === RECIPES.length);
      const demo = await fetch(`${base}/api/demo`, { method: "POST", headers });
      check("demo APEX connection", demo.ok);
    } finally {
      server.stop();
    }
  } catch (e) {
    console.error(e);
    ok = false;
  } finally {
    mock.stop();
  }
  console.log(ok ? "\nSelf-test OK" : "\nSelf-test FAILED");
  return ok;
}
