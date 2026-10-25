import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerInfo } from "../src/apex/client";
import { lintContainer } from "../src/apex/opa";
import { backupCommand, freeHelperPort, helperOptions, restoreCommand, volumeUsers } from "../src/core/volumes";
import { startServer } from "../src/server";

const info = (name: string, state = "running", hostPorts: number[] = [], raw: unknown = {}): ContainerInfo => ({ name, state, hostPorts, raw });

describe("volume helpers", () => {
  test("helper containers pass the OPA rules", () => {
    expect(lintContainer("apexpress-backup", helperOptions("z2m-data", 50498, backupCommand("k")))).toEqual([]);
    expect(lintContainer("apexpress-restore", helperOptions("z2m-data", 50498, restoreCommand("k")))).toEqual([]);
  });

  test("a host port above 50500 is rejected by the linter", () => {
    const issues = lintContainer("apexpress-backup", helperOptions("z2m-data", 50501, backupCommand("k")));
    expect(issues.some((i) => i.level === "error")).toBe(true);
    expect(lintContainer("apexpress-backup", helperOptions("z2m-data", 50500, backupCommand("k")))).toEqual([]);
  });

  test("users of a volume come from the APEX answer, or from the catalog defaults", () => {
    const containers = [
      info("zigbee2mqtt"),
      info("custom", "running", [], { mounts: [{ source: "z2m-data" }] }),
      info("nodered"),
      info("old-z2m", "exited", [], { mounts: [{ source: "z2m-data" }] }),
      // Real APEX format.
      info("z2m-copy", "running", [], { mounts: ["type=volume,src=z2m-data,dst=/app/data"] }),
      info("other", "running", [], { mounts: ["type=volume,src=z2m-data-old,dst=/app/data"] }),
    ];
    expect(volumeUsers("z2m-data", containers)).toEqual(["zigbee2mqtt", "custom", "z2m-copy"]);
  });

  test("the helper port avoids ports already published", () => {
    expect(freeHelperPort([info("a", "running", [50498, 50497])])).toBe(50496);
  });
});

// Same trick as shell.test.ts: run the restore CGI script in Git Bash, inside a temporary root.
const BASH = process.platform === "win32" ? ["C:/Program Files/Git/bin/bash.exe"].find(existsSync) : Bun.which("bash");
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe.skipIf(!BASH)("restore script in a real shell", () => {
  const root = mkdtempSync(join(tmpdir(), "apx-rs-")).replaceAll("\\", "/");
  roots.push(root);
  // POSIX form of the root for the scripts: GNU tar reads "C:/…" as a remote host.
  const posix = root.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);
  const reroot = (s: string) => s.replace(/(^|[\s'"=>])\/(?=[A-Za-z_])/g, `$1${posix}/`).replaceAll(`${posix}/dev/null`, "/dev/null");
  const sh = (script: string, input?: Uint8Array) =>
    Bun.spawnSync([BASH!, "-c", script], { stdin: input ?? "ignore", env: { ...process.env, CONTENT_LENGTH: String(input?.length ?? 0) } });

  // Writes the CGI script; `exec httpd` is replaced by a no-op.
  sh(`mkdir -p ${posix}/tmp; ${reroot(restoreCommand("key")).replace("exec httpd", "true")}`);
  const cgi = `${posix}/www/cgi-bin/key`;
  const seed = () => {
    rmSync(`${root}/data`, { recursive: true, force: true });
    mkdirSync(`${root}/data/old`, { recursive: true });
    writeFileSync(`${root}/data/.old`, "x");
  };
  const archive = () => {
    mkdirSync(`${root}/src/sub`, { recursive: true });
    writeFileSync(`${root}/src/configuration.yaml`, "network_key: [1, 2]\n");
    writeFileSync(`${root}/src/sub/.hidden`, "h");
    sh(`cd ${posix}/src && tar czf ../a.tgz .`);
    return new Uint8Array(readFileSync(`${root}/a.tgz`));
  };

  test("a valid archive replaces the whole volume", () => {
    seed();
    const r = sh(`bash ${cgi}`, archive());
    expect(r.stdout.toString()).toEndWith("OK\n");
    expect(readFileSync(`${root}/data/configuration.yaml`, "utf8")).toContain("network_key");
    expect(existsSync(`${root}/data/sub/.hidden`)).toBe(true);
    expect(existsSync(`${root}/data/old`) || existsSync(`${root}/data/.old`)).toBe(false);
  });

  test("an unreadable archive leaves the volume untouched", () => {
    seed();
    const r = sh(`bash ${cgi}`, new TextEncoder().encode("not an archive"));
    expect(r.stdout.toString()).toEndWith("BAD\n");
    expect(existsSync(`${root}/data/.old`)).toBe(true);
  });
});

describe("backup and restore through the server", () => {
  test("demo APEX: backup download, then restore with the dependent container stopped and restarted", async () => {
    const server = startServer({ runOptions: { pollMs: 30, checkSeconds: 1, webCheckSeconds: 0 } });
    const base = server.url.slice(0, server.url.indexOf("/?"));
    const call = async (method: string, path: string, body?: BodyInit, type = "application/json") => {
      const res = await fetch(base + path, { method, body, headers: { "x-apexpress-token": server.token, "Content-Type": type } });
      return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.bytes() };
    };
    const waitFor = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 400 && !(await check()); i++) await Bun.sleep(50);
    };
    try {
      await call("POST", "/api/demo");
      await call("POST", "/api/deploy", JSON.stringify({ selection: { mosquitto: {} } }));
      await waitFor(async () => (await call("GET", "/api/apex")).data.containers.some((c: any) => c.name === "mosquitto" && c.state === "running"));
      expect((await call("GET", "/api/volumes/mosquitto-data/users")).data.users).toEqual(["mosquitto"]);

      // The deployment ends with its checks after the container is up: backups wait for it (409).
      let started: any;
      await waitFor(async () => (started = await call("POST", "/api/volumes/mosquitto-data/backup", JSON.stringify({ stop: true }))).status !== 409);
      started = started.data;
      let status: any;
      await waitFor(async () => (status = (await call("GET", `/api/backups/${started.id}`)).data).state !== "running");
      expect(status).toMatchObject({ state: "ready", volume: "mosquitto-data", stopped: ["mosquitto"] });
      expect(status.file).toMatch(/^mosquitto-data-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/);
      const download = await call("GET", `/api/backups/${started.id}/download`);
      expect(new TextDecoder().decode(Bun.gunzipSync(download.data as Uint8Array<ArrayBuffer>))).toBe("demo backup of mosquitto-data\n");
      await waitFor(async () => !(await call("GET", "/api/apex")).data.containers.some((c: any) => c.name === "apexpress-backup"));
      const after = (await call("GET", "/api/apex")).data.containers;
      expect(after.find((c: any) => c.name === "mosquitto").state).toBe("running");

      const bad = await call("POST", "/api/volumes/mosquitto-data/restore", "not gzip", "application/octet-stream");
      expect(bad.status).toBe(400);
      const ok = await call("POST", "/api/volumes/mosquitto-data/restore", download.data as Uint8Array<ArrayBuffer>, "application/octet-stream");
      expect(ok).toMatchObject({ status: 200, data: { ok: true, restarted: ["mosquitto"] } });
      const final = (await call("GET", "/api/apex")).data.containers;
      expect(final.map((c: any) => c.name)).toEqual(["mosquitto"]);
      expect(final[0].state).toBe("running");
    } finally {
      server.stop();
    }
  }, 60_000);
});
