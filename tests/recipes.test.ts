import { describe, expect, test } from "bun:test";
import { lintContainer } from "../src/apex/opa";
import { containerLinks, containerOtherPorts } from "../src/core/links";
import { buildPlan, resolveOrder } from "../src/core/planner";
import { PACKS, RECIPES } from "../src/recipes/catalog";

const REQUIRED: Record<string, Record<string, string>> = {
  zigbee2mqtt: { coordinatorHost: "192.168.1.11" },
  cloudflared: { token: "eyJhIjoiZGVtbyJ9" },
  tailscale: { authKey: "tskey-auth-demo" },
  mcp: { apexUser: "mcp", apexPassword: "S3cret" },
};

const selectionFor = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, REQUIRED[id] ?? {}]));

describe("catalog", () => {
  test("recipe ids, names and params are unique and complete", () => {
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
    for (const r of RECIPES) {
      expect(r.summary.fr && r.summary.en && r.description.fr && r.description.en).toBeTruthy();
      expect(new Set(r.params.map((p) => p.id)).size).toBe(r.params.length);
      for (const p of r.params) expect(p.label.fr && p.label.en).toBeTruthy();
      for (const dep of r.requires ?? []) expect(RECIPES.some((x) => x.id === dep)).toBe(true);
    }
  });

  test("packs only reference existing recipes", () => {
    for (const p of PACKS) for (const id of p.recipes) expect(RECIPES.some((r) => r.id === id)).toBe(true);
  });

  test.each(RECIPES.map((r) => [r.id]))("%s builds containers that pass the OPA lint with defaults", (id) => {
    const plan = buildPlan({ selection: selectionFor([id]), apexIp: "192.168.1.2" });
    expect(plan.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(plan.ok).toBe(true);
    for (const c of plan.containers) {
      expect(c.name).toMatch(/^[a-z0-9][a-z0-9_.-]*$/);
      expect(c.options.HostConfig?.CpusetCpus).toBe("0");
      expect(lintContainer(c.name, c.options).filter((i) => i.level === "error")).toEqual([]);
    }
  });
});

describe("planner", () => {
  test("adds dependencies first and keeps the portal last", () => {
    const order = resolveOrder(["portal", "telegraf", "zigbee2mqtt"]).map((o) => o.id);
    expect(order[0]).toBe("mosquitto");
    expect(order.indexOf("influxdb")).toBeLessThan(order.indexOf("telegraf"));
    expect(order.at(-1)).toBe("portal");
    expect(resolveOrder(["telegraf"]).find((o) => o.id === "mosquitto")?.autoAdded).toBe(true);
  });

  test("every recipe together: no port or name conflict", () => {
    const plan = buildPlan({ selection: selectionFor(RECIPES.map((r) => r.id)), apexIp: "10.0.0.5" });
    expect(plan.issues.filter((i) => i.level === "error")).toEqual([]);
    const ports = plan.containers.flatMap((c) => Object.values(c.options.HostConfig?.PortBindings ?? {}).flat().map((b) => b.HostPort));
    expect(new Set(ports).size).toBe(ports.length);
  });

  test("required parameters are reported", () => {
    const plan = buildPlan({ selection: { zigbee2mqtt: {} }, apexIp: "192.168.1.2" });
    expect(plan.ok).toBe(false);
    expect(plan.issues.some((i) => i.code === "required")).toBe(true);
  });

  test("port conflicts between recipes are detected", () => {
    const plan = buildPlan({ selection: { nodered: { hostPort: 50083 }, mosquitto: {} }, apexIp: "192.168.1.2" });
    expect(plan.issues.some((i) => i.code === "port-conflict")).toBe(true);
  });

  test("host ports outside the OPA range are errors", () => {
    const plan = buildPlan({ selection: { nodered: { hostPort: 1880 } }, apexIp: "192.168.1.2" });
    expect(plan.issues.some((i) => i.code === "host-port")).toBe(true);
  });

  test("secrets are generated once and reused by dependents", () => {
    const plan = buildPlan({ selection: selectionFor(["mosquitto", "zigbee2mqtt", "telegraf", "grafana"]), apexIp: "192.168.1.2" });
    const mosq = plan.recipes.find((r) => r.id === "mosquitto")!;
    expect(mosq.values.password).toMatch(/^[A-Za-z0-9]{16}$/);
    const influx = plan.recipes.find((r) => r.id === "influxdb")!;
    expect(influx.values.token).toMatch(/^[A-Za-z0-9]{40}$/);
    const telegrafCmd = plan.containers.find((c) => c.name === "telegraf")!.options.Cmd!.join(" ");
    expect(telegrafCmd).toContain(String(influx.values.token));
    const grafanaCmd = plan.containers.find((c) => c.name === "grafana")!.options.Cmd!.join(" ");
    expect(grafanaCmd).toContain("http://192.168.1.2:50086");
  });

  test("mosquitto authentication propagates to its clients", () => {
    const plan = buildPlan({
      selection: { mosquitto: { auth: true, user: "gtb", password: "S3cret" }, ...selectionFor(["zigbee2mqtt", "chirpstack"]) },
      apexIp: "192.168.1.2",
    });
    const mosq = plan.containers.find((c) => c.name === "mosquitto")!.options.Cmd!.join(" ");
    expect(mosq).toContain("mosquitto_passwd -b -c /mosquitto/config/passwd 'gtb' 'S3cret'");
    expect(mosq).toContain("allow_anonymous false");
    const z2m = plan.containers.find((c) => c.name === "zigbee2mqtt")!.options.Cmd!.join(" ");
    expect(z2m).toContain('user: "gtb"');
    const init = plan.containers.find((c) => c.name === "chirpstack-init")!.options.Cmd!.join(" ");
    expect(init).toContain('username="gtb"');
  });

  test("existing containers are kept or replaced", () => {
    const existing = { containers: [{ name: "mosquitto", state: "running", hostPorts: [50083], raw: {} }] };
    const keep = buildPlan({ selection: { mosquitto: {} }, apexIp: "1.2.3.4", existing });
    expect(keep.containers[0]!.action).toBe("keep");
    const replace = buildPlan({ selection: { mosquitto: {} }, apexIp: "1.2.3.4", existing, onExisting: "replace" });
    expect(replace.containers[0]!.action).toBe("replace");
    const taken = buildPlan({
      selection: { nodered: { hostPort: 50083 } },
      apexIp: "1.2.3.4",
      existing,
    });
    expect(taken.issues.some((i) => i.code === "port-taken")).toBe(true);
  });

  test("the portal page lists the other services", () => {
    const plan = buildPlan({ selection: selectionFor(["portal", "nodered", "grafana"]), apexIp: "192.168.1.2" });
    const cmd = plan.containers.find((c) => c.name === "portal")!.options.Cmd!.join(" ");
    expect(cmd).toContain("http://192.168.1.2:50080");
    expect(cmd).toContain("Grafana");
    expect(cmd).toContain("daemon off;");
  });

  test("Node-RED password produces a bcrypt hash and preinstalls modules", () => {
    const plan = buildPlan({
      selection: { nodered: { adminPassword: "secret", modules: "@flowfuse/node-red-dashboard\nnode-red-contrib-bacnet; rm -rf /" } },
      apexIp: "192.168.1.2",
    });
    const c = plan.containers[0]!;
    const cmd = c.options.Cmd!.join(" ");
    expect(c.options.Entrypoint).toEqual(["sh", "-c"]);
    expect(cmd).toMatch(/\$2a\$08\$/);
    expect(cmd).toContain("npm install --no-audit --no-fund --omit=dev @flowfuse/node-red-dashboard");
    expect(cmd).not.toContain("rm -rf");
    expect(cmd).toContain("exec ./entrypoint.sh");
  });
});

describe("MQTT Web", () => {
  const existing = (hostPorts: number[]) => ({ containers: [{ name: "mosquitto", state: "running", hostPorts, raw: {} }] });

  test("Mosquitto publishes a WebSocket listener for the browser client", () => {
    const plan = buildPlan({ selection: { mqttweb: {} }, apexIp: "192.168.1.2" });
    const mosquitto = plan.containers.find((c) => c.name === "mosquitto")!;
    expect(mosquitto.options.Cmd!.join(" ")).toContain("listener 9001\nprotocol websockets");
    expect(mosquitto.options.HostConfig!.PortBindings!["9001/tcp"]).toEqual([{ HostPort: "50085" }]);
    expect(plan.recipes.find((r) => r.id === "mqttweb")!.notes[0]!.fr).toContain("ws:// 192.168.1.2, port 50085 (pas 50083)");
  });

  test("a kept Mosquitto without the WebSocket port gets a warning", () => {
    const old = buildPlan({ selection: { mqttweb: {} }, apexIp: "192.168.1.2", existing: existing([50083]) });
    expect(old.issues.map((i) => i.code)).toContain("mosquitto-ws");
    const recent = buildPlan({ selection: { mqttweb: {} }, apexIp: "192.168.1.2", existing: existing([50083, 50085]) });
    expect(recent.issues.map((i) => i.code)).not.toContain("mosquitto-ws");
    const replaced = buildPlan({ selection: { mqttweb: {} }, apexIp: "192.168.1.2", existing: existing([50083]), onExisting: "replace" });
    expect(replaced.issues.map((i) => i.code)).not.toContain("mosquitto-ws");
  });

  test("a kept service does not show the freshly generated credentials, which are not applied", () => {
    const running = { containers: [{ name: "mcp", image: "node:22-alpine", state: "running", hostPorts: [50089], raw: {} }] };
    const selection = { mcp: { apexUser: "mcp", apexPassword: "S3cret" } };
    const kept = buildPlan({ selection, apexIp: "192.168.1.2", existing: running }).recipes[0]!;
    expect(kept.credentials).toEqual([]);
    expect(kept.notes[0]!.fr).toContain("Le remplacer");
    const replaced = buildPlan({ selection, apexIp: "192.168.1.2", existing: running, onExisting: "replace" }).recipes[0]!;
    expect(replaced.credentials.length).toBeGreaterThan(0);
  });
});

describe("links of the containers on the APEX", () => {
  const c = (name: string, hostPorts: number[], image?: string) => ({ name, image, state: "running", hostPorts, raw: {} });
  const urls = (x: ReturnType<typeof c>) => containerLinks("192.168.1.49", x).map((l) => l.url);

  test("recognized by name or image, on the real port", () => {
    expect(urls(c("zigbee2mqtt", [50084]))).toEqual(["http://192.168.1.49:50084"]);
    expect(urls(c("z2m-site", [50184], "koenkk/zigbee2mqtt:2.1.0"))).toEqual(["http://192.168.1.49:50184"]);
    expect(urls(c("nodered", []))).toEqual(["http://192.168.1.49:50080"]);
    expect(urls(c("web", [50060], "nginx:alpine"))).toEqual([]);
  });

  test("MQTT ports are not web links but are labelled", () => {
    const m = c("mosquitto", [50083, 50085]);
    expect(urls(m)).toEqual([]);
    expect(Object.keys(containerOtherPorts("192.168.1.49", m))).toEqual(["50083", "50085"]);
  });

  test("multi-container recipes only link the container that publishes the port", () => {
    expect(urls(c("chirpstack", [50081]))).toEqual(["http://192.168.1.49:50081"]);
    expect(urls(c("chirpstack-postgres", [50432]))).toEqual([]);
  });
});
