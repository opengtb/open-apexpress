import { afterEach, describe, expect, test } from "bun:test";
import { ApexClient, ApexError, parseContainers, parseImages } from "../src/apex/client";
import { buildPlan } from "../src/core/planner";
import { runPlan, type RunEvent } from "../src/core/runner";
import { startMockApex, type MockApex } from "../src/mock/apex-mock";

let mock: MockApex | undefined;
afterEach(() => mock?.stop());

const fast = { pollMs: 30, checkSeconds: 1, pullTimeoutSec: 5, oneShotTimeoutSec: 5 };

function setup(opts: Parameters<typeof startMockApex>[0] = {}) {
  mock = startMockApex({ pullDelayMs: 50, oneShotMs: 50, ...opts });
  const client = new ApexClient({ host: mock.host, username: mock.username, password: mock.password, scheme: "http" });
  return { mock, client };
}

async function deploy(client: ApexClient, plan: ReturnType<typeof buildPlan>, extra = {}) {
  const events: RunEvent[] = [];
  const ok = await runPlan(client, plan, (e) => events.push(e), { ...fast, ...extra });
  return { ok, events, done: events.find((e) => e.type === "done") as Extract<RunEvent, { type: "done" }> };
}

describe("client", () => {
  test("wrong credentials give an auth error", async () => {
    const { mock } = setup();
    const bad = new ApexClient({ host: mock.host, username: "x", password: "y", scheme: "http" });
    const err = await bad.listContainers().catch((e) => e);
    expect(err).toBeInstanceOf(ApexError);
    expect((err as ApexError).kind).toBe("auth");
  });

  test("unreachable host gives a network or timeout error", async () => {
    const c = new ApexClient({ host: "127.0.0.1:1", username: "a", password: "b", scheme: "http", timeoutMs: 2000 });
    const err = (await c.listContainers().catch((e) => e)) as ApexError;
    expect(["network", "timeout"]).toContain(err.kind);
  });

  test.skipIf(process.platform === "win32")("https with a self-signed certificate is accepted", async () => {
    const dir = `${import.meta.dir}/../.tmp-cert`;
    await Bun.$`mkdir -p ${dir} && openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/key.pem -out ${dir}/cert.pem -days 1 -subj /CN=apex-test`.quiet();
    mock = startMockApex({ tls: { cert: await Bun.file(`${dir}/cert.pem`).text(), key: await Bun.file(`${dir}/key.pem`).text() } });
    const client = new ApexClient({ host: mock.host, username: "admin", password: "admin" });
    expect(await client.listContainers()).toEqual([]);
    await Bun.$`rm -rf ${dir}`;
  });

  test("tolerant parsers accept several response shapes", () => {
    expect(parseContainers([{ Names: ["/web"], State: "running", Image: "nginx", Ports: [{ PublicPort: 50001 }] }])[0]).toMatchObject({
      name: "web",
      state: "running",
      hostPorts: [50001],
    });
    expect(parseContainers({ containers: { db: { state: { Status: "exited" } } } })[0]).toMatchObject({ name: "db", state: "exited" });
    expect(parseImages([{ RepoTags: ["redis:7-alpine"] }, { "repo-tags": ["eclipse-mosquitto:2"] }])).toEqual(["redis:7-alpine", "eclipse-mosquitto:2"]);
    expect(parseImages({ "nodered/node-red:4.1": { size: 1 } })).toContain("nodered/node-red:4.1");
  });
});

