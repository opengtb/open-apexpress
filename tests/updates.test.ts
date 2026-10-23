import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApexClient, parseContainers } from "../src/apex/client";
import { buildPlan } from "../src/core/planner";
import { runPlan, type RunEvent } from "../src/core/runner";
import { hubRef, pickNewer, rebuildFromApex, withTag } from "../src/core/updates";
import { startMockApex, type MockApex } from "../src/mock/apex-mock";
import type { CreateOptions } from "../src/recipes/types";
import { startServer } from "../src/server";

const dataDir = mkdtempSync(join(tmpdir(), "apx-data-"));
process.env.APEXPRESS_DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

describe("versions", () => {
  test("Docker Hub references", () => {
    expect(hubRef("eclipse-mosquitto:2")).toEqual({ repo: "library/eclipse-mosquitto", tag: "2" });
    expect(hubRef("koenkk/zigbee2mqtt:2.14.1")).toEqual({ repo: "koenkk/zigbee2mqtt", tag: "2.14.1" });
    expect(hubRef("docker.io/nginx")).toEqual({ repo: "library/nginx", tag: "latest" });
    expect(hubRef("ghcr.io/home-assistant/home-assistant:2026.1")).toBeUndefined();
    expect(withTag("koenkk/zigbee2mqtt:2.14.1", "2.14.2")).toBe("koenkk/zigbee2mqtt:2.14.2");
  });

  const tags = (...names: string[]) => names.map((name) => ({ name, arm64: !name.includes("amd") }));

  test("newer tag of the same shape and major, higher major apart", () => {
    expect(pickNewer("2.14.1", tags("latest", "2", "2.14", "2.14.2", "2.15.0", "2.15.0-rc1", "3.0.0", "2.14.0"))).toEqual({ newer: "2.15.0", major: "3.0.0" });
    expect(pickNewer("v1.13.1", tags("v1.13.2", "1.14.0", "v2.0.0"))).toEqual({ newer: "v1.13.2", major: "v2.0.0" });
    expect(pickNewer("14-alpine", tags("14-alpine", "15-alpine", "17-alpine", "17"))).toEqual({ newer: undefined, major: "17-alpine" });
    expect(pickNewer("2", tags("2", "2.0.22", "3"))).toEqual({ newer: undefined, major: "3" });
    expect(pickNewer("stable", tags("stable", "1.80.0"))).toEqual({});
    expect(pickNewer("4.1", tags("4.2-amd64-only"))).toEqual({ newer: undefined, major: undefined });
  });
});

/** `command` as the APEX lists it: entrypoint and arguments joined, arguments with spaces in naive single quotes. */
const dockerCommand = (imageEntrypoint: string[], o: CreateOptions) =>
  [...(o.Entrypoint ?? imageEntrypoint), ...(o.Cmd ?? [])].map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" ");

/** A container as the APEX lists it (same fields as a real ECLYPSE APEX answer). */
function listed(name: string, o: CreateOptions, imageEntrypoint: string[] = []) {
  const ports = Object.entries(o.HostConfig?.PortBindings ?? {}).flatMap(([p, b]) => b.flatMap((x) => [`0.0.0.0:${x.HostPort}->${p}`, `:::${x.HostPort}->${p}`]));
  const raw = {
    [name]: {
      key: name,
      image: o.Image,
      "port-bindings": ports,
      mounts: (o.HostConfig?.Mounts ?? []).map((m) => `type=volume,src=${m.Source},dst=${m.Target}`),
      state: "running",
      command: dockerCommand(imageEntrypoint, o),
      "image-id": "sha256:aaa",
    },
  };
  return parseContainers(raw)[0]!;
}

describe("rebuild from what the APEX lists", () => {
  const plan = buildPlan({
    selection: {
      mosquitto: {},
      zigbee2mqtt: { coordinatorHost: "192.168.1.50" },
      cloudflared: { token: "eyJhIjoiZGVtbyJ9" },
      tailscale: { authKey: "tskey-auth-demo" },
      filebrowser: {},
      chirpstack: {},
    },
    apexIp: "192.168.1.49",
  });
  const options = (name: string) => plan.containers.find((c) => c.name === name)!.options;

  test.each([
    ["mosquitto", ["/docker-entrypoint.sh"]],
    ["zigbee2mqtt", ["docker-entrypoint.sh"]],
    ["cloudflared", ["cloudflared", "--no-autoupdate"]],
    ["filebrowser", ["tini", "--", "/init.sh"]],
    ["chirpstack", ["/usr/bin/chirpstack"]],
    ["chirpstack-gateway-bridge", ["/usr/bin/chirpstack-gateway-bridge"]],
  ])("%s is recreated identically", (name, entrypoint) => {
    const r = rebuildFromApex(listed(name, options(name), entrypoint));
    expect(r.ok).toBe(true);
    expect(r.ok && r.options).toEqual(options(name));
  });

  test("the real Mosquitto line of an APEX", () => {
    const info = parseContainers({
      mosquitto: {
        key: "mosquitto",
        image: "eclipse-mosquitto:2",
        "port-bindings": ["0.0.0.0:50083->1883/tcp"],
        mounts: ["type=volume,src=mosquitto-data,dst=/mosquitto/data"],
        state: "running",
        command:
          "/docker-entrypoint.sh sh -c 'mkdir -p '/mosquitto/config' && printf '%s\\n' 'listener 1883\nallow_anonymous true\npersistence true\npersistence_location /mosquitto/data/\nconnection_messages true\nlog_dest stdout' > '/mosquitto/config/mosquitto.conf' && exec mosquitto -c /mosquitto/config/mosquitto.conf'",
        "image-id": "sha256:4c199d7c9d377d018313a2199f6839978f6fd2219c405ad664d0a830c14b9c7b",
      },
    })[0]!;
    expect(info.imageId).toStartWith("sha256:4c199d7c");
    const r = rebuildFromApex(info);
    const before = buildPlan({ selection: { mosquitto: { websockets: false } }, apexIp: "192.168.1.49" }).containers[0]!.options;
    expect(r.ok && r.options).toEqual(before);
  });

  test("containers that need environment variables are not guessed", () => {
    const r = rebuildFromApex(listed("tailscale", options("tailscale")));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason.fr).toContain("réinstallez");
    expect(rebuildFromApex(listed("my-app", options("mosquitto"))).ok).toBe(false);
  });
});

