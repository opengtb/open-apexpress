/**
 * BACnet side of the simulated APEX: a small heating plant, enough to develop and test the MCP
 * server. Shapes follow the documented requests (maps keyed by instance, kebab-case properties,
 * {"$value": x} wrappers here and there); the real answers are not documented.
 */

type Props = Record<string, unknown>;

const flags = (alarm = false) => ({ "in-alarm": alarm, fault: false, overridden: false, "out-of-service": false });

function plant() {
  // Like a real APEX: priority-array is a list of 16 (index 0 = priority 1).
  const priority = () => Array.from({ length: 16 }, () => null);
  const local: Record<string, Record<string, Props>> = {
    "analog-inputs": {
      "1": { "object-name": "T_EXT", "present-value": 8.4, units: "degrees-celsius", "status-flags": flags(), "out-of-service": false, description: "Température extérieure" },
      "2": { "object-name": "T_DEP_CH", "present-value": { $value: 46.2 }, units: "degrees-celsius", "status-flags": flags(), "out-of-service": false, description: "Départ chauffage" },
    },
    "analog-values": {
      "1": { "object-name": "CSG_DEP_CH", "present-value": 47, units: "degrees-celsius", "status-flags": flags(), "out-of-service": false, "priority-array": priority(), "relinquish-default": 45 },
      "2": { "object-name": "CSG_AMB_JOUR", "present-value": 20, units: "degrees-celsius", "status-flags": flags(), "out-of-service": false, "priority-array": priority(), "relinquish-default": 20, "min-pres-value": 5, "max-pres-value": 30 },
    },
    "binary-values": {
      "1": { "object-name": "CMD_POMPE_CH", "present-value": "active", "status-flags": flags(), "out-of-service": false, "priority-array": priority(), "relinquish-default": "inactive" },
      "2": { "object-name": "DEF_POMPE_CH", "present-value": "inactive", "status-flags": flags(true), "out-of-service": false, "priority-array": priority(), "relinquish-default": "inactive" },
    },
    "multi-state-values": {
      "1": { "object-name": "MODE_CH", "present-value": 2, "state-text": ["Arrêt", "Confort", "Réduit", "Hors-gel"], "number-of-states": 4, "status-flags": flags(), "out-of-service": false, "priority-array": priority(), "relinquish-default": 2 },
    },
    schedules: {
      "1": {
        "object-name": "PROG_CHAUFFAGE",
        type: "Boolean",
        "present-value": true,
        "weekly-schedule": {
          monday: { transitions: { "1": { time: "06:30:00.00", value: true, key: "1" }, "2": { time: "18:00:00.00", value: null, key: "2" } } },
          sunday: { transitions: {} },
        },
        "special-events": {
          "1": { name: "Noël", "event-priority": 16, period: { type: "Date", date: { $value: "****-12-25-***" } }, transitions: {}, key: "1" },
        },
      },
    },
  };
  return local;
}

/** Hourly records over the last 10 days: outdoor temperature and the heating supply that follows it. */
function trend(history: string, from: number, to: number) {
  const out: { timestamp: string; flags: string; value: number; asn1: string }[] = [];
  const hour = 3600e3;
  for (let t = Math.ceil(from / hour) * hour; t <= to; t += hour) {
    const ext = 8 + 4 * Math.sin((2 * Math.PI * (t / hour - 15)) / 24);
    out.push({ timestamp: new Date(t).toISOString(), flags: "", value: Math.round((history.includes("DEP") ? 55 - 1.2 * ext : ext) * 10) / 10, asn1: "" });
  }
  return out;
}