describe("runner", () => {
  test("deploys the full LoRaWAN pack on the simulated APEX", async () => {
    const { mock, client } = setup();
    const plan = buildPlan({ selection: { mosquitto: {}, chirpstack: {}, nodered: {} }, apexIp: "192.168.1.2" });
    expect(plan.ok).toBe(true);
    const { ok, done, events } = await deploy(client, plan);
    expect(ok).toBe(true);
    expect(done.counts.error).toBe(0);
    const names = [...mock.state.containers.keys()];
    expect(names).toContain("chirpstack");
    expect(names).toContain("chirpstack-gateway-bridge");
    expect(names).not.toContain("chirpstack-init"); // one-shot removed after completion
    expect(mock.state.volumes.has("chirpstack-config")).toBe(true);
    expect([...mock.state.containers.values()].every((c) => c.state === "running")).toBe(true);
    // The init container ran before ChirpStack was created.
    const creates = mock.state.requests.filter((r) => r.path.endsWith("create-container")).map((r) => r.body.name);
    expect(creates.indexOf("chirpstack-init")).toBeLessThan(creates.indexOf("chirpstack"));
    expect(events.some((e) => e.type === "step" && e.phase === "pull")).toBe(true);
  });

  test("every recipe deploys together", async () => {
    const { mock, client } = setup();
    const { RECIPES } = await import("../src/recipes/catalog");
    const required: Record<string, Record<string, string>> = {
      zigbee2mqtt: { coordinatorHost: "192.168.1.11" },
      cloudflared: { token: "x" },
      tailscale: { authKey: "y" },
    };
    const plan = buildPlan({ selection: Object.fromEntries(RECIPES.map((r) => [r.id, required[r.id] ?? {}])), apexIp: "192.168.1.2" });
    const { ok, done } = await deploy(client, plan);
    expect(done.counts).toMatchObject({ error: 0, warning: 0 });
    expect(ok).toBe(true);
    expect(mock.state.containers.size).toBe(plan.containers.filter((c) => !c.oneShot).length);
  });

  test("a second run keeps existing containers", async () => {
    const { client } = setup();
    const first = buildPlan({ selection: { mosquitto: {} }, apexIp: "192.168.1.2" });
    await deploy(client, first);
    const existing = { containers: await client.listContainers() };
    const second = buildPlan({ selection: { mosquitto: {}, nodered: {} }, apexIp: "192.168.1.2", existing });
    expect(second.containers.find((c) => c.name === "mosquitto")!.action).toBe("keep");
    const { ok, done } = await deploy(client, second);
    expect(ok).toBe(true);
    expect(done.counts).toMatchObject({ ok: 1, skipped: 1 });
  });

  test("replace recreates an existing container", async () => {
    const { mock, client } = setup({ seed: [{ name: "nodered", image: "nodered/node-red:3.1" }] });
    const plan = buildPlan({
      selection: { nodered: {} },
      apexIp: "192.168.1.2",
      existing: { containers: await client.listContainers() },
      onExisting: "replace",
    });
    const { ok } = await deploy(client, plan);
    expect(ok).toBe(true);
    expect(mock.state.containers.get("nodered")!.image).toBe("nodered/node-red:4.1");
  });

  test("an OPA rejection stops the deployment with a clear message", async () => {
    const { client } = setup();
    const plan = buildPlan({ selection: { mosquitto: {}, nodered: {} }, apexIp: "192.168.1.2" });
    delete plan.containers[0]!.options.HostConfig!.CpusetCpus; // simulate a bad recipe
    const { ok, done, events } = await deploy(client, plan);
    expect(ok).toBe(false);
    expect(done.counts).toMatchObject({ error: 1, skipped: 1 });
    const err = events.find((e) => e.type === "step" && e.status === "error") as Extract<RunEvent, { type: "step" }>;
    expect(err.message!.fr).toContain("OPA");
  });

  test("a crashing container is reported as a warning", async () => {
    const { client } = setup();
    const plan = buildPlan({ selection: { nodered: { image: "acme/crash-loop:1" } }, apexIp: "192.168.1.2" });
    const { done } = await deploy(client, plan);
    expect(done.counts.warning).toBe(1);
  });

  test("a missing image fails at pull time", async () => {
    const { client } = setup();
    const plan = buildPlan({ selection: { nodered: { image: "acme/doesnotexist:1" } }, apexIp: "192.168.1.2" });
    const { ok, done } = await deploy(client, plan);
    expect(ok).toBe(false);
    expect(done.counts.error).toBe(1);
  });

  test("the deployment can be cancelled", async () => {
    const { client } = setup({ pullDelayMs: 400 });
    const plan = buildPlan({ selection: { mosquitto: {}, nodered: {}, grafana: {} }, apexIp: "192.168.1.2" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const { ok, done } = await deploy(client, plan, { signal: controller.signal });
    expect(ok).toBe(false);
    expect(done.cancelled).toBe(true);
    expect(done.counts.skipped).toBeGreaterThan(0);
  });

  test("a running container whose web UI never answers is a warning", async () => {
    const { client } = setup();
    // FileBrowser publishes 50477 on 127.0.0.1: nothing listens there until we start a server.
    const plan = buildPlan({ selection: { filebrowser: { hostPort: 50477 } }, apexIp: "127.0.0.1" });
    const silent = await deploy(client, plan, { webCheckSeconds: 1 });
    expect(silent.done.counts.warning).toBe(1);
    const warning = silent.events.find((e) => e.type === "step" && e.phase === "done");
    expect(warning).toMatchObject({ status: "warning" });

    const web = Bun.serve({ port: 50477, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try {
      const { client: again } = setup();
      const answered = await deploy(again, plan, { webCheckSeconds: 2 });
      expect(answered.done.counts.ok).toBe(1);
    } finally {
      web.stop(true);
    }
  });
});
