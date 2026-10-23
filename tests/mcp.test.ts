import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan } from "../src/core/planner";
import { startMockApex, type MockApex } from "../src/mock/apex-mock";

const SCRIPT = join(import.meta.dir, "../src/recipes/assets/eclypse-mcp.mjs");
const TOKEN = "t0ken-for-tests-0123456789abcdefghijklmn";

let mock: MockApex;
const servers: { proc: ReturnType<typeof Bun.spawn>; dir: string }[] = [];

/** Starts the MCP server with plain Node semantics (Bun runs the same file), against the mock APEX. */
async function startMcp(extra: Record<string, string> = {}) {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const dir = mkdtempSync(join(tmpdir(), "apx-mcp-"));
  const proc = Bun.spawn([process.execPath, SCRIPT], {
    env: { ...process.env, APEX_URL: mock.url, APEX_USER: "admin", APEX_PASSWORD: "admin", MCP_TOKEN: TOKEN, PORT: String(port), DATA_DIR: dir, POLL_MS: "30", AUTO_BACKUP_HOURS: "0", ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  servers.push({ proc, dir });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(base).then(() => true, () => false)) break;
    await Bun.sleep(50);
  }
  let id = 0;
  const post = (body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }, path = "/mcp") =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await post({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } });
    const data = (await res.json()) as any;
    return { text: data.result.content[0].text as string, isError: !!data.result.isError };
  };
  return { base, post, call, dir };
}

beforeAll(() => {
  mock = startMockApex();
});
afterAll(() => {
  for (const s of servers) {
    s.proc.kill();
    rmSync(s.dir, { recursive: true, force: true });
  }
  mock.stop();
});