let mock: MockApex | undefined;
afterEach(() => mock?.stop());

describe("update run", () => {
  const fast = { pollMs: 20, checkSeconds: 1, pullTimeoutSec: 5 };
  async function deployed(republished: string[] = []) {
    mock = startMockApex({ pullDelayMs: 40, republished });
    const client = new ApexClient({ host: mock.host, username: "admin", password: "admin", scheme: "http" });
    const plan = buildPlan({ selection: { mosquitto: {} }, apexIp: "192.168.1.2" });
    expect(await runPlan(client, plan, () => undefined, fast)).toBe(true);
    return { client, options: plan.containers[0]!.options };
  }
  const update = (options: CreateOptions, image: string, previousId: string) =>
    ({
      apexIp: "192.168.1.2",
      recipes: [],
      issues: [],
      ramMb: 0,
      ok: true,
      containers: [{ name: "mosquitto", recipeId: "mosquitto", action: "replace" as const, issues: [], options: { ...options, Image: image }, update: { previousImage: options.Image, previousId } }],
    });

  test("new tag: pulled before the old container is removed, old image deleted", async () => {
    const { client, options } = await deployed();
    const before = (await client.listContainers())[0]!;
    const events: RunEvent[] = [];
    expect(await runPlan(client, update(options, "eclipse-mosquitto:2.0.22", before.imageId!), (e) => events.push(e), fast)).toBe(true);
    const phases = events.flatMap((e) => (e.type === "step" && e.status === "running" ? [e.phase] : []));
    expect(phases.indexOf("pull")).toBeLessThan(phases.indexOf("remove"));
    expect(phases).toContain("cleanup");
    expect((await client.listContainers())[0]).toMatchObject({ image: "eclipse-mosquitto:2.0.22", state: "running" });
    expect(await client.listImages()).not.toContain("eclipse-mosquitto:2");
  });

  test("same tag republished: waits for the new build, the container runs it", async () => {
    const { client, options } = await deployed(["eclipse-mosquitto:2"]);
    const before = (await client.listContainers())[0]!;
    expect(await runPlan(client, update(options, "eclipse-mosquitto:2", before.imageId!), () => undefined, fast)).toBe(true);
    const after = (await client.listContainers())[0]!;
    expect(after.imageId).toBeDefined();
    expect(after.imageId).not.toBe(before.imageId);
  });

  test("failed download: the running service is not touched", async () => {
    const { client, options } = await deployed();
    const events: RunEvent[] = [];
    const ok = await runPlan(client, update(options, "doesnotexist/mosquitto:9", "sha256:x"), (e) => events.push(e), fast);
    expect(ok).toBe(false);
    expect(events.some((e) => e.type === "step" && e.phase === "remove")).toBe(false);
    expect((await client.listContainers())[0]).toMatchObject({ image: "eclipse-mosquitto:2", state: "running" });
  });
});

describe("update through the server", () => {
  test("remembered configuration, new image, web links kept", async () => {
    const server = startServer({ runOptions: { pollMs: 30, checkSeconds: 1, webCheckSeconds: 0 } });
    const base = server.url.slice(0, server.url.indexOf("/?"));
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "x-apexpress-token": server.token, "Content-Type": "application/json" } });
      return { status: res.status, data: (await res.json()) as any };
    };
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 400 && !(await check()); i++) await Bun.sleep(50);
    };
    try {
      await call("POST", "/api/demo");
      await call("POST", "/api/deploy", { selection: { mosquitto: { auth: true, password: "S3cret" } } });
      let r: Awaited<ReturnType<typeof call>>;
      await until(async () => (r = await call("POST", "/api/containers/mosquitto/update", { image: "eclipse-mosquitto:2.0.22" })).status !== 409);
      expect(r!.status).toBe(200);
      // The password is only in the remembered command, not in what the APEX lists.
      expect(r!.data.plan.containers[0].options.Cmd.join(" ")).toContain("'S3cret'");
      await until(async () => (await call("GET", "/api/apex")).data.containers.some((c: any) => c.image === "eclipse-mosquitto:2.0.22" && c.state === "running"));
      const after = (await call("GET", "/api/apex")).data;
      expect(after.containers.map((c: any) => [c.name, c.image])).toEqual([["mosquitto", "eclipse-mosquitto:2.0.22"]]);
      let missing: Awaited<ReturnType<typeof call>>;
      await until(async () => (missing = await call("POST", "/api/containers/nope/update", { image: "x:1" })).status !== 409);
      expect(missing!.status).toBe(404);
    } finally {
      server.stop();
    }
  }, 60_000);
});