export function createBacnet() {
  const local = plant();
  const histories: Record<string, Props> = {
    TL_T_EXT: { key: "TL_T_EXT", "full-policy": "bacnet-size-5000", source: "/services/bacnet/local/objects/analog-inputs/1/present-value", "value-type": "Float", enabled: true },
    TL_T_DEP_CH: { key: "TL_T_DEP_CH", "full-policy": "bacnet-size-5000", source: "/services/bacnet/local/objects/analog-inputs/2/present-value", "value-type": "Float", enabled: true },
  };
  const remote: Record<string, Props & { objects: Record<string, Record<string, Props>> }> = {
    "210066": {
      "local-name": "CVC_RDC",
      "connection-status": { $value: "Connected" },
      address: { ip: "192.168.1.150", port: 47808, "network-number": 1, type: "Ip" },
      objects: {
        "analog-inputs": { "3": { "object-name": "T_AMB_RDC", "present-value": 20.6, units: "degrees-celsius" } } as Record<string, Props>,
        "analog-values": { "7": { "object-name": "CSG_RDC", "present-value": 19, units: "degrees-celsius", "priority-array": Array.from({ length: 16 }, () => null), "relinquish-default": 19 } } as Record<string, Props>,
      },
    },
  };

  const policies = { normal: { key: "normal" }, fast: { key: "fast" }, slow: { key: "slow" } };
  // Devices that answer a Who-Is on the simulated network, and the objects they expose.
  const network: Record<string, Props & { objects: Record<string, Record<string, Props>> }> = {
    "1005": {
      "local-name": "ECY-303-CTA_NORD",
      "object-name": "ECY-303-CTA_NORD",
      "vendor-name": "Distech Controls, Inc.",
      "model-name": "ECY-303 Rev 1.0A",
      "connection-status": "Online",
      address: { "network-number": 1, port: 47808, ip: "192.168.1.6", type: "Ip" },
      objects: {
        "analog-values": { "1": { "local-name": "Z1 - CO", units: "PartsPerMillion", "present-value": 11 }, "2": { "local-name": "Z2 - CO", units: "PartsPerMillion", "present-value": 9 } },
        "binary-inputs": { "101": { "local-name": "PORTE_1 - ETAT OUV", "present-value": "inactive" } },
        "trend-logs": { "100101": { "local-name": "" } },
      },
    },
  };
  const encoding = { "int32-byte-ordering": { "byte-swap": false, "word-swap": false }, "float-byte-ordering": { "byte-swap": false, "word-swap": false } };
  const modbus: { networks: Record<string, Props>; devices: Record<string, Props & { points: Record<string, Props> }> } = {
    networks: { "Modbus RS-485 Network 1": { key: "Modbus RS-485 Network 1", port: "COM1", speed: 19200, parity: "Even", "data-bits": 8, "stop-bits": 1, state: "Open", enabled: true } },
    devices: {
      "CPT_EL_CVC": {
        key: "CPT_EL_CVC",
        address: { type: "Rs485", "modbus-address": 5, network: "Modbus RS-485 Network 1" },
        encoding,
        enabled: true,
        "device-status": "NoHeartbeatDefined",
        points: {
          P_L1: { key: "P_L1", address: "45083", "register-type": "HoldingRegister", "data-type": "Int32", "value-scale": 0.01, units: "KilowattHours", "access-type": "Read", "present-value": 12.5, "modbus-status": "Ok" },
          U_L1: { key: "U_L1", address: "45057", "register-type": "HoldingRegister", "data-type": "Uint16", "value-scale": 0.1, units: "Volts", "access-type": "Read", "present-value": 0, "modbus-status": "Fault", status: { $value: ["fault"], fault: true } },
        },
      },
    },
  };
  // GFX network values: "network-value-N" (1-based) bound to a remote object, runtime index N-1.
  const gfxConfig: Record<string, string[]> = {
    "network-value-1": ["/services/bacnet/remote/devices/210066/objects/analog-inputs/3", "/services/bacnet/remote/devices/210066/objects/analog-inputs/3/managed-properties/85", "/services/gfx/runtime/objects/network-values/0"],
    "network-value-2": ["/services/bacnet/remote/devices/210066/objects/analog-values/7", "/services/gfx/runtime/objects/network-values/1"],
    "analog-value-1": ["/services/bacnet/local/objects/analog-values/1"],
  };
  const BACNET_NAMES: Record<string, string> = {
    AnalogInput: "analog-inputs", AnalogOutput: "analog-outputs", AnalogValue: "analog-values",
    BinaryInput: "binary-inputs", BinaryOutput: "binary-outputs", BinaryValue: "binary-values",
    MultiStateInput: "multi-state-inputs", MultiStateOutput: "multi-state-outputs", MultiStateValue: "multi-state-values",
  };

  // Alarm history (rows of get-alarm-table) and configuration backups.
  const alarmRow = (id: number, hoursAgo: number, source: string, from: string, to: string, ack: string, message: string) => ({
    id,
    timestamp: new Date(Date.now() - hoursAgo * 3600e3).toISOString(),
    "alarm-class": "bacnet",
    source: source.startsWith("/") ? source : `/services/bacnet/local/objects/${source}`,
    "from-state": from,
    "to-state": to,
    "ack-state": ack,
    "ack-user": ack === "Acked" ? "admin" : null,
    message,
  });
  const alarms = [
    alarmRow(1, 30, "binary-inputs/4", "Normal", "Fault", "Acked", "APEX\\Defaut_ancien\\\\fault"),
    alarmRow(2, 1, "binary-values/2", "Normal", "Offnormal", "Unacked", "APEX\\Défaut pompe chauffage\\\\offnormal"),
  ];
  const backups: Record<string, Props> = {};
  const alarmClasses = { bacnet: { key: "bacnet", "offnormal-state": { "ack-required": true, priority: 100 }, "fault-state": { "ack-required": true, priority: 50 }, "normal-state": { "ack-required": false, priority: 200 }, recipients: {} } };

  /** Intrinsic reporting: a point whose alarm detection is on goes to Offnormal and logs a row, like a real APEX. */
  const evaluateAlarm = (path: string, o: Props) => {
    const a = o.alarm as Props | undefined;
    if (!a?.["event-detection-enable"]) {
      o["event-state"] = "Normal";
      return;
    }
    const v = o["present-value"];
    const limits = (a["limit-enable"] ?? {}) as Props;
    const off =
      (limits["high-limit-enable"] && typeof v === "number" && v > Number(a["high-limit"])) ||
      (limits["low-limit-enable"] && typeof v === "number" && v < Number(a["low-limit"])) ||
      (a["alarm-value"] !== undefined && String(v).toLowerCase() === String(a["alarm-value"]).toLowerCase()) ||
      (Array.isArray(a["alarm-values"]) && (a["alarm-values"] as unknown[]).includes(v));
    const next = off ? "Offnormal" : "Normal";
    if (next !== (o["event-state"] ?? "Normal")) {
      alarms.push(alarmRow(alarms.length + 1, 0, path, String(o["event-state"] ?? "Normal"), next, "Unacked", `APEX\\${o["object-name"]}\\\\${next.toLowerCase()}`));
      o["event-state"] = next;
    }
  };

  /** Answers the BACnet, history, alarm and monitoring routes; undefined for anything else. */
  return function route(method: string, path: string, body: any): Response | undefined {
    const v2 = "/api/rest/v2/services";
    if (!path.startsWith(v2)) return undefined;
    const p = path.slice(v2.length);
    const json = (data: unknown, status = 200) => Response.json(data, { status });
    const notFound = () => json({ message: `Unknown resource ${p}` }, 404);

    if (method === "GET" && p === "/monitoring") return json({ cpu: { usage: 23 }, memory: { total: 2048, used: 1290 }, uptime: 864000 });
    if (method === "GET" && p === "/platform/time/date-time") return json({ $value: new Date().toISOString() });
    if (method === "GET" && p === "/bacnet/local/instance-id") return json({ $value: 300001 });
    if (method === "GET" && p === "/bacnet/local/objects") return json(local);
    if (method === "GET" && p === "/bacnet/remote/devices") return json(remote);

    /** Writes a value at a priority and recomputes the present value, like BACnet commandable objects. */
    const command = (o: Props) => {
      const pa = o["priority-array"] as unknown[] | undefined;
      const prio = Number(body?.priority);
      if (!Array.isArray(pa) || !(prio >= 1 && prio <= 16)) return json({ message: "Invalid priority" }, 400);
      pa[prio - 1] = body?.value ?? null;
      const active = pa.findIndex((x) => x !== null);
      o["present-value"] = active < 0 ? o["relinquish-default"] : pa[active];
      o["current-command-priority"] = active < 0 ? null : active + 1;
      return json({});
    };

    if (method === "GET" && p === "/bacnet/remote/policies") return json(policies);
    if (method === "GET" && p === "/bacnet/remote") return json({ "discover-devices-job": null });
    if (method === "POST" && p === "/bacnet/remote/discover-devices") {
      // clear-transients: the previous discoveries that were not kept go away.
      for (const [id, d] of Object.entries(remote)) if (d.persisted === false && body?.["clear-transients"]) delete remote[id];
      for (const [id, d] of Object.entries(network)) {
        const inRange = (body?.["low-limit"] ?? 0) <= Number(id) && Number(id) <= (body?.["high-limit"] ?? 4194302);
        if (!remote[id] && inRange) remote[id] = { ...d, objects: {}, persisted: false, "discovery-status": "Discovered" };
      }
      return json({ job: "27" });
    }
    const discoverObjects = /^\/bacnet\/remote\/devices\/(\d+)\/discover-objects$/.exec(p);
    if (method === "POST" && discoverObjects) {
      const id = discoverObjects[1]!;
      if (!remote[id]) return notFound();
      for (const [col, items] of Object.entries(network[id]?.objects ?? {})) {
        remote[id]!.objects[col] ??= {};
        for (const [inst, o] of Object.entries(items)) remote[id]!.objects[col]![inst] ??= { key: inst, ...o, persisted: false, "present-value": null };
      }
      return json({ job: "28" });
    }

    // Remote devices: like a real APEX, the name and address given at creation are ignored, a second POST sets them.
    const remoteDevice = /^\/bacnet\/remote\/devices\/(\d+)$/.exec(p);
    if (remoteDevice) {
      const id = remoteDevice[1]!;
      const dev = remote[id];
      if (method === "GET") return dev ? json({ key: id, ...dev }) : notFound();
      if (method === "DELETE") {
        if (!dev) return notFound();
        delete remote[id];
        return json({});
      }
      if (method === "POST") {
        if (!dev) {
          remote[id] = { "local-name": "", description: "", "connection-status": "Unknown", address: { "network-number": 0, type: "Unknown" }, objects: {} };
          return json({}, 201);
        }
        const { objects: _ignored, ...rest } = body ?? {};
        Object.assign(dev, rest);
        return json({});
      }
    }
    if (method === "POST" && /^\/bacnet\/remote\/devices\/\d+\/objects\/add$/.test(p)) {
      const dev = remote[p.split("/")[4]!];
      const col = BACNET_NAMES[body?.["object-type"]];
      if (!dev) return notFound();
      if (!col) return json({ error: { type: "ParameterConversionException", message: "Cannot convert value of object-type" } }, 400);
      dev.objects[col] ??= {};
      dev.objects[col][String(body["instance-number"])] = { key: String(body["instance-number"]), "local-name": body.name, persisted: false, policy: null, "present-value": col.includes("binary") ? "inactive" : 0 };
      return json({ results: `${col}/${body["instance-number"]}` });
    }

    const remoteObjects = /^\/bacnet\/remote\/devices\/(\d+)\/objects(?:\/([a-z-]+)\/(\d+))?(?:\/([a-z-]+))?$/.exec(p);
    if (remoteObjects) {
      const dev = remote[remoteObjects[1]!];
      if (!dev) return notFound();
      if (!remoteObjects[2]) return method === "GET" ? json(dev.objects) : notFound();
      const o = dev.objects[remoteObjects[2]]?.[remoteObjects[3]!];
      if (!o) return notFound();
      if (method === "GET" && !remoteObjects[4]) return json(o);
      if (method === "POST" && remoteObjects[4] === "set-value-at") return command(o);
      if (method === "POST" && !remoteObjects[4]) {
        if (body?.policy !== undefined && !(body.policy in policies)) return json({ error: { type: "ParameterException", message: "Unknown policy" } }, 400);
        Object.assign(o, body, body?.policy ? { persisted: true } : {});
        // Like a real APEX: keeping a point of a discovered device keeps the device, and the point gets its value.
        if (body?.policy) {
          dev.persisted = true;
          const live = network[remoteObjects[1]!]?.objects[remoteObjects[2]!]?.[remoteObjects[3]!];
          if (live) o["present-value"] = live["present-value"];
        }
        return json({});
      }
      if (method === "DELETE" && !remoteObjects[4]) {
        delete dev.objects[remoteObjects[2]]![remoteObjects[3]!];
        return json({});
      }
      return notFound();
    }

    // Modbus client.
    if (method === "GET" && p === "/modbus/networks") return json(modbus.networks);
    if (method === "GET" && p === "/modbus/devices") return json(modbus.devices);
    const mb = /^\/modbus\/devices\/([^/]+)(?:\/points(?:\/([^/]+))?)?$/.exec(p);
    if (mb) {
      const name = decodeURIComponent(mb[1]!);
      const dev = modbus.devices[name];
      const inPoints = p.includes("/points");
      if (!inPoints) {
        if (method === "GET") return dev ? json(dev) : notFound();
        if (method === "DELETE") return dev ? (delete modbus.devices[name], json({})) : notFound();
        if (method === "POST") {
          if (dev) return json({}, 200);
          modbus.devices[name] = { key: name, encoding, enabled: true, "device-status": "NoHeartbeatDefined", ...body, points: {} };
          return json({}, 201);
        }
      }
      if (!dev) return notFound();
      const point = mb[2] ? decodeURIComponent(mb[2]) : undefined;
      const REGISTERS = ["HoldingRegister", "InputRegister", "Coils", "DiscreteInput"];
      const TYPES = ["Bit", "Int16", "Uint16", "Int32", "Uint32", "Int64", "Float", "Double"];
      const valid = (x: Props) => REGISTERS.includes(String(x["register-type"])) && TYPES.includes(String(x["data-type"]));
      if (!point && method === "GET") return json(dev.points);
      if (!point && method === "POST") {
        const all = Object.entries(body ?? {}) as [string, Props][];
        if (all.some(([, x]) => !valid(x))) return json({ error: { type: "ParameterConversionException", message: "Cannot convert value of register-type from 'String' to 'RegisterType'" } }, 400);
        for (const [k, x] of all) dev.points[k] = { ...x, "present-value": 0, "modbus-status": "Ok" };
        return json({});
      }
      if (point && method === "GET") return dev.points[point] ? json(dev.points[point]) : notFound();
      if (point && method === "DELETE") return dev.points[point] ? (delete dev.points[point], json({})) : notFound();
      if (point && method === "POST") {
        if (!valid(body ?? {})) return json({ error: { type: "ParameterConversionException", message: "Cannot convert value" } }, 400);
        dev.points[point] = { ...body, "present-value": 0, "modbus-status": "Ok" };
        return json({}, 201);
      }
    }

    // GFX configuration.
    if (method === "GET" && p === "/gfx/configuration") return json(gfxConfig);
    const nv = /^\/gfx\/configuration\/([a-z-]+-\d+)$/.exec(p);
    if (method === "GET" && nv) return gfxConfig[nv[1]!] ? json({ $value: gfxConfig[nv[1]!] }) : notFound();
    if (method === "POST" && p === "/gfx/configuration/add-update-network-value") {
      const key = `network-value-${body?.number}`;
      if (!gfxConfig[key]) return json({ error: { type: "ParameterException", message: "Unknown network value" } }, 400);
      const type = /objects\/([a-z-]+)\//.exec(gfxConfig[key]![0]!)?.[1];
      const target = `/services/bacnet/remote/devices/${body["device-instance"]}/objects/${type}/${body["object-instance"]}`;
      gfxConfig[key] = [target, `/services/gfx/runtime/objects/network-values/${Number(body.number) - 1}`];
      return json({ results: target });
    }

    if (method === "POST" && p === "/bacnet/local/objects/add") {
      const collections: Record<string, string> = { AnalogValue: "analog-values", BinaryValue: "binary-values", MultiStateValue: "multi-state-values", Schedule: "schedules", TrendLog: "trend-logs" };
      const col = collections[body?.["object-type"]];
      const inst = String(body?.["instance-number"] ?? "");
      if (!col || !/^\d+$/.test(inst) || !body?.name) return json({ error: { type: "ParameterException", message: "Invalid object" } }, 400);
      local[col] ??= {};
      if (local[col][inst]) return json({ error: { type: "ConflictException", message: "Object already exists" } }, 409);
      const base: Props = { "object-name": body.name, "status-flags": flags(), "out-of-service": false, "event-state": "Normal" };
      local[col][inst] =
        col === "trend-logs"
          ? { ...base, "logging-type": "Polled", "logging-interval": 90000, "buffer-size": 672, enable: true, history: body.name }
          : col === "schedules"
          ? { ...base, type: "Enumerated", "schedule-state-text": ["Occupied", "Unoccupied", "Bypass", "Standby"].map((string, i) => ({ string, value: i + 1 })), "present-value": null, "weekly-schedule": Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => [d, { transitions: {} }])), "special-events": {} }
          : { ...base, "present-value": col === "binary-values" ? "inactive" : col === "multi-state-values" ? 1 : 0, "priority-array": Array.from({ length: 16 }, () => null), "relinquish-default": col === "binary-values" ? "inactive" : col === "multi-state-values" ? 1 : 0, "current-command-priority": null };
      return json({});
    }

    const obj = /^\/bacnet\/local\/objects\/([a-z-]+)(?:\/(\d+))?(?:\/([a-z-]+))?$/.exec(p);
    if (obj) {
      const [, type, inst, prop] = obj;
      const col = local[type!];
      if (!col) return notFound();
      if (!inst) return method === "GET" ? json(col) : notFound();
      const o = col[inst];
      if (!o) return notFound();
      if (method === "GET" && !prop) return json(o);
      if (method === "GET" && prop) return prop in o ? json({ $value: o[prop] }) : notFound();
      if (method === "DELETE" && !prop) {
        delete col[inst];
        return json({});
      }
      if (method === "POST" && prop === "set-value-at") {
        const res = command(o);
        evaluateAlarm(`${type}/${inst}`, o);
        return res;
      }
      if (method === "POST" && !prop) {
        const { alarm, ...rest } = body ?? {};
        Object.assign(o, rest);
        // Like a real APEX: an alarm block is only taken once its detection is enabled.
        if (alarm && (alarm["event-detection-enable"] || o.alarm)) o.alarm = { ...(o.alarm as object), ...alarm };
        if (alarm) evaluateAlarm(`${type}/${inst}`, o);
        return json({});
      }
      if (method === "POST" && prop === "weekly-schedule" && type === "schedules") {
        // Like a real APEX: the 7 days are required, and an enumerated schedule rejects booleans.
        const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
        if (!days.every((d) => body?.[d])) {
          return json({ error: { type: "RestException", message: "Error setting properties to weekly-schedule Cause: com.serotonin.bacnet4j.exception.BACnetServiceException: class=property, code=value-out-of-range" } }, 400);
        }
        const values = Object.values(body ?? {}).flatMap((d: any) => Object.values(d?.transitions ?? {}).map((t: any) => t.value));
        const bad = values.find((v) => v !== null && (o.type === "Enumerated" ? !Number.isInteger(v) : o.type === "Boolean" ? typeof v !== "boolean" : false));
        if (bad !== undefined) return json({ error: { type: "RestException", message: `Error setting properties to weekly-schedule Cause: For input string: "${bad}"` } }, 400);
        o["weekly-schedule"] = { ...(o["weekly-schedule"] as object), ...body };
        return json({});
      }
      if (method === "POST" && prop === "special-events" && type === "schedules") {
        o["special-events"] = body;
        return json({});
      }
      return notFound();
    }

    if (method === "GET" && p === "/history/groups/bacnet/histories") {
      // Trend logs created on the controller show up as histories, like on a real APEX.
      const created = Object.fromEntries(
        Object.values(local["trend-logs"] ?? {}).flatMap((t: any) => {
          const ref = t["source-reference"];
          if (!ref) return [];
          const col = Object.entries(BACNET_NAMES).find(([n]) => n === ref["object-identifier"]?.["object-type"])?.[1];
          const dev = ref["device-identifier"]?.["object-instance"];
          const source = `/services/bacnet/${dev ? `remote/devices/${dev}` : "local"}/objects/${col}/${ref["object-identifier"]["object-instance"]}/present-value`;
          return [[t["object-name"], { key: t["object-name"], "full-policy": `bacnet-size-${t["buffer-size"]}`, source, enabled: t.enable }]];
        }),
      );
      return json({ ...histories, ...created });
    }
    if (method === "POST" && p === "/history/groups/bacnet/histories/get-table") {
      const name = String(body?.history ?? "");
      if (!histories[name]) return json({ message: `History not found: ${name}` }, 404);
      const [from, to] = String(body?.["time-range"] ?? "").split("/").map((x) => Date.parse(x));
      if (!Number.isFinite(from) || !Number.isFinite(to)) return json({ message: "Invalid time-range" }, 400);
      const tenDays = Date.now() - 10 * 86400e3;
      // Same shape as a real APEX (firmware observed in October 2026).
      const columns = ["timestamp", "flags", "value", "asn1"].map((n) => ({ name: n, type: n === "value" ? "number" : "string" }));
      return json({ columns, rows: trend(name, Math.max(from!, tenDays), Math.min(to!, Date.now())) });
    }
    if (method === "POST" && p === "/alarms/get-alarm-table") {
      const columns = ["id", "timestamp", "alarm-class", "source", "from-state", "to-state", "ack-state", "ack-user", "message"].map((name) => ({ name, type: "string" }));
      return json({ columns, rows: alarms });
    }
    if (method === "POST" && p === "/alarms/ack-alarms") {
      if (!Array.isArray(body?.ids)) return json({ error: { type: "EmptyOrNullParameterException", message: "The value of 'ids' must be specified." } }, 400);
      for (const r of alarms) if (body.ids.includes(r.id)) Object.assign(r, { "ack-state": "Acked", "ack-user": "mcp" });
      return json({});
    }
    if (method === "GET" && p === "/alarms/classes") return json(alarmClasses);
    if (method === "GET" && p === "/alarms/recipients") return json({});
    if (method === "GET" && (p === "/email/accounts" || p === "/mqtt/connections")) return json({});
    const addAlarm = /^\/alarms\/classes\/([^/]+)\/add-alarm$/.exec(p);
    if (method === "POST" && addAlarm) {
      if (!(addAlarm[1]! in alarmClasses)) return notFound();
      if (!body?.["to-state"]) return json({ error: { type: "EmptyOrNullParameterException", message: "The value of 'to-state' must be specified." } }, 400);
      const row = alarmRow(alarms.length + 1, 0, String(body.source), String(body["from-state"]), String(body["to-state"]), "Unacked", String(body.message ?? ""));
      alarms.push(row);
      return json({ results: row.id });
    }

    // Configuration backups (a few seconds on a real APEX, immediate here).
    if (method === "GET" && p === "/backup") return json({ "external-backups": {}, excludes: ["DeviceIdentity", "Designer", "AlarmsTrends", "Users"], job: null, backups });
    if (method === "POST" && p === "/backup/backups/create") {
      const key = String(body?.item ?? "");
      if (!key) return json({ error: { type: "EmptyOrNullParameterException", message: "The value of 'item' must be specified." } }, 400);
      backups[key] = { key, size: 1065989, "creation-time": new Date().toISOString().replace(/\.\d+Z$/, "Z"), includes: ["DeviceIdentity", "Designer", "AlarmsTrends", "Users"] };
      return json({ job: "33" });
    }
    if (method === "POST" && p === "/backup/backups/restore") return backups[String(body?.item)] ? json({ job: "34" }) : json({ error: { type: "ParameterException", message: "Unknown backup" } }, 400);
    const backup = /^\/backup\/backups\/([^/]+)$/.exec(p);
    if (method === "DELETE" && backup) return backups[backup[1]!] ? (delete backups[backup[1]!], json({})) : notFound();
    return undefined;
  };
}