describe("MCP protocol and access", () => {
  test("initialize, tools/list, notifications, token in header or path", async () => {
    const mcp = await startMcp();
    const init = (await (await mcp.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } })).json()) as any;
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.instructions).toContain("lecture seule");

    expect((await mcp.post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

    const list = (await (await mcp.post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any;
    const names = list.result.tools.map((t: any) => t.name);
    expect(names).toContain("list_points");
    expect(names).toContain("get_history");
    expect(names).not.toContain("write_point");
    expect(names).not.toContain("query_influx");

    // claude.ai custom connectors cannot send headers: the token can be the last path segment.
    expect((await mcp.post({ jsonrpc: "2.0", id: 3, method: "ping" }, {}, `/mcp/${TOKEN}`)).status).toBe(200);
    expect((await mcp.post({ jsonrpc: "2.0", id: 4, method: "ping" }, {})).status).toBe(401);
    expect((await mcp.post({ jsonrpc: "2.0", id: 5, method: "ping" }, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await mcp.post({ jsonrpc: "2.0", id: 6, method: "ping" }, {}, "/mcp/wrong")).status).toBe(401);
    expect((await fetch(`${mcp.base}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
    expect(await (await fetch(mcp.base)).text()).not.toContain(TOKEN);
  });

  test("an empty token refuses everything", async () => {
    const mcp = await startMcp({ MCP_TOKEN: "" });
    expect((await mcp.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { Authorization: "Bearer " })).status).toBe(401);
  });
});

describe("read tools against the simulated APEX", () => {
  test("points, devices, schedules, alarms, controller", async () => {
    const mcp = await startMcp();
    const all = await mcp.call("list_points");
    expect(all.text).toContain("analog-inputs/2 | T_DEP_CH | 46.2 degrees-celsius");
    expect(all.text).toContain("multi-state-values/1 | MODE_CH | 2 (Confort)");
    expect(all.text).toContain("binary-values/2 | DEF_POMPE_CH | inactive [in-alarm]");
    expect(all.text).not.toContain("schedules/");
    const filtered = await mcp.call("list_points", { search: "pompe" });
    expect(filtered.text.split("\n")).toHaveLength(3);
    expect((await mcp.call("list_points", { device: 210066 })).text).toContain("analog-inputs/3 | T_AMB_RDC | 20.6");

    const point = await mcp.call("read_point", { type: "analog-values", instance: 1 });
    expect(JSON.parse(point.text)["relinquish-default"]).toBe(45);
    expect((await mcp.call("read_point", { type: "analog-values", instance: 99 })).isError).toBe(true);
    expect((await mcp.call("read_point", { type: "../platform", instance: 1 })).isError).toBe(true);

    expect((await mcp.call("list_devices")).text).toContain("210066 | CVC_RDC | Connected | 192.168.1.150:47808:réseau 1");
    const sched = await mcp.call("get_schedules");
    expect(sched.text).toContain("PROG_CHAUFFAGE");
    expect(sched.text).toContain("- monday : 06:30→true, 18:00→null");
    expect(sched.text).toContain("exception « Noël » (****-12-25-***");
    const alarms = (await mcp.call("get_alarms")).text;
    expect(alarms.split("\n")[1]).toContain("| Normal→Offnormal | Unacked | binary-values/2 |");
    expect(alarms).toContain("Acked (admin)");
    expect((await mcp.call("get_alarms", { unacked_only: true })).text).not.toContain("Defaut_ancien");
    const infoText = (await mcp.call("controller_info")).text;
    expect(infoText).not.toContain("eclypse1234");
    const info = JSON.parse(infoText);
    expect(info.controller.model).toBe("ECY-APEX");
    expect(info.controller.hostname).toBe("ECLYPSE-DEMO");
    expect(info.controller["ip-addresses"]).toEqual(["192.168.1.2"]);
    expect(info.sensors["cpu-temperature"]).toBe("40.2 DegreesCelsius");
    expect(info["bacnet-device-instance"]).toBe(300001);
    // Secrets are masked in raw reads too.
    expect((await mcp.call("api_get", { path: "/services/platform" })).text).toContain('"password": "<masqué>"');

    expect((await mcp.call("api_get", { path: "/services/bacnet/local/objects/analog-values/2/present-value" })).text).toBe("20");
    expect((await mcp.call("api_get", { path: "/auth/local/token" })).isError).toBe(true);
  });

  test("history: statistics, hourly and daily aggregation", async () => {
    const mcp = await startMcp();
    expect((await mcp.call("list_trend_logs")).text).toContain("TL_T_DEP_CH");
    const day = await mcp.call("get_history", { history: "TL_T_EXT", from: "24h" });
    expect(day.text).toMatch(/2[45] enregistrements/);
    expect(day.text).toContain("min 4 · max 12");
    expect(day.text).toContain("horodatage;valeur");
    const week = await mcp.call("get_history", { history: "TL_T_DEP_CH", from: "7d", interval: "day" });
    expect(week.text).toContain("Agrégation par jour");
    expect(week.text.split("\n").filter((l) => /^\d{4}-.*;/.test(l)).length).toBeGreaterThanOrEqual(7);
    expect((await mcp.call("get_history", { history: "nope" })).isError).toBe(true);
    expect((await mcp.call("get_history", { history: "TL_T_EXT", from: "2020-01-01", to: "2020-01-02" })).text).toContain("Aucun enregistrement");
    expect((await mcp.call("get_history", { history: "TL_T_EXT", from: "hier" })).isError).toBe(true);
  });

  test("site notes are kept in the data volume", async () => {
    const mcp = await startMcp();
    expect((await mcp.call("site_notes")).text).toContain("Aucune note");
    await mcp.call("save_site_notes", { content: "# Chaufferie\nanalog-inputs/2 = départ radiateurs" });
    await mcp.call("save_site_notes", { content: "Loi d'eau : 60 °C à -7 °C", mode: "append" });
    const notes = (await mcp.call("site_notes")).text;
    expect(notes).toContain("départ radiateurs");
    expect(notes).toContain("Loi d'eau");
    expect(readFileSync(join(mcp.dir, "site.md"), "utf8")).toBe(notes);
  });
});

describe("more read tools", () => {
  test("status filters, several points at once, history by point, aligned series", async () => {
    const mcp = await startMcp();
    expect((await mcp.call("list_points", { status: "alarm" })).text).toBe("1 point(s) :\nbinary-values/2 | DEF_POMPE_CH | inactive [in-alarm]");
    expect((await mcp.call("list_points", { search: "csg amb" })).text).toContain("analog-values/2 | CSG_AMB_JOUR");
    const many = (await mcp.call("read_points", { points: ["analog-inputs/1", "multi-state-values/1", "analog-values/999"] })).text.split("\n");
    expect(many[0]).toBe("analog-inputs/1 | T_EXT | 8.4 degrees-celsius");
    expect(many[1]).toBe("multi-state-values/1 | MODE_CH | 2 (Confort)");
    expect(many[2]).toContain("analog-values/999 | erreur : APEX 404");
    expect((await mcp.call("read_points", { points: ["nope"] })).isError).toBe(true);

    expect((await mcp.call("list_trend_logs", { point: "analog-inputs/2" })).text).toContain("TL_T_DEP_CH | analog-inputs/2 | 5000 enr. max | actif");
    expect((await mcp.call("get_history", { point: "analog-inputs/1", from: "24h" })).text).toStartWith("TL_T_EXT,");
    expect((await mcp.call("get_history", { point: "analog-values/1" })).text).toContain("Aucun trend log n'enregistre analog-values/1");

    const cmp = (await mcp.call("compare_histories", { series: ["analog-inputs/1", "TL_T_DEP_CH"], from: "2d" })).text.split("\n");
    expect(cmp[1]).toBe("S1 = TL_T_EXT (48 enr.)");
    expect(cmp[4]).toBe("début;S1;S2");
    const [, ext, dep] = cmp[5]!.split(";").map(Number);
    expect(dep).toBeCloseTo(55 - 1.2 * ext!, 0);
    expect((await mcp.call("compare_histories", { series: ["TL_T_EXT"] })).isError).toBe(true);
  });

  test("prompts", async () => {
    const mcp = await startMcp();
    const list = (await (await mcp.post({ jsonrpc: "2.0", id: 1, method: "prompts/list" })).json()) as any;
    expect(list.result.prompts.map((p: any) => p.name)).toEqual(["bilan_alarmes", "audit_equipement", "analyse_courbes", "integrer_equipement", "documenter_site"]);
    const got = (await (await mcp.post({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "audit_equipement", arguments: { equipement: "CTA1" } } })).json()) as any;
    expect(got.result.messages[0].content.text).toContain('list_points search="CTA1"');
    const missing = (await (await mcp.post({ jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "audit_equipement", arguments: {} } })).json()) as any;
    expect(missing.error.code).toBe(-32602);
  });
});

describe("supervised writes", () => {
  const value = async (mcp: Awaited<ReturnType<typeof startMcp>>, point: string) => (await mcp.call("api_get", { path: `/services/bacnet/local/objects/${point}/present-value` })).text;

  test("write tools only exist when writing is enabled", async () => {
    const ro = await startMcp();
    const names = ((await (await ro.post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any).result.tools.map((t: any) => t.name);
    for (const n of ["write_point", "write_property", "create_object", "delete_object", "write_schedule"]) expect(names).not.toContain(n);
    const rw = await startMcp({ ALLOW_WRITE: "true" });
    const tools = ((await (await rw.post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()) as any).result.tools;
    expect(tools.find((t: any) => t.name === "delete_object").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tools.find((t: any) => t.name === "list_points").annotations.readOnlyHint).toBe(true);
  });

  test("write_point: dry run, priority, limits, release, logged", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true", WRITE_PRIORITY: "16" });
    const dry = await mcp.call("write_point", { type: "analog-values", instance: 2, value: 21 });
    expect(dry.text).toStartWith("SIMULATION");
    expect(await value(mcp, "analog-values/2")).toBe("20");

    const done = await mcp.call("write_point", { type: "analog-values", instance: 2, value: 21, confirm: true });
    expect(done.text).toContain("Valeur présente maintenant : 21 degrees-celsius (priorité 16)");
    expect(JSON.parse((await mcp.call("read_point", { type: "analog-values", instance: 2 })).text)["priority-array"][15]).toBe(21);
    expect(readFileSync(join(mcp.dir, "writes.log"), "utf8")).toContain('"write":"analog-values/2"');
    expect((await mcp.call("list_points", { status: "commanded" })).text).toContain("analog-values/2 | CSG_AMB_JOUR | 21 degrees-celsius [prio 16]");
    expect((await mcp.call("list_points", { status: "abnormal" })).text).not.toContain("CSG_AMB_JOUR");

    // A stronger priority masks a weaker one: the dry run says so.
    await mcp.call("write_point", { type: "analog-values", instance: 2, value: 22, priority: 10, confirm: true });
    expect((await mcp.call("write_point", { type: "analog-values", instance: 2, value: 23 })).text).toContain("la priorité 10 est plus forte");
    await mcp.call("write_point", { type: "analog-values", instance: 2, value: null, priority: 10, confirm: true });
    expect((await mcp.call("write_point", { type: "analog-values", instance: 2, value: null, confirm: true })).text).toContain("maintenant : 20");

    expect((await mcp.call("write_point", { type: "analog-values", instance: 2, value: 35, confirm: true })).text).toContain("max-pres-value 30");
    expect((await mcp.call("write_point", { type: "analog-values", instance: 2, value: 21, priority: 5, confirm: true })).text).toContain("1 à 7 réservées");
    expect((await mcp.call("write_point", { type: "binary-values", instance: 1, value: "arrêt", confirm: true })).text).toContain("inactive");
    expect((await mcp.call("write_point", { type: "multi-state-values", instance: 1, value: "Réduit", confirm: true })).text).toContain("3 (Réduit)");
    expect((await mcp.call("write_point", { type: "multi-state-values", instance: 1, value: 5, confirm: true })).text).toContain("1=Arrêt");
    expect((await mcp.call("write_point", { type: "analog-inputs", instance: 1, value: 3, confirm: true })).isError).toBe(true);

    const remote = await mcp.call("write_point", { device: 210066, type: "analog-values", instance: 7, value: 21.5, confirm: true });
    expect(remote.text).toContain("device 210066 analog-values/7 « CSG_RDC »");
    expect(remote.text).toContain("maintenant : 21.5");
  });

  test("whitelist of writable names", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true", WRITE_ALLOW: "^CSG_" });
    expect((await mcp.call("write_point", { type: "analog-values", instance: 1, value: 50, confirm: true })).isError).toBe(false);
    const refused = await mcp.call("write_point", { type: "binary-values", instance: 1, value: "inactive", confirm: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("liste blanche");
  });

  test("properties, objects created then deleted, schedules", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true" });
    expect((await mcp.call("write_property", { type: "analog-values", instance: 1, property: "description", value: "Consigne départ" })).text).toStartWith("SIMULATION");
    expect((await mcp.call("write_property", { type: "analog-values", instance: 1, property: "description", value: "Consigne départ", confirm: true })).text).toContain("Valeur relue : Consigne départ");
    expect((await mcp.call("write_property", { type: "analog-values", instance: 1, property: "priority-array", value: [] })).isError).toBe(true);

    expect((await mcp.call("create_object", { object_type: "AnalogValue", name: "MCP_TEST" })).text).toContain("créer AnalogValue analog-values/10000");
    expect((await mcp.call("create_object", { object_type: "AnalogValue", name: "MCP_TEST", confirm: true })).text).toBe("Créé : analog-values/10000 « MCP_TEST ».");
    expect((await mcp.call("create_object", { object_type: "AnalogValue", name: "MCP_TEST2", confirm: true })).text).toContain("analog-values/10001");
    expect((await mcp.call("delete_object", { type: "analog-values", instance: 1, confirm: true })).text).toContain("n'a pas été créé par ce serveur");
    expect((await mcp.call("delete_object", { type: "analog-values", instance: 10000, confirm: true })).text).toContain("Supprimé");
    expect((await mcp.call("read_point", { type: "analog-values", instance: 10000 })).isError).toBe(true);
    expect(JSON.parse(readFileSync(join(mcp.dir, "created.json"), "utf8")).map((c: any) => c.instance)).toEqual([10001]);

    await mcp.call("create_object", { object_type: "Schedule", name: "PROG_TEST", instance: 5, confirm: true });
    expect((await mcp.call("create_object", { object_type: "Schedule", name: "PROG_BOOL", schedule_type: "Boolean", confirm: true })).isError).toBe(false);
    await mcp.call("write_schedule", { instance: 10000, week: { friday: [{ time: "06:00", value: true }, { time: "20:00", value: null }] }, confirm: true });
    expect((await mcp.call("get_schedules", { instance: 10000 })).text).toContain("type Boolean");
    expect((await mcp.call("get_schedules", { instance: 10000 })).text).toContain("- friday : 06:00→true, 20:00→null");
    // A schedule created on an APEX is enumerated (Occupied, Unoccupied…): texts and numbers are accepted, not booleans.
    expect((await mcp.call("write_schedule", { instance: 5, week: { monday: [{ time: "07:00", value: true }] } })).text).toContain("1=Occupied");
    const week = { monday: [{ time: "18:00", value: null }, { time: "7:00", value: "occupied" }], sunday: [], tuesday: [{ time: "08:00", value: 2 }] };
    const dry = await mcp.call("write_schedule", { instance: 5, week });
    expect(dry.text).toContain("monday : 07:00→1, 18:00→null");
    await mcp.call("write_schedule", { instance: 5, week, exceptions: [{ name: "Noël", date: "****-12-25" }, { name: "Vacances", from: "2026-12-21", to: "2027-01-02", transitions: [{ time: "08:00", value: "Occupied" }] }], confirm: true });
    const sched = (await mcp.call("get_schedules", { instance: 5 })).text;
    expect(sched).toContain("type Enumerated : 1=Occupied, 2=Unoccupied, 3=Bypass, 4=Standby");
    expect(sched).toContain("- monday : 07:00→1 (Occupied), 18:00→null");
    expect(sched).toContain("- tuesday : 08:00→2 (Unoccupied)");
    expect(sched).toContain("- wednesday : aucune transition");
    // Days not given keep their transitions.
    await mcp.call("write_schedule", { instance: 5, week: { friday: [{ time: "09:00", value: 3 }] }, confirm: true });
    const after = (await mcp.call("get_schedules", { instance: 5 })).text;
    expect(after).toContain("- monday : 07:00→1 (Occupied), 18:00→null");
    expect(after).toContain("- friday : 09:00→3 (Bypass)");
    expect(sched.indexOf("- monday")).toBeLessThan(sched.indexOf("- sunday"));
    expect(sched).toContain("exception « Noël » (****-12-25-***");
    expect(sched).toContain("exception « Vacances » (2026-12-21-*** → 2027-01-02-***");
    expect((await mcp.call("write_schedule", { instance: 5, week: { lundi: [] }, confirm: true })).isError).toBe(true);
    expect((await mcp.call("write_schedule", { instance: 5, week: { monday: [{ time: "25:00", value: 1 }] }, confirm: true })).isError).toBe(true);
  });
});


/** EDE file as exported by BACnet tools (BIG-EU layout 2.3). */
const EDE = [
  "#Engineering-Data-Exchange - B.I.G.-EU",
  "PROJECT_NAME;Chaufferie demo",
  "VERSION_OF_REFERENCEFILE;1",
  "TIMESTAMP_OF_LAST_CHANGE;2026-10-15",
  "AUTHOR_OF_LAST_CHANGE;OpenGTB",
  "VERSION_OF_LAYOUT;2.3",
  "#mandatory;mandatory;mandatory;mandatory;mandatory;optional;optional;optional;optional;optional;optional;optional;optional;optional;optional;optional",
  "# keyname;device obj.-instance;object-name;object-type;object-instance;description;present-value-default;min-present-value;max-present-value;settable;supports COV;hi-limit;low-limit;state-text-reference;unit-code;vendor-specific-address",
  "PAC1;77001;PAC_Daikin;8;77001;Pompe à chaleur;;;;;;;;;;",
  "PAC1_TEXT;77001;T_Exterieure;0;1;Température extérieure;;-40;60;N;Y;;;;62;",
  "PAC1_TDEP;77001;T_Depart;0;2;Départ eau;;;;N;Y;;;;62;",
  "PAC1_CSG;77001;Consigne_Depart;2;10;Consigne départ;45;20;60;Y;Y;;;;62;",
  "PAC1_MARCHE;77001;Marche;5;1;Marche/Arrêt;;;;Y;Y;;;;;",
  "PAC1_DEF;77001;Defaut;3;1;Défaut général;;;;N;Y;;;;;",
  "PAC1_MODE;77001;Mode;19;1;Mode;;;;Y;Y;;;1;;",
  "PAC1_TL;77001;Log_T_Depart;20;1;Trend;;;;N;N;;;;;",
  "",
].join("\r\n");

describe("integration of third-party equipment", () => {
  test("EDE import: dry run, device declared, points persisted, deletion limited to what was created", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true" });
    const dry = (await mcp.call("import_ede", { ede: EDE })).text;
    expect(dry).toStartWith("SIMULATION");
    expect(dry).toContain("équipement 77001 « PAC_Daikin » (à déclarer) : 6 point(s) : 2 analog-inputs, 1 analog-values, 1 binary-values, 1 binary-inputs, 1 multi-state-values");
    expect(dry).toContain("Ignorés (types non pris en charge) : 1 de type 20");
    expect((await mcp.call("list_devices")).text).not.toContain("77001");

    const done = (await mcp.call("import_ede", { ede: EDE, ip: "192.168.1.120", name_prefix: "PAC1_", confirm: true })).text;
    expect(done).toContain("Import terminé : 6 point(s).");
    expect((await mcp.call("list_devices")).text).toContain("77001 | PAC_Daikin | Unknown | 192.168.1.120:47808:réseau 0");
    const av = JSON.parse((await mcp.call("read_point", { device: 77001, type: "analog-values", instance: 10 })).text);
    expect(av).toMatchObject({ "local-name": "PAC1_Consigne_Depart", persisted: true, policy: "normal", "local-description": "Consigne départ" });
    expect(av["managed-properties"]["85"].operation).toBe("ReadWrite");
    expect((await mcp.call("list_points", { device: 77001, type: "analog-values" })).text).toContain("analog-values/10 | PAC1_Consigne_Depart");
    const ai = JSON.parse((await mcp.call("read_point", { device: 77001, type: "analog-inputs", instance: 1 })).text);
    expect(ai["managed-properties"]["85"].operation).toBe("Read");
    expect(ai["managed-properties"]["117"]).toBeDefined();
    // Importing again leaves persisted points alone.
    expect((await mcp.call("import_ede", { ede: EDE, confirm: true })).text).toContain("Import terminé : 0 point(s).");

    expect((await mcp.call("delete_bacnet_device", { instance: 210066, confirm: true })).text).toContain("refusée");
    expect((await mcp.call("delete_bacnet_device", { instance: 77001, confirm: true })).text).toContain("supprimé");
    expect((await mcp.call("list_devices")).text).not.toContain("77001");
  });

  test("points added to an existing device, policies, filters", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true" });
    expect((await mcp.call("import_ede", { ede: EDE, device: 1 })).text).toContain("Équipements du fichier : 77001 (6 objets)");
    const onExisting = EDE.replaceAll(";77001;", ";210066;");
    const only = (await mcp.call("import_ede", { ede: onExisting, types: ["AI"], confirm: true })).text;
    expect(only).toContain("2 point(s)");
    expect((await mcp.call("list_points", { device: 210066 })).text).toContain("analog-inputs/2 | T_Depart");
    expect((await mcp.call("delete_object", { device: 210066, type: "analog-inputs", instance: 3, confirm: true })).text).toContain("refusée");
    expect((await mcp.call("delete_object", { device: 210066, type: "analog-inputs", instance: 2, confirm: true })).text).toContain("Supprimé : device 210066 analog-inputs/2");

    const add = await mcp.call("add_bacnet_points", { device: 210066, objects: [{ type: "BV", instance: 5, name: "Marche_CTA" }], policy: "rapide" });
    expect(add.text).toContain("Politique « rapide » inconnue : normal, fast, slow");
    expect((await mcp.call("add_bacnet_points", { device: 210066, objects: [{ type: "BV", instance: 5, name: "Marche_CTA" }], policy: "fast", confirm: true })).text).toContain("1 point(s) ajouté(s)");
    expect((await mcp.call("add_bacnet_points", { device: 999, objects: [{ type: "AV", instance: 1 }], confirm: true })).text).toContain("Équipement 999 inconnu");
    expect((await mcp.call("add_bacnet_points", { device: 210066, objects: [{ type: "trend-log", instance: 1 }] })).isError).toBe(true);
    expect((await mcp.call("import_ede", { ede: "a;b;c" })).text).toContain("Fichier EDE non reconnu");
  });

  test("BACnet device declared by hand", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true" });
    expect((await mcp.call("create_bacnet_device", { instance: 4500, name: "CTA_TOIT", ip: "192.168.1.130", confirm: true })).text).toContain("déclaré");
    expect((await mcp.call("list_devices")).text).toContain("4500 | CTA_TOIT | Unknown | 192.168.1.130:47808");
    expect((await mcp.call("create_bacnet_device", { instance: 4500, name: "X", confirm: true })).text).toContain("existe déjà");
    expect((await mcp.call("create_bacnet_device", { instance: 4194303, name: "X" })).isError).toBe(true);
  });

  test("Modbus: overview, device over TCP or RS-485, points, deletion limited to what was created", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true" });
    const overview = (await mcp.call("list_modbus")).text;
    expect(overview).toContain("- Modbus RS-485 Network 1 : COM1 19200 bauds 8E1 (Open)");
    expect(overview).toContain("- CPT_EL_CVC | Modbus RS-485 Network 1 id 5 | 2 (1 en défaut) | NoHeartbeatDefined");
    expect((await mcp.call("list_modbus", { device: "CPT_EL_CVC" })).text).toContain("P_L1 | HoldingRegister 45083 Int32 ×0.01 | 12.5 KilowattHours | Read | Ok");

    expect((await mcp.call("create_modbus_device", { name: "PAC2", network: "Modbus RS-485 Network 9", slave: 3, confirm: true })).text).toContain("Réseau « Modbus RS-485 Network 9 » inconnu");
    expect((await mcp.call("create_modbus_device", { name: "PAC2", confirm: true })).text).toContain("soit ip");
    expect((await mcp.call("create_modbus_device", { name: "PAC2", network: "Modbus RS-485 Network 1", slave: 3, word_swap: true, confirm: true })).text).toContain("déclaré");
    const dev = JSON.parse((await mcp.call("api_get", { path: "/services/modbus/devices/PAC2" })).text);
    expect(dev.address).toEqual({ type: "Rs485", network: "Modbus RS-485 Network 1", "modbus-address": 3 });
    expect(dev.encoding["float-byte-ordering"]["word-swap"]).toBe(true);
    expect(dev.encoding["int16-byte-ordering"]).toEqual({ "byte-swap": false });
    await mcp.call("create_modbus_device", { name: "Compteur", ip: "192.168.1.140", confirm: true });

    const points = [
      { name: "T_Depart", address: 40001, data_type: "int16", scale: 0.1, units: "DegreesCelsius" },
      { name: "Marche", address: 1, register: "coil", access: "ReadWrite" },
      { name: "Energie", address: 30010, register: "input", data_type: "Float", units: "KilowattHours", polling: 60 },
    ];
    expect((await mcp.call("add_modbus_points", { device: "PAC2", points })).text).toContain("T_Depart : HoldingRegister 40001 Int16 ×0.1 DegreesCelsius Read");
    expect((await mcp.call("add_modbus_points", { device: "PAC2", points, confirm: true })).text).toContain("3 point(s) ajouté(s)");
    const list = (await mcp.call("list_modbus", { device: "PAC2" })).text;
    expect(list).toContain("Marche | Coils 1 Bit | 0 | ReadWrite | Ok");
    expect(list).toContain("Energie | InputRegister 30010 Float | 0 KilowattHours | Read | Ok");
    expect((await mcp.call("add_modbus_points", { device: "PAC2", points: [points[0]], confirm: true })).text).toContain("déjà présents : T_Depart");
    expect((await mcp.call("add_modbus_points", { device: "PAC2", points: [{ name: "X", address: 1, data_type: "Uint64" }] })).isError).toBe(true);
    expect((await mcp.call("add_modbus_points", { device: "Nope", points: [{ name: "X", address: 1 }] })).text).toContain("inconnu");

    await mcp.call("add_modbus_points", { device: "CPT_EL_CVC", points: [{ name: "I_L1", address: 45060, data_type: "Uint16", scale: 0.1, units: "Amperes" }], confirm: true });
    expect((await mcp.call("delete_modbus", { device: "CPT_EL_CVC", points: ["P_L1"], confirm: true })).text).toContain("refusée : P_L1");
    expect((await mcp.call("delete_modbus", { device: "CPT_EL_CVC", points: ["I_L1"], confirm: true })).text).toContain("Supprimé(s)");
    expect((await mcp.call("delete_modbus", { device: "CPT_EL_CVC", confirm: true })).text).toContain("refusée");
    expect((await mcp.call("delete_modbus", { device: "PAC2", confirm: true })).text).toContain("supprimé");
    expect((await mcp.call("list_modbus")).text).not.toContain("PAC2");
  });

  test("GFX network values: list and bind", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true" });
    const list = (await mcp.call("list_network_values")).text;
    expect(list).toContain("NV 1 | device 210066 | analog-inputs/3 | T_AMB_RDC | 20.6 degrees-celsius");
    expect(list).toContain("NV 2 | device 210066 | analog-values/7 | CSG_RDC");
    expect((await mcp.call("list_network_values", { search: "csg" })).text).toStartWith("1 network value(s)");
    expect((await mcp.call("bind_network_value", { number: 1, device: 210066, instance: 9 })).text).toContain("lier la NV 1 (aujourd'hui device 210066/objects/analog-inputs/3) à l'objet 9 de l'équipement 210066");
    expect((await mcp.call("bind_network_value", { number: 1, device: 210066, instance: 9, confirm: true })).text).toContain("/services/bacnet/remote/devices/210066/objects/analog-inputs/9");
    expect((await mcp.call("bind_network_value", { number: 99, device: 1, instance: 1, confirm: true })).text).toContain("introuvable");
  });
});


describe("discovery and trend logs", () => {
  test("Who-Is, objects of a discovered device, points kept, device removable", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true" });
    const whois = (await mcp.call("discover_devices", { wait: 5 })).text;
    expect(whois).toContain("Who-Is terminé.");
    expect(whois).toContain("1 équipement(s) découvert(s)");
    expect(whois).toContain("1005 | ECY-303-CTA_NORD | Online | 192.168.1.6:47808:réseau 1 | Distech Controls, Inc. ECY-303 Rev 1.0A | découvert, non gardé");
    expect((await mcp.call("discover_devices", { low_limit: 2000, high_limit: 3000, wait: 5 })).text).toContain("0 équipement(s) découvert(s)");
    await mcp.call("discover_devices", { wait: 5 });

    expect((await mcp.call("list_points", { device: 1005 })).text).toBe("Aucun objet connu pour l'équipement 1005 : lancez discover_objects pour lire ses points.");
    const objs = (await mcp.call("discover_objects", { device: 1005 })).text;
    expect(objs).toContain("Équipement 1005 « ECY-303-CTA_NORD » (découvert, non gardé) : 2 analog-values, 1 binary-inputs, 1 trend-logs.");
    expect(objs).toContain("analog-values/1 | Z1 - CO | non gardé");
    expect(objs).not.toContain("trend-logs/");
    expect((await mcp.call("discover_objects", { device: 4242 })).isError).toBe(true);

    const dry = (await mcp.call("add_bacnet_points", { device: 1005, discovered: true, types: ["AV"] })).text;
    expect(dry).toContain("ajouter 2 point(s) à l'équipement 1005 « ECY-303-CTA_NORD » (découvert : il sera gardé)");
    expect(dry).not.toContain("PORTE_1");
    const kept = (await mcp.call("add_bacnet_points", { device: 1005, discovered: true, search: "z1", confirm: true })).text;
    expect(kept).toContain("1 point(s) ajouté(s)");
    expect((await mcp.call("list_points", { device: 1005 })).text).toContain("analog-values/1 | Z1 - CO | 11 PartsPerMillion");
    expect((await mcp.call("list_points", { device: 1005 })).text).toContain("analog-values/2 | Z2 - CO | non gardé");
    expect((await mcp.call("list_devices")).text).toContain("1005 | ECY-303-CTA_NORD | Online | 192.168.1.6:47808:réseau 1 | Distech Controls, Inc. ECY-303 Rev 1.0A\n");
    expect((await mcp.call("add_bacnet_points", { device: 1005, discovered: true, search: "z1" })).isError).toBe(true);

    // A Who-Is no longer clears a kept device; the device kept here may be removed again.
    expect((await mcp.call("discover_devices", { wait: 5 })).text).toContain("0 équipement(s) découvert(s)");
    expect((await mcp.call("delete_bacnet_device", { instance: 1005, confirm: true })).text).toContain("supprimé");
  });

  test("trend logs on local and remote points, read back, deleted", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true" });
    const dry = (await mcp.call("create_trend_log", { point: "analog-values/1", interval_minutes: 10, buffer_size: 1000 })).text;
    expect(dry).toContain("créer le trend log trend-logs/10000 « CSG_DEP_CH Trend Log » sur analog-values/1 « CSG_DEP_CH » : toutes les 10 min, 1000 enregistrements");
    expect((await mcp.call("create_trend_log", { point: "analog-inputs/1" })).text).toContain("déjà enregistré par : TL_T_EXT");

    expect((await mcp.call("create_trend_log", { point: "analog-values/1", interval_minutes: 10, buffer_size: 1000, confirm: true })).text).toContain("Trend log créé : trend-logs/10000");
    const tl = JSON.parse((await mcp.call("read_point", { type: "trend-logs", instance: 10000 })).text);
    expect(tl).toMatchObject({ "logging-type": "Polled", "logging-interval": 60000, "buffer-size": 1000, enable: true });
    expect(tl["source-reference"]["object-identifier"]).toEqual({ "object-type": "AnalogValue", "object-instance": 1 });
    expect((await mcp.call("list_trend_logs", { point: "analog-values/1" })).text).toContain("CSG_DEP_CH Trend Log | analog-values/1 | 1000 enr. max | actif");

    expect((await mcp.call("create_trend_log", { point: "binary-values/1", confirm: true })).text).toContain("trend-logs/10001");
    expect(JSON.parse((await mcp.call("read_point", { type: "trend-logs", instance: 10001 })).text)).toMatchObject({ "logging-type": "Cov", "logging-interval": 0 });

    const remote = (await mcp.call("create_trend_log", { device: 210066, point: "analog-values/7", mode: "cov", confirm: true })).text;
    expect(remote).toContain("trend-logs/10002 « CSG_RDC Trend Log »");
    expect(JSON.parse((await mcp.call("read_point", { type: "trend-logs", instance: 10002 })).text)["source-reference"]["device-identifier"]).toEqual({ "object-type": "Device", "object-instance": 210066 });
    expect((await mcp.call("list_trend_logs", { search: "CSG_RDC" })).text).toContain("device 210066 analog-values/7");

    expect((await mcp.call("create_trend_log", { point: "schedules/1" })).isError).toBe(true);
    expect((await mcp.call("create_trend_log", { point: "analog-values/99" })).isError).toBe(true);
    expect((await mcp.call("delete_object", { type: "trend-logs", instance: 10000, confirm: true })).text).toContain("Supprimé");
    expect((await mcp.call("list_trend_logs", { point: "analog-values/1" })).text).toBe("Aucun trend log ne correspond.");
  });
});


describe("alarms and backups", () => {
  test("alarm history with numbers, acknowledgement by number, point or all", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true" });
    expect((await mcp.call("get_alarms")).text).toContain("#2 | ");
    expect((await mcp.call("get_alarms", { point: "binary-inputs/4" })).text).toStartWith("1 alarme(s)");
    expect((await mcp.call("ack_alarms", {})).isError).toBe(true);
    expect((await mcp.call("ack_alarms", { ids: [1] })).text).toContain("Rien à acquitter");
    const dry = (await mcp.call("ack_alarms", { all: true })).text;
    expect(dry).toContain("acquitter 1 alarme(s) :\n#2 |");
    expect((await mcp.call("ack_alarms", { point: "binary-values/2", confirm: true })).text).toBe("1 alarme(s) acquittée(s).");
    expect((await mcp.call("get_alarms", { unacked_only: true })).text).toBe("Aucune alarme.");
    expect((await mcp.call("get_alarms", { point: "binary-values/2" })).text).toContain("Acked (mcp)");
    const setup = (await mcp.call("alarm_setup")).text;
    expect(setup).toContain("- bacnet : alarme (acquittement requis, priorité 100)");
    expect(setup).toContain("Comptes e-mail : aucun.");
  });

  test("point alarms: limits, binary alarm value, messages, disabled", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true" });
    expect((await mcp.call("configure_point_alarm", { point: "analog-values/2" })).isError).toBe(true);
    expect((await mcp.call("configure_point_alarm", { point: "analog-values/2", high_limit: 10, low_limit: 20 })).isError).toBe(true);
    const dry = (await mcp.call("configure_point_alarm", { point: "analog-values/2", high_limit: 26, low_limit: 18, deadband: 0.5, time_delay: 60 })).text;
    expect(dry).toContain("analog-values/2 « CSG_AMB_JOUR » (valeur 20 degrees-celsius) : alarme non configurée → haut 26, bas 18, bande morte 0.5, temporisation 60 s");
    expect((await mcp.call("configure_point_alarm", { point: "analog-values/2", high_limit: 26, low_limit: 18, confirm: true })).text).toContain("État actuel : Normal");
    // Above the high limit: an alarm row appears, and acknowledging it works.
    await mcp.call("write_point", { type: "analog-values", instance: 2, value: 28, confirm: true });
    const rows = (await mcp.call("get_alarms", { point: "analog-values/2", unacked_only: true })).text;
    expect(rows).toContain("Normal→Offnormal | Unacked | analog-values/2");
    await mcp.call("ack_alarms", { point: "analog-values/2", confirm: true });

    const bv = (await mcp.call("configure_point_alarm", { point: "binary-values/1", alarm_value: "inactive", messages: { alarm: "{ObjectName} arrêtée" }, confirm: true })).text;
    expect(bv).toContain("alarme si Inactive");
    const alarm = JSON.parse((await mcp.call("read_point", { type: "binary-values", instance: 1 })).text).alarm;
    expect(alarm["event-message-texts-config"]["to-off-normal"]).toBe("{ObjectName} arrêtée");
    expect((await mcp.call("configure_point_alarm", { point: "multi-state-values/1", alarm_values: ["Hors-gel", 1], confirm: true })).text).toContain("alarme si état 4, 1");
    expect((await mcp.call("configure_point_alarm", { point: "multi-state-values/1", alarm_values: ["Inconnu"] })).text).toContain("1=Arrêt");
    expect((await mcp.call("configure_point_alarm", { point: "analog-values/2", enable: false, confirm: true })).text).toContain("→ détection désactivée");
    expect((await mcp.call("configure_point_alarm", { point: "schedules/1", high_limit: 1 })).isError).toBe(true);
  });

  test("custom alarm sent to a class, then closed", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true" });
    expect((await mcp.call("raise_alarm", { point: "analog-values/1", message: "Dérive de la loi d'eau", class: "critique" })).text).toContain("Classe « critique » inconnue : bacnet");
    const sent = (await mcp.call("raise_alarm", { point: "analog-values/1", message: "Dérive de la loi d'eau", confirm: true })).text;
    const id = /Alarme envoyée \(#(\d+)\)/.exec(sent)?.[1];
    expect(id).toBeDefined();
    expect((await mcp.call("get_alarms", { point: "analog-values/1" })).text).toContain(`#${id} | `);
    expect((await mcp.call("raise_alarm", { point: "analog-values/1", message: "Loi d'eau corrigée", to_state: "Normal", confirm: true })).text).toContain("Offnormal→Normal");
    expect((await mcp.call("raise_alarm", { point: "analog-values/99", message: "x" })).isError).toBe(true);
  });

  test("backups: by hand, automatic before a change at most every N hours, deletion and restore limited", async () => {
    const mcp = await startMcp({ ALLOW_WRITE: "true", AUTO_BACKUP_HOURS: "12" });
    expect((await mcp.call("list_backups")).text).toContain("Aucune sauvegarde sur l'APEX.");
    expect((await mcp.call("create_backup", { name: "avant travaux", confirm: true })).isError).toBe(true);
    expect((await mcp.call("create_backup", { name: "avant-travaux", confirm: true })).text).toBe("Sauvegarde « avant-travaux » faite (1041 Ko).");
    expect((await mcp.call("create_backup", { name: "avant-travaux", confirm: true })).text).toContain("existe déjà");

    // A dry run makes no backup; the first confirmed change does, the next one within 12 h does not.
    await mcp.call("create_object", { object_type: "AnalogValue", name: "A" });
    expect((await mcp.call("list_backups")).text).toStartWith("1 sauvegarde(s)");
    const first = (await mcp.call("create_object", { object_type: "AnalogValue", name: "A", confirm: true })).text;
    expect(first).toMatch(/Sauvegarde automatique de l'APEX faite avant cette modification : « mcp-auto-\d{8}-\d{4} »/);
    const second = (await mcp.call("create_object", { object_type: "AnalogValue", name: "B", confirm: true })).text;
    expect(second).not.toContain("Sauvegarde automatique");
    // Writing a value or acknowledging an alarm is not a configuration change.
    expect((await mcp.call("write_point", { type: "analog-values", instance: 1, value: 50, confirm: true })).text).not.toContain("Sauvegarde");
    const list = (await mcp.call("list_backups")).text;
    expect(list).toContain("avant-travaux |");
    expect(list).toContain("| auto MCP");
    expect(list).toContain("au plus une toutes les 12 h, 5 gardées");

    expect((await mcp.call("restore_backup", { name: "avant-travaux" })).text).toContain("Tout ce qui a été configuré depuis cette date sera perdu");
    expect((await mcp.call("restore_backup", { name: "avant-travaux", keep: ["Users"], confirm: true })).text).toContain("Restauration lancée");
    expect((await mcp.call("restore_backup", { name: "avant-travaux", keep: ["Tout"] })).isError).toBe(true);
    expect((await mcp.call("restore_backup", { name: "nope" })).isError).toBe(true);
    expect((await mcp.call("delete_backup", { name: "avant-travaux", confirm: true })).text).toBe("Sauvegarde « avant-travaux » supprimée.");
    expect((await mcp.call("delete_backup", { name: "autre", confirm: true })).isError).toBe(true);
  });
});

describe("recipe", () => {
  test("the container writes the same server and passes credentials through the environment", () => {
    const plan = buildPlan({ selection: { mcp: { apexUser: "mcp", apexPassword: "S3cret", allowWrite: true } }, apexIp: "192.168.1.49" });
    expect(plan.issues.filter((i) => i.level === "error")).toEqual([]);
    const c = plan.containers[0]!;
    const cmd = c.options.Cmd![0]!;
    expect(cmd).toContain("| base64 -d | gunzip > /srv/eclypse-mcp.mjs && exec node /srv/eclypse-mcp.mjs");
    // Linux caps one argument at 128 KB: keep a good margin for the server to grow.
    expect(Buffer.byteLength(cmd)).toBeLessThan(90_000);
    const packed = /echo '([A-Za-z0-9+/=]+)'/.exec(cmd)![1]!;
    const unpacked = new TextDecoder().decode(Bun.gunzipSync(Buffer.from(packed, "base64")));
    expect(unpacked).toBe(readFileSync(SCRIPT, "utf8").replace(/\r\n/g, "\n"));
    expect(c.options.Env).toContain("APEX_URL=https://192.168.1.49");
    expect(c.options.Env).toContain("ALLOW_WRITE=true");
    expect(c.options.Env!.find((e) => e.startsWith("MCP_TOKEN="))).toMatch(/^MCP_TOKEN=[A-Za-z0-9]{40}$/);
    expect(c.options.Env!.some((e) => e.startsWith("INFLUX_"))).toBe(false);
    const recipe = plan.recipes.find((r) => r.id === "mcp")!;
    expect(recipe.credentials.map((x) => x.value).join(" ")).toContain("claude mcp add --transport http eclypse http://192.168.1.49:50089/mcp");
  });
});
