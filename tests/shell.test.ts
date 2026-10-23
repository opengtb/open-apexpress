// Runs the generated `sh -c` start commands in a real shell, inside a temporary root.
// The APEX mock does not execute them: this caught a heredoc that swallowed `&& exec nginx`
// and a configuration written once that kept a stale coordinator IP across reinstalls.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan } from "../src/core/planner";
import { RECIPES } from "../src/recipes/catalog";
import type { ParamValue } from "../src/recipes/types";

// Git Bash on Windows (not the WSL bash.exe, which does not understand C:/ paths).
const BASH = process.platform === "win32" ? ["C:/Program Files/Git/bin/bash.exe"].find(existsSync) : Bun.which("bash");

const REQUIRED: Record<string, Record<string, ParamValue>> = {
  zigbee2mqtt: { coordinatorHost: "192.168.1.11" },
  cloudflared: { token: "eyJhIjoiZGVtbyJ9" },
  tailscale: { authKey: "tskey-auth-demo" },
  nodered: { adminPassword: "secret", modules: "node-red-contrib-bacnet" },
  mosquitto: { auth: true, user: "gtb", password: "S3cret" },
};

// Commands that do not exist here are no-ops; `exec` marks that the chain went to the end.
const PRELUDE = `
command_not_found_handle() { return 0; }
npm() { :; }
chown() { :; }
cd() { builtin cd "$@" 2>/dev/null || true; }
exec() { : > "$APX_ROOT/.exec-reached"; exit 0; }
`;

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function newRoot() {
  const root = mkdtempSync(join(tmpdir(), "apx-sh-")).replaceAll("\\", "/");
  roots.push(root);
  return root;
}

/** Runs a container start command with every absolute path moved under `root`. */
function run(cmd: string, root: string) {
  const rooted = cmd.replace(/(^|[\s'"=>])\/(?=[A-Za-z_])/g, `$1${root}/`);
  const script = `${root}/start.sh`;
  writeFileSync(script, PRELUDE + rooted);
  rmSync(`${root}/.exec-reached`, { force: true });
  const p = Bun.spawnSync([BASH!, script], { env: { ...process.env, APX_ROOT: root } });
  return { code: p.exitCode, stderr: p.stderr.toString(), execReached: existsSync(`${root}/.exec-reached`) };
}

const shellContainers = (selection: Record<string, Record<string, ParamValue>>) =>
  buildPlan({ selection, apexIp: "192.168.1.2" }).containers.filter((c) => c.options.Entrypoint?.join(" ") === "sh -c");

describe.skipIf(!BASH)("start commands in a real shell", () => {
  test.each(RECIPES.map((r) => [r.id]))("%s: every step runs up to the final command", (id) => {
    // InfluxDB and Mosquitto alongside: some recipes only generate their start script with them (Grafana).
    const selection = { influxdb: {}, mosquitto: REQUIRED.mosquitto!, [id]: REQUIRED[id] ?? {} };
    for (const c of shellContainers(selection).filter((x) => x.recipeId === id)) {
      const r = run(c.options.Cmd![0]!, newRoot());
      expect({ container: c.name, code: r.code, stderr: r.stderr }).toEqual({ container: c.name, code: 0, stderr: "" });
      if (!c.oneShot) expect({ container: c.name, execReached: r.execReached }).toEqual({ container: c.name, execReached: true });
    }
  });

  test("Zigbee2MQTT reinstall refreshes the coordinator and keeps the network key", () => {
    const root = newRoot();
    const start = (values: Record<string, ParamValue>) => run(shellContainers({ zigbee2mqtt: values })[0]!.options.Cmd![0]!, root);
    expect(start({ coordinatorHost: "192.168.1.99" }).code).toBe(0);
    const file = `${root}/app/data/configuration.yaml`;
    // Zigbee2MQTT replaces GENERATE with the real key on first start.
    writeFileSync(file, readFileSync(file, "utf8").replace("network_key: GENERATE", "network_key: [1, 2, 3]"));
    expect(start({ coordinatorHost: "192.168.1.50", adapter: "zstack" }).code).toBe(0);
    const config = readFileSync(file, "utf8");
    expect(config).toContain("port: tcp://192.168.1.50:6638");
    expect(config).toContain("adapter: zstack");
    expect(config).toContain("network_key: [1, 2, 3]");
    expect(config).not.toContain("192.168.1.99");
  });

  test("Node-RED reinstall with a new password updates settings.js", () => {
    const root = newRoot();
    const start = (password: string) => run(shellContainers({ nodered: { adminPassword: password } })[0]!.options.Cmd![0]!, root);
    expect(start("first").code).toBe(0);
    const file = `${root}/data/settings.js`;
    const before = readFileSync(file, "utf8");
    writeFileSync(file, before.replace("flowFile", "// user edit\n  flowFile"));
    expect(start("second").code).toBe(0);
    const after = readFileSync(file, "utf8");
    expect(after).toContain("// user edit");
    expect(after).toMatch(/password: "\$2a\$08\$[./A-Za-z0-9]{53}", permissions/);
    expect(after.match(/password: "([^"]+)"/)![1]).not.toBe(before.match(/password: "([^"]+)"/)![1]);
  });
});
