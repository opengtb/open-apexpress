// MCP server for a Distech ECLYPSE APEX: gives Claude (or any MCP client) read access to the
// controller through its REST API v2, and optional supervised writes. Runs with plain Node.js in a
// container on the APEX itself: no npm dependency, the file is written by the container command.
// Transport: MCP Streamable HTTP, stateless, JSON answers. Auth: one shared token (Bearer header or
// /mcp/<token> path for clients that cannot send headers, like claude.ai custom connectors).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";

const env = process.env;
const APEX = (env.APEX_URL || "https://127.0.0.1").replace(/\/+$/, "");
const APEX_AUTH = "Basic " + Buffer.from(`${env.APEX_USER || ""}:${env.APEX_PASSWORD || ""}`).toString("base64");
const TOKEN = env.MCP_TOKEN || "";
const PORT = Number(env.PORT || 8080);
const DATA = (env.DATA_DIR || "/data").replace(/\/+$/, "");
const ALLOW_WRITE = env.ALLOW_WRITE === "true";
const PRIORITY = Number(env.WRITE_PRIORITY || 16);
/** Priorities 1-7 are for life safety and manual operator commands: never written by the model. */
const MIN_PRIORITY = Math.min(PRIORITY, Math.max(1, Number(env.WRITE_MIN_PRIORITY || 8)));
/** Optional whitelist: only objects whose name matches may be written. */
const WRITE_ALLOW = env.WRITE_ALLOW ? new RegExp(env.WRITE_ALLOW, "i") : null;
const INFLUX = env.INFLUX_URL && env.INFLUX_TOKEN ? { url: env.INFLUX_URL.replace(/\/+$/, ""), token: env.INFLUX_TOKEN, org: env.INFLUX_ORG || "apex", bucket: env.INFLUX_BUCKET || "apex" } : null;
const MAX_TEXT = 60000;
const VERSION = "1.6.1";

// --- ECLYPSE REST API -----------------------------------------------------------------------------

/** One call to /api/rest/v2 (self-signed certificate of the controller accepted). */
function apex(method, path, body) {
  const url = new URL(APEX + "/api/rest/v2" + path);
  const lib = url.protocol === "https:" ? https : http;
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        rejectUnauthorized: false,
        timeout: 30000,
        headers: { Authorization: APEX_AUTH, Accept: "application/json", ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = text;
          }
          if (res.statusCode >= 400) {
            const hint = /PasswordReset/.test(text)
              ? " (ce compte APEX doit changer son mot de passe : connectez-vous une fois avec lui sur l'interface web de l'APEX, ou décochez la réinitialisation dans Utilisateurs, puis réinstallez le MCP avec le nouveau mot de passe)"
              : res.statusCode === 401 ? " (identifiants APEX refusés)" : res.statusCode === 403 ? " (droits insuffisants pour ce compte APEX)" : "";
            reject(new Error(`APEX ${res.statusCode}${hint} ${method} ${path}: ${typeof json === "string" ? json : JSON.stringify(json)}`.slice(0, 600)));
          } else resolve(json);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`APEX injoignable (délai dépassé) : ${method} ${path}`)));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** GET with a $select, retried without it if the controller rejects the selection. */
async function apexSelect(path, select) {
  try {
    return await apex("GET", `${path}?$select=${select}`);
  } catch (e) {
    // Selections are not documented for every service: fall back to the full resource.
    if (/^APEX \d+ /.test(e.message) && !/^APEX 40[13] /.test(e.message)) return apex("GET", path);
    throw e;
  }
}

/** {"$value": x} wrappers removed, recursively. */
function unwrap(v) {
  if (Array.isArray(v)) return v.map(unwrap);
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if ("$value" in v && keys.every((k) => k === "$value" || k === "key")) return unwrap(v.$value);
    return Object.fromEntries(keys.map((k) => [k, unwrap(v[k])]));
  }
  return v;
}

/** Items of a collection, whether the API answers a map keyed by id or an array. */
function entries(c) {
  if (Array.isArray(c)) return c.map((x, i) => [String(x?.key ?? i), x]).filter(([, x]) => x && typeof x === "object");
  if (c && typeof c === "object") return Object.entries(c).filter(([, x]) => x && typeof x === "object" && !Array.isArray(x));
  return [];
}

const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  return undefined;
};
const fmt = (v) => (v === undefined ? "?" : typeof v === "object" ? JSON.stringify(v) : String(v));
/** Secrets the API returns in clear (Wi-Fi hotspot password…) never reach the model. */
const SECRET_KEY = /pass(word|phrase)?$|secret|token|psk|private-key|api-key/i;
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY.test(k) && typeof x === "string" && x !== "" ? "<masqué>" : redact(x)]));
  return v;
}
const json = (v) => JSON.stringify(redact(unwrap(v)), null, 2);

/** Active flags of a BACnet status-flags value, whatever its shape. */
function flags(o) {
  const out = [];
  const sf = unwrap(pick(o, "status-flags", "status"));
  if (sf && typeof sf === "object" && !Array.isArray(sf)) for (const [k, v] of Object.entries(sf)) v === true && out.push(k);
  else if (Array.isArray(sf)) out.push(...sf.map(String));
  else if (typeof sf === "string" && sf && !/^(normal|ok|none)$/i.test(sf)) out.push(sf);
  if (unwrap(o["out-of-service"]) === true && !out.some((f) => /out.?of.?service/i.test(f))) out.push("out-of-service");
  return out;
}

const POINT_COLLECTION = /(inputs|outputs|values)$/;
const OBJECT_TYPE = /^[a-z][a-z-]*s$/;
const INSTANCE = /^\d+$/;

function objectsPath(device) {
  if (device === undefined || device === null || device === "") return "/services/bacnet/local/objects";
  if (!INSTANCE.test(String(device))) throw new Error("device : numéro d'instance BACnet attendu (ex. 210066).");
  return `/services/bacnet/remote/devices/${device}/objects`;
}

/** "analog-values/464" → { type, instance }. */
function parsePoint(ref) {
  const m = /^([a-z][a-z-]*s)\/(\d+)$/.exec(String(ref ?? "").trim());
  if (!m) throw new Error(`Point invalide : ${ref} (format type/instance, ex. analog-values/464).`);
  return { type: m[1], instance: m[2] };
}

function checkPoint(type, instance) {
  if (!OBJECT_TYPE.test(String(type)) || !INSTANCE.test(String(instance))) throw new Error("type (ex. analog-values) et instance (entier) attendus.");
}

/** Value shown with its state text for multi-state objects ("2 (Confort)"). */
function display(col, o) {
  let value = o["present-value"];
  const states = o["state-text"];
  if (col.startsWith("multi-state") && Array.isArray(states) && typeof value === "number" && states[value - 1] !== undefined) value = `${value} (${states[value - 1]})`;
  return `${fmt(value)}${o.units && o.units !== "NoUnits" ? ` ${o.units}` : ""}`;
}

/** Flags of a point plus its event state and the priority commanding it. */
function badges(o) {
  const f = flags(o);
  const ev = o["event-state"];
  if (typeof ev === "string" && !/^normal$/i.test(ev) && !f.some((x) => x.toLowerCase() === ev.toLowerCase())) f.push(`event:${ev}`);
  const prio = o["current-command-priority"];
  if (typeof prio === "number") f.push(`prio ${prio}`);
  return f;
}

const STATUS_FILTERS = {
  alarm: (b) => b.some((x) => /alarm|event:/i.test(x)),
  fault: (b) => b.some((x) => /fault/i.test(x)),
  overridden: (b) => b.some((x) => /overridden/i.test(x)),
  "out-of-service": (b) => b.some((x) => /out-of-service/i.test(x)),
  commanded: (b) => b.some((x) => /^prio /.test(x)),
  abnormal: (b) => b.some((x) => !/^prio /.test(x)),
};

/** Runs async jobs with a small concurrency, the controller is not a server farm. */
async function pool(items, size, job) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await job(items[i]).then(
          (v) => ({ ok: true, v }),
          (e) => ({ ok: false, e }),
        );
      }
    }),
  );
  return out;
}

// --- History records -----------------------------------------------------------------------------

const TIME_KEY = /^(timestamp|time|date|date-?time|ts|t)$/i;
const VALUE_KEY = /^(value|\$value|present-value|v|val)$/i;

function toNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    if (/^(active|on|true)$/i.test(v)) return 1;
    if (/^(inactive|off|false)$/i.test(v)) return 0;
    const n = Number(v);
    if (v.trim() !== "" && Number.isFinite(n)) return n;
  }
  if (v && typeof v === "object" && "$value" in v) return toNumber(v.$value);
  return undefined;
}

/** {t, v} records found anywhere in a history answer (the format is not documented). */
function extractRecords(data) {
  const out = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node) && node.length === 2 && !Number.isNaN(Date.parse(node[0])) && toNumber(node[1]) !== undefined) {
      out.push({ t: Date.parse(node[0]), v: toNumber(node[1]) });
      return;
    }
    if (!Array.isArray(node)) {
      const keys = Object.keys(node);
      const tk = keys.find((k) => TIME_KEY.test(k) && typeof node[k] !== "object" && !Number.isNaN(Date.parse(String(node[k]))));
      const vk = keys.find((k) => VALUE_KEY.test(k) && toNumber(node[k]) !== undefined);
      if (tk && vk) {
        out.push({ t: Date.parse(String(node[tk])), v: toNumber(node[vk]) });
        return;
      }
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child, depth + 1);
  };
  walk(data, 0);
  return out.sort((a, b) => a.t - b.t);
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.000Z$/, "Z");
const round = (x) => (Math.abs(x) >= 100 ? Math.round(x * 10) / 10 : Math.round(x * 1000) / 1000);

function summarize(records, interval) {
  if (!records.length) return "Aucun enregistrement sur cette période.";
  const vals = records.map((r) => r.v);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const lines = [
    `${records.length} enregistrements, du ${iso(records[0].t)} au ${iso(records.at(-1).t)}.`,
    `min ${round(Math.min(...vals))} · max ${round(Math.max(...vals))} · moyenne ${round(avg)} · dernière ${round(vals.at(-1))}`,
    "",
  ];
  let mode = interval || "auto";
  if (mode === "auto") {
    const span = records.at(-1).t - records[0].t;
    mode = records.length <= 300 ? "raw" : span / 3600e3 <= 400 ? "hour" : "day";
  }
  if (mode === "raw") {
    lines.push("horodatage;valeur", ...records.slice(-1000).map((r) => `${iso(r.t)};${r.v}`));
    if (records.length > 1000) lines.push(`(seuls les 1000 derniers sont listés, demandez interval=hour ou day)`);
    return lines.join("\n");
  }
  const size = mode === "day" ? 86400e3 : 3600e3;
  const buckets = new Map();
  for (const r of records) {
    const k = Math.floor(r.t / size) * size;
    const b = buckets.get(k) ?? { n: 0, sum: 0, min: Infinity, max: -Infinity };
    b.n++;
    b.sum += r.v;
    b.min = Math.min(b.min, r.v);
    b.max = Math.max(b.max, r.v);
    buckets.set(k, b);
  }
  lines.push(`Agrégation par ${mode === "day" ? "jour" : "heure"} (UTC) :`, "début;moyenne;min;max;n");
  for (const [k, b] of buckets) lines.push(`${iso(k)};${round(b.sum / b.n)};${round(b.min)};${round(b.max)};${b.n}`);
  return lines.join("\n");
}

function parseDate(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  const rel = /^-?(\d+)\s*([hdw])$/i.exec(String(v).trim());
  if (rel) return Date.now() - Number(rel[1]) * { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[rel[2].toLowerCase()];
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) throw new Error(`Date invalide : ${v} (ISO 8601 ou relatif : 24h, 7d, 2w).`);
  return t;
}

const historiesPath = (group) => `/services/history/groups/${encodeURIComponent(group || "bacnet")}/histories`;

/** Trend logs with the point they record ("source"). */
async function trendLogs(group) {
  return entries(await apex("GET", historiesPath(group))).map(([key, raw]) => {
    const o = unwrap(raw);
    const source = String(o.source ?? "");
    const point = /\/objects\/([a-z-]+\/\d+)\//.exec(source)?.[1];
    return { key: o.key ?? key, source, point, device: /\/remote\/devices\/(\d+)\//.exec(source)?.[1], info: o };
  });
}

/** Trend log name from a name or a point ("analog-values/464"). */
async function resolveHistory({ history, point, device, group }) {
  if (history) return String(history);
  if (!point) throw new Error("history (nom du trend log) ou point (ex. analog-values/464) attendu.");
  const { type, instance } = parsePoint(point);
  const logs = (await trendLogs(group)).filter((l) => l.point === `${type}/${instance}` && (device ? l.device === String(device) : !l.device));
  if (!logs.length) throw new Error(`Aucun trend log n'enregistre ${type}/${instance}. Voir list_trend_logs.`);
  return logs[0].key;
}

/** Records of a trend log over a time range, oldest first. */
async function fetchRecords(history, start, end, group) {
  const range = `${new Date(start).toISOString()}/${new Date(end).toISOString()}`;
  const base = historiesPath(group);
  let data;
  try {
    data = await apex("POST", `${base}/get-table`, { history, "time-range": range, limit: 0 });
  } catch (e) {
    data = await apex("POST", `${base}/get-history`, { history, delta: false, "time-range": range, interval: null, "delta-timestamps": "Leading" }).catch(() => {
      throw e;
    });
  }
  const records = extractRecords(data);
  const recognized = records.length > 0 || !data || typeof data !== "object" || Array.isArray(data.rows) || !Object.keys(data).length;
  return { records, range, raw: recognized ? undefined : data };
}

// --- Site notes ----------------------------------------------------------------------------------

const NOTES = `${DATA}/site.md`;
const readNotes = () => {
  try {
    return readFileSync(NOTES, "utf8");
  } catch {
    return "";
  }
};
function log(entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.log(line);
  try {
    mkdirSync(DATA, { recursive: true });
    appendFileSync(`${DATA}/writes.log`, line + "\n");
  } catch {
    /* read-only volume: stdout keeps the trace */
  }
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** Values and texts of an enumerated schedule ("schedule-state-text": [{string, value}]). */
function scheduleStates(o) {
  const list = Array.isArray(o?.["schedule-state-text"]) ? o["schedule-state-text"] : [];
  return new Map(list.filter((x) => x && typeof x === "object").map((x) => [x.value, String(x.string ?? x.text ?? x.value)]));
}

/** A transition value converted to the type of the schedule (Enumerated, Boolean, Real…). */
function scheduleValue(o, v) {
  if (v === null || v === undefined) return null;
  const type = String(o?.type ?? "");
  if (/enum/i.test(type)) {
    const states = scheduleStates(o);
    const n = typeof v === "boolean" || v === "" ? NaN : Number(v);
    if (Number.isInteger(n) && (!states.size || states.has(n))) return n;
    for (const [value, text] of states) if (text.toLowerCase() === String(v).toLowerCase()) return value;
    throw new Error(`Valeur « ${v} » invalide pour ce programme énuméré : ${[...states].map(([n, t]) => `${n}=${t}`).join(", ") || "entier attendu"}.`);
  }
  if (/bool/i.test(type)) {
    if (v === true || /^(true|active|on|1)$/i.test(String(v))) return true;
    if (v === false || /^(false|inactive|off|0)$/i.test(String(v))) return false;
    throw new Error("Programme booléen : true ou false attendu.");
  }
  if (/real|unsigned|integer|double/i.test(type)) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Programme ${type} : nombre attendu.`);
    return n;
  }
  return v;
}

// --- Tools ---------------------------------------------------------------------------------------

const DEVICE = { type: ["string", "integer"], description: "Instance BACnet d'un équipement distant (voir list_devices). Vide = objets locaux de l'APEX." };
const TYPE = { type: "string", description: "Type d'objet au pluriel kebab-case : analog-values, analog-inputs, binary-values, multi-state-values…" };

const TOOLS = [
  {
    name: "controller_info",
    description: "Identité et état de l'automate ECLYPSE APEX : modèle, firmware, nom, heure, charge CPU/RAM (services platform et monitoring).",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const parts = await Promise.allSettled([
        apex("GET", "/services/platform"),
        apex("GET", "/services/monitoring"),
        apex("GET", "/services/platform/time/date-time"),
        apex("GET", "/services/bacnet/local/instance-id"),
      ]);
      const [platform, monitoring, time, device] = parts.map((p) => (p.status === "fulfilled" ? unwrap(p.value) : `indisponible : ${p.reason.message}`));
      // The platform service also holds the whole network setup: keep only what describes the controller.
      let identity = platform;
      if (platform && typeof platform === "object") {
        const { network, debug, monitoring: _m, ...rest } = platform;
        const ip = Object.values(network?.interfaces ?? {})
          .map((i) => i?.ipv4?.["ip-address"])
          .filter(Boolean);
        identity = { ...rest, hostname: network?.hostname, "ip-addresses": ip };
      }
      const mon = monitoring?.sensors || monitoring?.storage ? monitoring : (platform?.monitoring ?? monitoring);
      const sensors = Object.fromEntries(Object.entries(mon?.sensors ?? {}).map(([k, s]) => [k, s && typeof s === "object" ? `${s.value} ${s.units ?? ""}`.trim() : s]));
      const gb = (b) => (typeof b === "number" ? `${Math.round(b / 1e8) / 10} Go` : b);
      const st = mon?.storage?.internal;
      const storage = st ? { used: gb(st["used-space"]), free: gb(st["free-space"]), total: gb(st["total-space"]), containers: gb(st.categories?.containers?.["used-space"]) } : undefined;
      return json({ controller: identity, time, "bacnet-device-instance": device, uptime: mon?.jvm?.uptime, sensors, storage, "java-heap": mon?.jvm?.memory ? { used: gb(mon.jvm.memory["heap-used"]), max: gb(mon.jvm.memory["heap-max"]) } : undefined, ...(typeof monitoring === "string" ? { monitoring } : {}) });
    },
  },
  {
    name: "list_points",
    description:
      "Liste les points BACnet (AI/AO/AV/BI/BO/BV/MSI/MSO/MSV) avec nom, valeur présente, unité et drapeaux (alarme, défaut, forçage, hors service, priorité qui commande). Une ligne par point : type/instance | nom | valeur unité [drapeaux]. Filtrer par type, texte ou état pour rester concis.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Filtre de type, ex. analog-values ou analog (correspondance partielle)." },
        search: { type: "string", description: "Texte recherché dans le nom ou la description (insensible à la casse). Plusieurs mots = tous présents." },
        status: { type: "string", enum: Object.keys(STATUS_FILTERS), description: "Seulement les points en alarme, en défaut, forcés, hors service, commandés à une priorité, ou tout état anormal." },
        device: DEVICE,
        limit: { type: "integer", description: "Nombre maximum de lignes (300 par défaut)." },
      },
    },
    async run({ type, search, status, device, limit }) {
      const path = objectsPath(device);
      const props = device
        ? "object-name,name,local-name,present-value,units,status($select=$value),out-of-service,event-state,current-command-priority,state-text,persisted"
        : "object-name,present-value,units,status-flags,out-of-service,description,state-text,event-state,current-command-priority";
      const data = await apexSelect(path, `*($select=*($select=${props}))`);
      const lines = [];
      const words = String(search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const keep = status ? STATUS_FILTERS[status] : null;
      if (status && !keep) throw new Error(`status parmi ${Object.keys(STATUS_FILTERS).join(", ")}.`);
      for (const [col, items] of Object.entries(data ?? {})) {
        if (!POINT_COLLECTION.test(col) || (type && !col.includes(String(type).toLowerCase()))) continue;
        for (const [inst, raw] of entries(items)) {
          const o = unwrap(raw);
          const name = pick(o, "local-name", "object-name", "name") ?? "";
          const text = `${name} ${o.description ?? ""}`.toLowerCase();
          if (words.some((w) => !text.includes(w))) continue;
          const b = badges(o);
          if (keep && !keep(b)) continue;
          lines.push(`${col}/${inst} | ${name} | ${o.persisted === false ? "non gardé" : display(col, o)}${b.length ? ` [${b.join(", ")}]` : ""}`);
        }
      }
      const max = Number(limit) > 0 ? Number(limit) : 300;
      if (!lines.length) {
        if (device && !Object.keys(data ?? {}).length) return `Aucun objet connu pour l'équipement ${device} : lancez discover_objects pour lire ses points.`;
        return "Aucun point ne correspond. Collections présentes : " + Object.keys(data ?? {}).join(", ");
      }
      return [`${lines.length} point(s)${lines.length > max ? `, ${max} affichés (affinez avec type ou search)` : ""} :`, ...lines.slice(0, max)].join("\n");
    },
  },
  {
    name: "read_point",
    description: "Toutes les propriétés d'un objet BACnet : valeur présente, tableau de priorités (qui commande et à quelle priorité), drapeaux, limites, texte des états…",
    inputSchema: { type: "object", properties: { type: TYPE, instance: { type: "integer" }, device: DEVICE }, required: ["type", "instance"] },
    async run({ type, instance, device }) {
      checkPoint(type, instance);
      return json(await apex("GET", `${objectsPath(device)}/${type}/${instance}`));
    },
  },
  {
    name: "read_points",
    description: "Lit plusieurs points d'un coup (jusqu'à 50) : valeur présente, unité et drapeaux. Plus rapide que read_point en boucle pour comparer des grandeurs.",
    inputSchema: {
      type: "object",
      properties: {
        points: { type: "array", items: { type: "string" }, description: "Liste type/instance, ex. [\"analog-values/459\", \"analog-values/460\"]." },
        device: DEVICE,
      },
      required: ["points"],
    },
    async run({ points, device }) {
      if (!Array.isArray(points) || !points.length || points.length > 50) throw new Error("points : liste de 1 à 50 références type/instance.");
      const refs = points.map(parsePoint);
      const base = objectsPath(device);
      const props = "object-name,name,local-name,present-value,units,status-flags,status($select=$value),out-of-service,event-state,current-command-priority,state-text";
      const results = await pool(refs, 6, (r) => apexSelect(`${base}/${r.type}/${r.instance}`, props));
      return refs
        .map((r, i) => {
          const res = results[i];
          if (!res.ok) return `${r.type}/${r.instance} | erreur : ${res.e.message}`;
          const o = unwrap(res.v);
          const b = badges(o);
          return `${r.type}/${r.instance} | ${pick(o, "local-name", "object-name", "name") ?? ""} | ${display(r.type, o)}${b.length ? ` [${b.join(", ")}]` : ""}`;
        })
        .join("\n");
    },
  },
  {
    name: "list_devices",
    description: "Équipements BACnet distants connus de l'APEX (instance, nom, adresse, état de connexion). Leurs objets se lisent avec list_points / read_point et le paramètre device.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const data = await apexSelect("/services/bacnet/remote/devices", "*($select=object-name,local-name,description,connection-status,address,vendor-name,model-name,persisted)");
      const lines = entries(data).map(([id, raw]) => deviceLine(id, unwrap(raw)));
      return lines.length ? [`${lines.length} équipement(s) : instance | nom | connexion | adresse`, ...lines].join("\n") : "Aucun équipement BACnet distant.";
    },
  },
  {
    name: "list_trend_logs",
    description: "Historiques (trend logs) enregistrés par l'APEX : nom | point enregistré | taille | actif. À lire ensuite avec get_history (par nom ou par point).",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Texte recherché dans le nom du trend log." },
        point: { type: "string", description: "Seulement les trend logs de ce point, ex. analog-values/464." },
        group: { type: "string", description: "Groupe d'historiques (bacnet par défaut)." },
      },
    },
    async run({ search, point, group }) {
      const needle = String(search ?? "").toLowerCase();
      const logs = (await trendLogs(group)).filter((l) => (!needle || l.key.toLowerCase().includes(needle)) && (!point || l.point === String(point)));
      const lines = logs.map((l) => {
        const size = /size-(\d+)/.exec(String(l.info["full-policy"] ?? ""))?.[1];
        return `${l.key} | ${l.device ? `device ${l.device} ` : ""}${l.point ?? l.source} | ${size ? `${size} enr. max` : fmt(l.info["full-policy"])} | ${l.info.enabled === false ? "inactif" : "actif"}`;
      });
      return lines.length ? [`${lines.length} trend log(s) : nom | point | capacité | état`, ...lines].join("\n") : "Aucun trend log ne correspond.";
    },
  },
  {
    name: "get_history",
    description:
      "Série temporelle d'un trend log de l'APEX sur une période, avec statistiques (min, max, moyenne) et agrégation horaire ou journalière pour les longues périodes. Utile pour analyser une loi d'eau, un confort, un fonctionnement.",
    inputSchema: {
      type: "object",
      properties: {
        history: { type: "string", description: "Nom du trend log (voir list_trend_logs)." },
        point: { type: "string", description: "Ou le point enregistré, ex. analog-values/464 : son trend log est trouvé automatiquement." },
        device: DEVICE,
        from: { type: "string", description: "Début : ISO 8601 ou relatif (24h, 7d, 2w). 7d par défaut." },
        to: { type: "string", description: "Fin : ISO 8601. Maintenant par défaut." },
        interval: { type: "string", enum: ["auto", "raw", "hour", "day"], description: "auto par défaut." },
        group: { type: "string", description: "bacnet par défaut." },
      },
    },
    async run({ history, point, device, from, to, interval, group }) {
      const name = await resolveHistory({ history, point, device, group });
      const end = parseDate(to, Date.now());
      const { records, range, raw } = await fetchRecords(name, parseDate(from, end - 7 * 86400e3), end, group);
      if (raw) return "Format de réponse non reconnu, réponse brute :\n" + json(raw);
      return `${name}, ${range}\n${summarize(records, interval)}`;
    },
  },
  {
    name: "compare_histories",
    description:
      "Aligne plusieurs historiques (2 à 6) sur une même grille horaire ou journalière, une colonne par série (moyenne de la période). Idéal pour une loi d'eau (départ vs T extérieure), une consigne vs une mesure, ou plusieurs zones.",
    inputSchema: {
      type: "object",
      properties: {
        series: {
          type: "array",
          items: { type: "string" },
          description: "Trend logs (nom) ou points (type/instance, leur trend log est trouvé automatiquement).",
        },
        from: { type: "string", description: "Début : ISO 8601 ou relatif (24h, 7d, 2w). 7d par défaut." },
        to: { type: "string", description: "Fin : ISO 8601. Maintenant par défaut." },
        interval: { type: "string", enum: ["hour", "day"], description: "hour par défaut." },
        group: { type: "string" },
      },
      required: ["series"],
    },
    async run({ series, from, to, interval, group }) {
      if (!Array.isArray(series) || series.length < 2 || series.length > 6) throw new Error("series : 2 à 6 trend logs ou points.");
      const end = parseDate(to, Date.now());
      const start = parseDate(from, end - 7 * 86400e3);
      const names = await Promise.all(series.map((s) => (/^[a-z][a-z-]*s\/\d+$/.test(String(s)) ? resolveHistory({ point: s, group }) : String(s))));
      const data = await Promise.all(names.map((n) => fetchRecords(n, start, end, group)));
      const size = interval === "day" ? 86400e3 : 3600e3;
      const grid = new Map();
      data.forEach(({ records }, i) => {
        for (const r of records) {
          const k = Math.floor(r.t / size) * size;
          const row = grid.get(k) ?? names.map(() => ({ n: 0, sum: 0 }));
          row[i].n++;
          row[i].sum += r.v;
          grid.set(k, row);
        }
      });
      const keys = [...grid.keys()].sort((a, b) => a - b);
      const lines = [
        `${keys.length} ${interval === "day" ? "jours" : "heures"} (UTC), moyennes ; vide = pas d'enregistrement.`,
        ...names.map((n, i) => `S${i + 1} = ${n} (${data[i].records.length} enr.)`),
        "",
        ["début", ...names.map((_, i) => `S${i + 1}`)].join(";"),
        ...keys.map((k) => [iso(k), ...grid.get(k).map((c) => (c.n ? round(c.sum / c.n) : ""))].join(";")),
      ];
      return lines.join("\n");
    },
  },
  {
    name: "get_schedules",
    description: "Programmes horaires BACnet de l'APEX : valeur actuelle, semaine type (heure → valeur, null = fin de plage) et exceptions (jours fériés, vacances).",
    inputSchema: { type: "object", properties: { instance: { type: "integer", description: "Un seul programme (sinon tous)." } } },
    async run({ instance }) {
      if (instance !== undefined && !INSTANCE.test(String(instance))) throw new Error("instance : entier attendu.");
      const path = "/services/bacnet/local/objects/schedules";
      const data = instance !== undefined ? { [instance]: await apex("GET", `${path}/${instance}`) } : await apex("GET", path);
      const out = [];
      for (const [id, raw] of entries(data)) {
        const o = unwrap(raw);
        const states = scheduleStates(o);
        const label = (v) => (v !== null && states.has(v) && states.get(v).toLowerCase() !== String(v).toLowerCase() ? `${v} (${states.get(v)})` : fmt(v));
        const typeInfo = o.type ? `, type ${o.type}${states.size ? ` : ${[...states].map(([v, t]) => `${v}=${t}`).join(", ")}` : ""}` : "";
        out.push(`## schedules/${id} : ${pick(o, "object-name", "name") ?? ""} (valeur actuelle : ${label(o["present-value"])}${typeInfo})`);
        const week = o["weekly-schedule"];
        if (week && typeof week === "object") {
          const days = Object.entries(week).sort(([a], [b]) => DAYS.indexOf(a) - DAYS.indexOf(b));
          for (const [day, d] of days) {
            const tr = entries(d?.transitions ?? d).map(([, x]) => `${String(x.time ?? "?").slice(0, 5)}→${label(x.value)}`);
            out.push(`- ${day} : ${tr.length ? tr.join(", ") : "aucune transition"}`);
          }
        }
        const special = entries(o["special-events"]);
        const dateText = (d) => (d && typeof d === "object" ? (d.$value ?? JSON.stringify(d)) : d);
        for (const [, ev] of special) {
          const p = ev.period ?? {};
          const when = p.date ? dateText(p.date) : p["date-range"] ? `${dateText(p["date-range"]["start-date"])} → ${dateText(p["date-range"]["end-date"])}` : fmt(p);
          const tr = entries(ev.transitions).map(([, x]) => `${String(x.time ?? "?").slice(0, 5)}→${label(x.value)}`);
          out.push(`- exception « ${ev.name ?? ev.key ?? ""} » (${typeof when === "object" ? JSON.stringify(when) : when}, priorité ${fmt(ev["event-priority"])}) : ${tr.join(", ") || "aucune transition"}`);
        }
        if (!week && !special.length) out.push(json(o));
      }
      return out.length ? out.join("\n") : "Aucun programme horaire.";
    },
  },
  {
    name: "get_alarms",
    description:
      "Historique des alarmes de l'APEX, les plus récentes d'abord : #numéro | horodatage | transition | acquittement | source | message. Le numéro sert à acquitter (ack_alarms).",
    inputSchema: {
      type: "object",
      properties: {
        unacked_only: { type: "boolean", description: "Seulement les alarmes non acquittées." },
        point: { type: "string", description: "Seulement ce point, ex. binary-inputs/101." },
        limit: { type: "integer", description: "100 par défaut." },
      },
    },
    async run({ unacked_only, point, limit }) {
      try {
        const table = await apex("POST", "/services/alarms/get-alarm-table", {});
        if (!Array.isArray(table?.rows)) return json(table);
        const rows = table.rows
          .filter((r) => !unacked_only || !/^acked$/i.test(String(r["ack-state"] ?? "")))
          .filter((r) => !point || String(r.source ?? "").endsWith(`/objects/${point}`))
          .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
        const max = Number(limit) > 0 ? Number(limit) : 100;
        const lines = rows.slice(0, max).map((r) => {
          const src = String(r.source ?? "").replace("/services/bacnet/local/objects/", "");
          return `#${r.id} | ${r.timestamp} | ${r["from-state"]}→${r["to-state"]} | ${r["ack-state"]}${r["ack-user"] ? ` (${r["ack-user"]})` : ""} | ${src} | ${r.message ?? ""}`;
        });
        return lines.length ? [`${rows.length} alarme(s)${rows.length > max ? `, ${max} plus récentes affichées` : ""} :`, ...lines].join("\n") : "Aucune alarme.";
      } catch (e) {
        return json(await apex("GET", "/services/alarms")) + `\n(table des alarmes indisponible : ${e.message})`;
      }
    },
  },
  {
    name: "api_get",
    description:
      "Lecture brute (GET) de n'importe quelle ressource de l'API REST v2 de l'APEX, pour ce que les autres outils ne couvrent pas. Chemin relatif à /api/rest/v2, commençant par /services, avec $select possible. Ex. /services/bacnet/local/objects/loops, /services/site?$select=buildings, /services/modbus, /services/mqtt.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    async run({ path }) {
      const p = String(path || "");
      if (!p.startsWith("/services") || p.includes("..")) throw new Error("Le chemin doit commencer par /services (relatif à /api/rest/v2).");
      return json(await apex("GET", p));
    },
  },
  {
    name: "site_notes",
    description:
      "Description du site tenue à jour avec l'utilisateur : quel point correspond à quel circuit, consignes attendues, émetteurs, particularités. À lire en début d'analyse.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      return readNotes() || "Aucune note de site pour l'instant. Proposez d'en créer avec save_site_notes (circuits, points clés, consignes, type d'émetteurs).";
    },
  },
  {
    name: "save_site_notes",
    description: "Enregistre la description du site (Markdown) sur l'APEX. Uniquement avec l'accord de l'utilisateur. N'écrit rien dans l'automate.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" }, mode: { type: "string", enum: ["replace", "append"], description: "replace par défaut." } },
      required: ["content"],
    },
    async run({ content, mode }) {
      mkdirSync(DATA, { recursive: true });
      const text = mode === "append" ? `${readNotes().replace(/\n*$/, "\n\n")}${content}` : String(content);
      writeFileSync(NOTES, text.endsWith("\n") ? text : text + "\n");
      return `Notes enregistrées (${text.length} caractères).`;
    },
  },
];

// --- Supervised writes (ALLOW_WRITE) -------------------------------------------------------------

const WRITABLE = /^(analog|binary|multi-state)-(values|outputs)$/;
const CREATABLE = { AnalogValue: "analog-values", BinaryValue: "binary-values", MultiStateValue: "multi-state-values", Schedule: "schedules" };
const PROPERTIES = ["object-name", "description", "out-of-service", "relinquish-default", "schedule-default", "cov-increment", "high-limit", "low-limit", "deadband", "time-delay", "notification-class", "state-text", "active-text", "inactive-text", "units"];
const CREATED = `${DATA}/created.json`;

const dryRun = (what) => `SIMULATION, rien n'a été écrit. ${what}. Montrez-le à l'utilisateur, et ne rappelez avec confirm=true qu'après son accord explicite.`;

function readCreated() {
  try {
    return JSON.parse(readFileSync(CREATED, "utf8"));
  } catch {
    return [];
  }
}
function saveCreated(list) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(CREATED, JSON.stringify(list, null, 2));
}

/** Object about to be written, checked against the optional name whitelist. */
async function writableObject(path) {
  const o = unwrap(await apex("GET", path));
  const name = pick(o, "object-name", "name") ?? "";
  if (WRITE_ALLOW && !WRITE_ALLOW.test(name)) throw new Error(`« ${name} » n'est pas dans la liste blanche d'écriture (${WRITE_ALLOW.source}).`);
  return { o, name };
}

/** Value converted to what the object type takes, within its limits. */
function coerce(type, o, value) {
  if (value === null || value === undefined) return null;
  if (type.startsWith("binary")) {
    if (value === true || /^(active|on|1|true|marche)$/i.test(String(value))) return "active";
    if (value === false || /^(inactive|off|0|false|arr[eê]t)$/i.test(String(value))) return "inactive";
    throw new Error("Binaire : active ou inactive attendu.");
  }
  if (type.startsWith("multi-state")) {
    const states = Array.isArray(o["state-text"]) ? o["state-text"] : [];
    let n = Number(value);
    if (!Number.isFinite(n)) n = states.findIndex((s) => String(s).toLowerCase() === String(value).toLowerCase()) + 1;
    const count = Number(o["number-of-states"]) || states.length || Infinity;
    if (!Number.isInteger(n) || n < 1 || n > count) throw new Error(`Multi-état : numéro d'état de 1 à ${count === Infinity ? "n" : count}${states.length ? ` (${states.map((s, i) => `${i + 1}=${s}`).join(", ")})` : ""}.`);
    return n;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error("Valeur numérique attendue.");
  const min = Number(o["min-pres-value"]);
  const max = Number(o["max-pres-value"]);
  if (Number.isFinite(min) && n < min) throw new Error(`${n} est sous la limite basse de l'objet (min-pres-value ${min}).`);
  if (Number.isFinite(max) && n > max) throw new Error(`${n} dépasse la limite haute de l'objet (max-pres-value ${max}).`);
  return n;
}

const WRITE_TOOLS = [
  {
    name: "write_point",
    description:
      `Commande un point (AV, BV, MSV, AO, BO, MSO ; local ou équipement distant) à une priorité BACnet, ${PRIORITY} par défaut (${MIN_PRIORITY} à 16 autorisées). ` +
      "Sans confirm=true : simulation seulement (valeur actuelle, priorité qui commande, ce qui serait écrit). value=null relâche la priorité. Limites min/max de l'objet vérifiées. Chaque écriture est journalisée.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "analog-values, binary-values, multi-state-values, analog-outputs, binary-outputs, multi-state-outputs." },
        instance: { type: "integer" },
        device: DEVICE,
        value: { type: ["number", "string", "boolean", "null"], description: "Nombre, active/inactive, numéro ou texte d'état, null pour relâcher." },
        priority: { type: "integer", description: `${MIN_PRIORITY} à 16, ${PRIORITY} par défaut.` },
        confirm: { type: "boolean" },
      },
      required: ["type", "instance", "value"],
    },
    async run({ type, instance, device, value, priority, confirm }) {
      checkPoint(type, instance);
      if (!WRITABLE.test(type)) throw new Error("Seuls les AV, BV, MSV, AO, BO et MSO se commandent.");
      const prio = priority === undefined || priority === null ? PRIORITY : Number(priority);
      if (!Number.isInteger(prio) || prio < MIN_PRIORITY || prio > 16) throw new Error(`Priorité ${priority} refusée : ${MIN_PRIORITY} à 16 seulement (1 à 7 réservées à la sécurité et aux opérateurs).`);
      const path = `${objectsPath(device)}/${type}/${instance}`;
      const { o, name } = await writableObject(path);
      const v = coerce(type, o, value);
      const current = o["current-command-priority"];
      const what = `${device ? `device ${device} ` : ""}${type}/${instance} « ${name} » : ${v === null ? `relâcher la priorité ${prio}` : `écrire ${v} à la priorité ${prio}`} (valeur actuelle ${display(type, o)}${typeof current === "number" ? `, commandée en priorité ${current}` : ""})`;
      const masked = v !== null && typeof current === "number" && current < prio ? ` Attention : la priorité ${current} est plus forte, la valeur présente ne changera pas.` : "";
      if (confirm !== true) return dryRun(what) + masked;
      await apex("POST", `${path}/set-value-at`, { value: v, priority: prio });
      const after = unwrap(await apex("GET", path).catch(() => ({})));
      log({ write: `${device ? `device/${device}/` : ""}${type}/${instance}`, name, value: v, priority: prio, before: o["present-value"], after: after["present-value"] });
      return `Écrit. ${what}. Valeur présente maintenant : ${display(type, after)}${typeof after["current-command-priority"] === "number" ? ` (priorité ${after["current-command-priority"]})` : ""}.${masked}`;
    },
  },
  {
    name: "write_property",
    description:
      `Modifie une propriété de configuration d'un objet : ${PROPERTIES.join(", ")}. Pour la valeur présente, utilisez write_point. Simulation sans confirm=true.`,
    inputSchema: {
      type: "object",
      properties: {
        type: TYPE,
        instance: { type: "integer" },
        device: DEVICE,
        property: { type: "string", enum: PROPERTIES },
        value: { description: "Nouvelle valeur (texte, nombre, booléen, ou liste pour state-text)." },
        confirm: { type: "boolean" },
      },
      required: ["type", "instance", "property", "value"],
    },
    async run({ type, instance, device, property, value, confirm }) {
      checkPoint(type, instance);
      if (!PROPERTIES.includes(property)) throw new Error(`Propriété non modifiable ici. Autorisées : ${PROPERTIES.join(", ")}.`);
      const path = `${objectsPath(device)}/${type}/${instance}`;
      const { o, name } = await writableObject(path);
      const what = `${type}/${instance} « ${name} » : ${property} ${fmt(o[property])} → ${fmt(value)}`;
      if (confirm !== true) return dryRun(what);
      await apex("POST", path, { [property]: value });
      const after = unwrap(await apex("GET", path))[property];
      log({ property: `${type}/${instance}`, name, [property]: value, before: o[property], after });
      return `Modifié. ${what}. Valeur relue : ${fmt(after)}.`;
    },
  },
  {
    name: "create_object",
    description:
      "Crée un objet BACnet local sur l'APEX (AnalogValue, BinaryValue, MultiStateValue, Schedule), par exemple un point de test, une consigne ou un programme horaire. Instance libre choisie si absente. Simulation sans confirm=true. Les objets créés ici sont mémorisés : seuls eux peuvent être supprimés avec delete_object.",
    inputSchema: {
      type: "object",
      properties: {
        object_type: { type: "string", enum: Object.keys(CREATABLE) },
        name: { type: "string" },
        instance: { type: "integer", description: "Facultatif : première instance libre à partir de 10000 sinon." },
        schedule_type: { type: "string", enum: ["Enumerated", "Boolean"], description: "Pour un Schedule : Enumerated (Occupied, Unoccupied… par défaut sur l'APEX) ou Boolean." },
        confirm: { type: "boolean" },
      },
      required: ["object_type", "name"],
    },
    async run({ object_type, name, instance, schedule_type, confirm }) {
      if (schedule_type && (object_type !== "Schedule" || !["Enumerated", "Boolean"].includes(schedule_type))) throw new Error("schedule_type : Enumerated ou Boolean, pour un Schedule seulement.");
      const col = CREATABLE[object_type];
      if (!col) throw new Error(`object_type parmi ${Object.keys(CREATABLE).join(", ")}.`);
      if (!String(name ?? "").trim()) throw new Error("name obligatoire.");
      const existing = await apex("GET", `/services/bacnet/local/objects/${col}`).catch(() => ({}));
      const used = new Set(entries(existing).map(([k]) => Number(k)));
      let inst = instance === undefined || instance === null ? 10000 : Number(instance);
      if (!Number.isInteger(inst) || inst < 0) throw new Error("instance : entier positif attendu.");
      if (instance !== undefined && instance !== null && used.has(inst)) throw new Error(`${col}/${inst} existe déjà.`);
      while (used.has(inst)) inst++;
      const what = `créer ${object_type} ${col}/${inst} « ${name} »${schedule_type ? ` de type ${schedule_type}` : ""}`;
      if (confirm !== true) return dryRun(what);
      await apex("POST", "/services/bacnet/local/objects/add", { "object-type": object_type, "instance-number": inst, name: String(name) });
      saveCreated([...readCreated(), { type: col, instance: inst, name: String(name), at: new Date().toISOString() }]);
      if (schedule_type) await apex("POST", `/services/bacnet/local/objects/${col}/${inst}`, { type: schedule_type });
      log({ create: `${col}/${inst}`, name });
      return `Créé : ${col}/${inst} « ${name} ».`;
    },
  },
  {
    name: "delete_object",
    description:
      "Supprime un objet créé par ce serveur MCP : objet local (create_object) ou point ajouté à un équipement distant existant (add_bacnet_points, import_ede ; paramètre device). Les objets de la programmation sont refusés. Simulation sans confirm=true.",
    inputSchema: { type: "object", properties: { type: TYPE, instance: { type: "integer" }, device: DEVICE, confirm: { type: "boolean" } }, required: ["type", "instance"] },
    async run({ type, instance, device, confirm }) {
      checkPoint(type, instance);
      const list = readCreated();
      const remote = device !== undefined && device !== null && device !== "";
      const same = (c) => c.type === type && String(c.instance) === String(instance) && (remote ? c.kind === "remote-object" && c.device === String(device) : !c.kind);
      const mine = list.find(same);
      if (!mine) {
        const known = list.filter((c) => !c.kind || c.kind === "remote-object").map((c) => `${c.device ? `device ${c.device} ` : ""}${c.type}/${c.instance} « ${c.name} »`).join(", ");
        throw new Error(`${remote ? `device ${device} ` : ""}${type}/${instance} n'a pas été créé par ce serveur MCP : suppression refusée.${known ? ` Objets supprimables : ${known}.` : ""}`);
      }
      const label = `${remote ? `device ${device} ` : ""}${type}/${instance} « ${mine.name} »`;
      if (confirm !== true) return dryRun(`supprimer ${label}`);
      await apex("DELETE", `${objectsPath(remote ? device : undefined)}/${type}/${instance}`);
      saveCreated(list.filter((c) => c !== mine));
      log({ delete: label });
      return `Supprimé : ${label}.`;
    },
  },
  {
    name: "write_schedule",
    description:
      "Modifie un programme horaire BACnet local : semaine type (jours donnés seulement, les autres restent inchangés) et/ou exceptions (remplace toute la liste : reprenez celles à garder, voir get_schedules). Une plage = transitions heure → valeur, value null termine la plage. La valeur suit le type du programme (voir get_schedules) : numéro ou texte d'état pour un programme énuméré (ex. Occupied), true/false, ou nombre. Simulation sans confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        instance: { type: "integer" },
        week: {
          type: "object",
          description: 'Par jour (monday… sunday) : liste de transitions, ex. {"monday": [{"time": "07:00", "value": true}, {"time": "18:00", "value": null}]}. Liste vide = aucune plage ce jour-là.',
          additionalProperties: { type: "array", items: { type: "object", properties: { time: { type: "string" }, value: {} }, required: ["time"] } },
        },
        exceptions: {
          type: "array",
          description:
            'Exceptions, ex. [{"name": "Noël", "date": "****-12-25", "transitions": [], "priority": 16}] ou {"name": "Vacances", "from": "2026-12-21", "to": "2027-01-02"}. date au format AAAA-MM-JJ, * pour chaque année.',
          items: { type: "object" },
        },
        confirm: { type: "boolean" },
      },
      required: ["instance"],
    },
    async run({ instance, week, exceptions, confirm }) {
      checkPoint("schedules", instance);
      if (!week && !exceptions) throw new Error("week et/ou exceptions attendus.");
      const path = `/services/bacnet/local/objects/schedules/${instance}`;
      const { o, name } = await writableObject(path);
      const time = (t) => {
        const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t ?? "").trim());
        if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Heure invalide : ${t} (HH:MM).`);
        return `${m[1].padStart(2, "0")}:${m[2]}:${m[3] ?? "00"}.00`;
      };
      const transitions = (list) =>
        Object.fromEntries(
          (list ?? [])
            .map((x) => ({ time: time(x.time), value: scheduleValue(o, x.value) }))
            .sort((a, b) => a.time.localeCompare(b.time))
            .map((x, i) => [String(i + 1), { ...x, key: String(i + 1) }]),
        );
      const summary = [];
      let weekly;
      if (week) {
        // The APEX rejects a weekly schedule without its 7 days (value-out-of-range): days not given are sent back as they are.
        const current = o["weekly-schedule"] && typeof o["weekly-schedule"] === "object" ? o["weekly-schedule"] : {};
        weekly = Object.fromEntries(
          DAYS.map((d) => [d, { transitions: Object.fromEntries(entries(current[d]?.transitions).map(([k, x]) => [k, { time: x.time, value: x.value ?? null, key: String(x.key ?? k) }])) }]),
        );
        for (const [day, list] of Object.entries(week)) {
          const d = day.toLowerCase();
          if (!DAYS.includes(d)) throw new Error(`Jour inconnu : ${day} (${DAYS.join(", ")}).`);
          if (!Array.isArray(list)) throw new Error(`${day} : liste de transitions attendue.`);
          weekly[d] = { transitions: transitions(list) };
          summary.push(`${d} : ${list.length ? Object.values(weekly[d].transitions).map((x) => `${x.time.slice(0, 5)}→${fmt(x.value)}`).join(", ") : "aucune plage"}`);
        }
      }
      let special;
      if (exceptions) {
        if (!Array.isArray(exceptions)) throw new Error("exceptions : liste attendue.");
        const date = (s) => {
          const m = /^(\*{4}|\d{4})-(\*{1,2}|\d{1,2})-(\*{1,2}|\d{1,2})$/.exec(String(s ?? "").trim());
          if (!m) throw new Error(`Date invalide : ${s} (AAAA-MM-JJ, * pour « chaque »).`);
          const n = (x) => (x.startsWith("*") ? null : Number(x));
          return { $value: `${m[1]}-${m[2]}-${m[3]}-***`, year: n(m[1]), month: n(m[2]), "day-of-month": n(m[3]), "day-of-week": null };
        };
        special = Object.fromEntries(
          exceptions.map((ex, i) => {
            const period = ex.from || ex.to ? { type: "DateRange", "date-range": { "start-date": date(ex.from), "end-date": date(ex.to ?? ex.from) } } : { type: "Date", date: date(ex.date) };
            const key = String(i + 1);
            summary.push(`exception « ${ex.name ?? key} » ${ex.from ? `${ex.from} → ${ex.to ?? ex.from}` : ex.date} : ${(ex.transitions ?? []).map((x) => `${x.time}→${fmt(x.value)}`).join(", ") || "aucune plage"}`);
            return [key, { key, name: String(ex.name ?? `Exception ${key}`), "event-priority": Number(ex.priority ?? 16), period, transitions: transitions(ex.transitions) }];
          }),
        );
      }
      const what = `programme schedules/${instance} « ${name} » :\n- ${summary.join("\n- ")}`;
      if (confirm !== true) return dryRun(what);
      if (weekly) await apex("POST", `${path}/weekly-schedule`, weekly);
      if (special) await apex("POST", `${path}/special-events`, special);
      log({ schedule: `schedules/${instance}`, name, week: weekly ? Object.keys(weekly) : undefined, exceptions: special ? Object.keys(special).length : undefined });
      return `Programme modifié. ${what}`;
    },
  },
];

// --- Integration: remote BACnet devices, EDE import, Modbus, GFX network values -------------------

/** BACnet object types: collection in the API, type name for "add", EDE / BACnet numeric code. */
const BACNET_TYPES = [
  { col: "analog-inputs", name: "AnalogInput", code: 0 },
  { col: "analog-outputs", name: "AnalogOutput", code: 1 },
  { col: "analog-values", name: "AnalogValue", code: 2 },
  { col: "binary-inputs", name: "BinaryInput", code: 3 },
  { col: "binary-outputs", name: "BinaryOutput", code: 4 },
  { col: "binary-values", name: "BinaryValue", code: 5 },
  { col: "multi-state-inputs", name: "MultiStateInput", code: 13 },
  { col: "multi-state-outputs", name: "MultiStateOutput", code: 14 },
  { col: "multi-state-values", name: "MultiStateValue", code: 19 },
];

/** "AI", "analog-input", "AnalogInput", "analog-inputs" or 0 → the type entry. */
function bacnetType(t) {
  const s = String(t ?? "").trim();
  if (/^\d+$/.test(s)) return BACNET_TYPES.find((x) => x.code === Number(s));
  const k = s.toLowerCase().replace(/[\s_-]/g, "");
  const short = { ai: 0, ao: 1, av: 2, bi: 3, bo: 4, bv: 5, msi: 13, mso: 14, msv: 19 }[k];
  if (short !== undefined) return BACNET_TYPES.find((x) => x.code === short);
  return BACNET_TYPES.find((x) => [x.name.toLowerCase(), x.col.replace(/-/g, ""), x.col.replace(/-/g, "").replace(/s$/, "")].includes(k));
}

/** Properties the APEX keeps in sync for a persisted remote object (format observed on a real APEX). */
function managedProperties(col) {
  const sync = { "sync-on-present-value-change": true };
  const commandable = !col.endsWith("inputs");
  const props = { "36": {}, "81": sync, "103": {}, "111": {}, "85": { operation: commandable ? "ReadWrite" : "Read" } };
  if (commandable) Object.assign(props, { "87": sync, "104": sync });
  if (col.startsWith("analog")) props["117"] = sync;
  if (col.startsWith("binary")) Object.assign(props, { "4": {}, "46": {} });
  if (col.startsWith("multi-state")) Object.assign(props, { "74": {}, "110": sync });
  return props;
}

const remoteDevicePath = (d) => `/services/bacnet/remote/devices/${d}`;

async function remotePolicies() {
  return Object.keys((await apex("GET", "/services/bacnet/remote/policies").catch(() => ({}))) ?? {});
}

/** Creates a remote device: name and address only stick with a second call (observed on a real APEX). */
async function createRemoteDevice({ instance, name, description, ip, port, network_number }) {
  await apex("POST", remoteDevicePath(instance), {});
  const update = { "local-name": String(name ?? ""), description: String(description ?? "") };
  if (ip) update.address = { "network-number": Number(network_number ?? 0), port: Number(port ?? 47808), ip: String(ip), type: "Ip" };
  await apex("POST", remoteDevicePath(instance), update);
}

/** Adds objects to a remote device and persists them with a polling policy. Returns lines of results. */
async function addRemoteObjects(device, objects, policy) {
  const existing = await apexSelect(`${remoteDevicePath(device)}/objects`, "*($select=*($select=local-name,persisted))").catch(() => ({}));
  const results = await pool(objects, 4, async (o) => {
    const t = bacnetType(o.type);
    const current = existing?.[t.col]?.[String(o.instance)];
    if (current && unwrap(current).persisted === true) return `${t.col}/${o.instance} « ${o.name} » : existe déjà, inchangé`;
    if (!current) await apex("POST", `${remoteDevicePath(device)}/objects/add`, { "object-type": t.name, "instance-number": Number(o.instance), name: String(o.name) });
    await apex("POST", `${remoteDevicePath(device)}/objects/${t.col}/${o.instance}`, {
      policy,
      "managed-properties": managedProperties(t.col),
      ...(o.description ? { "local-description": String(o.description) } : {}),
    });
    return { created: { kind: "remote-object", device: String(device), type: t.col, instance: Number(o.instance), name: String(o.name) } };
  });
  const lines = [];
  const created = [];
  results.forEach((r, i) => {
    const o = objects[i];
    if (!r.ok) lines.push(`${bacnetType(o.type).col}/${o.instance} « ${o.name} » : ERREUR ${r.e.message}`);
    else if (typeof r.v === "string") lines.push(r.v);
    else created.push(r.v.created);
  });
  return { lines, created };
}

/** Checks and normalizes a list of {type, instance, name} for a remote device. */
function normalizeObjects(list) {
  if (!Array.isArray(list) || !list.length) throw new Error("objects : liste non vide attendue.");
  return list.map((o, i) => {
    const t = bacnetType(o?.type);
    if (!t) throw new Error(`Objet ${i + 1} : type « ${o?.type} » non pris en charge (${BACNET_TYPES.map((x) => x.name).join(", ")}).`);
    if (!INSTANCE.test(String(o.instance))) throw new Error(`Objet ${i + 1} : instance entière attendue.`);
    return { type: t.col, instance: Number(o.instance), name: String(o.name ?? `${t.name} ${o.instance}`).slice(0, 128), description: o.description };
  });
}

/**
 * EDE (Engineering Data Exchange, BIG-EU) file: semicolon-separated, a "keyname;device obj.-instance;
 * object-name;object-type;object-instance;description;…" header (often commented with #), one line per object.
 */
function parseEde(text) {
  const lines = String(text ?? "").replace(/^﻿/, "").split(/\r?\n/);
  const headerAt = lines.findIndex((l) => /keyname/i.test(l) && /object.?type/i.test(l) && /object.?instance/i.test(l));
  if (headerAt < 0) throw new Error("Fichier EDE non reconnu : ligne d'en-tête « keyname;device obj.-instance;object-name;object-type;object-instance;… » introuvable.");
  const sep = (lines[headerAt].match(/;/g)?.length ?? 0) >= (lines[headerAt].match(/,/g)?.length ?? 0) ? ";" : ",";
  const header = lines[headerAt].replace(/^#\s*/, "").split(sep).map((h) => h.trim().toLowerCase());
  const col = (re) => header.findIndex((h) => re.test(h));
  const idx = { device: col(/^device/), name: col(/^object.?name/), type: col(/^object.?type/), instance: col(/^object.?instance/), description: col(/^description/), unit: col(/unit/), settable: col(/settable/) };
  if ([idx.device, idx.name, idx.type, idx.instance].some((i) => i < 0)) throw new Error("Fichier EDE : colonnes device obj.-instance, object-name, object-type ou object-instance manquantes.");
  const devices = new Map();
  const skipped = new Map();
  for (const line of lines.slice(headerAt + 1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const cells = line.split(sep).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
    const device = cells[idx.device];
    if (!INSTANCE.test(device ?? "")) continue;
    const d = devices.get(device) ?? { instance: Number(device), name: "", objects: [] };
    devices.set(device, d);
    const typeCell = cells[idx.type];
    if (typeCell === "8" || /^device$/i.test(typeCell ?? "")) {
      d.name = cells[idx.name] ?? "";
      continue;
    }
    const t = bacnetType(typeCell);
    if (!t || !INSTANCE.test(cells[idx.instance] ?? "")) {
      skipped.set(typeCell, (skipped.get(typeCell) ?? 0) + 1);
      continue;
    }
    d.objects.push({ type: t.col, instance: Number(cells[idx.instance]), name: cells[idx.name] || `${t.name} ${cells[idx.instance]}`, description: idx.description >= 0 ? cells[idx.description] : "" });
  }
  return { devices: [...devices.values()], skipped };
}

// Modbus ------------------------------------------------------------------------------------------

const MODBUS_REGISTERS = { holding: "HoldingRegister", input: "InputRegister", coil: "Coils", coils: "Coils", discrete: "DiscreteInput" };
const MODBUS_TYPES = ["Bit", "Int16", "Uint16", "Int32", "Uint32", "Int64", "Float", "Double"];
const MODBUS_ACCESS = ["Read", "Write", "ReadWrite"];
const modbusPath = (d) => `/services/modbus/devices/${encodeURIComponent(d)}`;
const NO_SWAP = {
  "int64-byte-ordering": { "byte-swap": false, "word-swap": false, "double-word-swap": false },
  "double-byte-ordering": { "byte-swap": false, "word-swap": false, "double-word-swap": false },
  "int16-byte-ordering": { "byte-swap": false },
  "int32-byte-ordering": { "byte-swap": false, "word-swap": false },
  "float-byte-ordering": { "byte-swap": false, "word-swap": false },
};

/** A Modbus point as the APEX takes it, from a friendly description. */
function modbusPoint(p, i) {
  const name = String(p?.name ?? "").trim();
  if (!name) throw new Error(`Point ${i + 1} : name obligatoire.`);
  const reg = MODBUS_REGISTERS[String(p.register ?? "holding").toLowerCase().replace(/[\s_-]?registers?$/, "")] ?? (Object.values(MODBUS_REGISTERS).includes(p.register) ? p.register : undefined);
  if (!reg) throw new Error(`${name} : register parmi holding, input, coil, discrete.`);
  const bit = reg === "Coils" || reg === "DiscreteInput";
  const type = bit ? "Bit" : MODBUS_TYPES.find((t) => t.toLowerCase() === String(p.data_type ?? "Uint16").toLowerCase());
  if (!type) throw new Error(`${name} : data_type parmi ${MODBUS_TYPES.join(", ")}.`);
  const access = MODBUS_ACCESS.find((a) => a.toLowerCase() === String(p.access ?? "Read").toLowerCase());
  if (!access) throw new Error(`${name} : access parmi ${MODBUS_ACCESS.join(", ")}.`);
  if (!/^\d+$/.test(String(p.address ?? ""))) throw new Error(`${name} : address (registre, entier) obligatoire.`);
  return {
    key: name,
    address: String(p.address),
    "address-type": "Decimal",
    "register-type": reg,
    "data-type": type,
    "access-type": access,
    "value-scale": Number(p.scale ?? 1),
    "value-offset": Number(p.offset ?? 0),
    units: String(p.units ?? "NoUnits"),
    "polling-interval": Number(p.polling ?? 10),
    ...(p.description ? { description: String(p.description) } : {}),
  };
}

const MODBUS_POINT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    address: { type: ["integer", "string"], description: "Adresse décimale du registre telle que l'APEX l'attend (ex. 40001, 45083, ou 1 pour une bobine)." },
    register: { type: "string", enum: ["holding", "input", "coil", "discrete"], description: "holding par défaut." },
    data_type: { type: "string", enum: MODBUS_TYPES, description: "Uint16 par défaut, Bit pour coil/discrete." },
    scale: { type: "number", description: "Facteur d'échelle (ex. 0.1), 1 par défaut." },
    offset: { type: "number" },
    units: { type: "string", description: "Unité BACnet : DegreesCelsius, KilowattHours, Percent… NoUnits par défaut." },
    access: { type: "string", enum: MODBUS_ACCESS, description: "Read par défaut." },
    polling: { type: "number", description: "Période d'interrogation en secondes, 10 par défaut." },
  },
  required: ["name", "address"],
};

TOOLS.push(
  {
    name: "list_network_values",
    description:
      "Network values du programme GFX (EC-gfxProgram) : numéro | équipement BACnet distant | objet | nom | valeur. Ce sont les liaisons entre le programme et les points des équipements du réseau.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Texte dans le nom de l'objet lié." },
        device: DEVICE,
        limit: { type: "integer", description: "200 par défaut." },
      },
    },
    async run({ search, device, limit }) {
      const config = unwrap(await apexSelect("/services/gfx/configuration", "network*"));
      const nvs = Object.entries(config ?? {})
        .map(([k, v]) => {
          const n = /^network-value-(\d+)$/.exec(k)?.[1];
          const path = (Array.isArray(v) ? v : []).find((p) => /\/remote\/devices\/\d+\/objects\/[a-z-]+\/\d+$/.test(p));
          const m = /\/remote\/devices\/(\d+)\/objects\/([a-z-]+)\/(\d+)$/.exec(path ?? "");
          return n && m ? { number: Number(n), device: m[1], type: m[2], instance: m[3] } : null;
        })
        .filter(Boolean)
        .filter((x) => !device || x.device === String(device))
        .sort((a, b) => a.number - b.number);
      const devices = [...new Set(nvs.map((x) => x.device))];
      const names = new Map();
      await pool(devices, 3, async (d) => {
        const objs = await apexSelect(`${remoteDevicePath(d)}/objects`, "*($select=*($select=local-name,object-name,present-value,units,status-flags))");
        for (const [col, items] of Object.entries(objs ?? {})) for (const [inst, raw] of entries(items)) names.set(`${d}/${col}/${inst}`, unwrap(raw));
      });
      const words = String(search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const lines = nvs
        .map((x) => ({ x, o: names.get(`${x.device}/${x.type}/${x.instance}`) ?? {} }))
        .filter(({ o }) => words.every((w) => `${o["local-name"] ?? ""} ${o["object-name"] ?? ""}`.toLowerCase().includes(w)))
        .map(({ x, o }) => `NV ${x.number} | device ${x.device} | ${x.type}/${x.instance} | ${pick(o, "local-name", "object-name") ?? ""} | ${display(x.type, o)}`);
      const max = Number(limit) > 0 ? Number(limit) : 200;
      return lines.length ? [`${lines.length} network value(s)${lines.length > max ? `, ${max} affichées` : ""} :`, ...lines.slice(0, max)].join("\n") : "Aucune network value ne correspond.";
    },
  },
  {
    name: "list_modbus",
    description:
      "Modbus client de l'APEX. Sans device : réseaux RS-485 et équipements (adresse, état, nombre de points, points en défaut). Avec device : ses points (registre, type, échelle, unité, accès, valeur, état).",
    inputSchema: { type: "object", properties: { device: { type: "string", description: "Nom de l'équipement Modbus." }, search: { type: "string" } } },
    async run({ device, search }) {
      if (device) {
        const pts = await apex("GET", `${modbusPath(device)}/points`);
        const needle = String(search ?? "").toLowerCase();
        const lines = entries(pts)
          .filter(([k]) => !needle || k.toLowerCase().includes(needle))
          .map(([k, raw]) => {
            const p = unwrap(raw);
            const f = flags(p);
            return `${k} | ${p["register-type"]} ${p.address} ${p["data-type"]}${p["value-scale"] !== undefined && p["value-scale"] !== 1 ? ` ×${p["value-scale"]}` : ""} | ${fmt(p["present-value"])}${p.units && p.units !== "NoUnits" ? ` ${p.units}` : ""} | ${p["access-type"] ?? ""} | ${p["modbus-status"] ?? ""}${f.length ? ` [${f.join(", ")}]` : ""}`;
          });
        return lines.length ? [`${lines.length} point(s) : nom | registre adresse type échelle | valeur | accès | état`, ...lines].join("\n") : "Aucun point.";
      }
      const [networks, devices] = await Promise.all([apex("GET", "/services/modbus/networks").catch(() => ({})), apex("GET", "/services/modbus/devices")]);
      const out = ["Réseaux :"];
      for (const [k, raw] of entries(networks)) {
        const n = unwrap(raw);
        out.push(`- ${k} : ${n.port} ${n.speed} bauds ${n["data-bits"]}${String(n.parity ?? "N")[0]}${n["stop-bits"]} (${n.state ?? (n.enabled ? "activé" : "désactivé")})`);
      }
      const needle = String(search ?? "").toLowerCase();
      out.push("Équipements : nom | adresse | points (en défaut) | état");
      for (const [k, raw] of entries(devices)) {
        if (needle && !k.toLowerCase().includes(needle)) continue;
        const d = unwrap(raw);
        const a = d.address ?? {};
        const where = a.type === "TcpIp" ? `TCP ${a.ip}:${a.port} id ${a["modbus-address"]}` : `${a.network ?? a.type} id ${a["modbus-address"]}`;
        const pts = entries(d.points);
        const faults = pts.filter(([, p]) => unwrap(p)["modbus-status"] === "Fault").length;
        out.push(`- ${k} | ${where} | ${pts.length}${faults ? ` (${faults} en défaut)` : ""} | ${d.enabled === false ? "désactivé" : (d["device-status"] ?? "")}`);
      }
      return out.join("\n");
    },
  },
);

WRITE_TOOLS.push(
  {
    name: "create_bacnet_device",
    description:
      "Déclare un équipement BACnet distant dans l'APEX (instance, nom, adresse IP facultative : sans adresse, l'APEX le trouve par son instance sur le réseau). Ses points s'ajoutent ensuite avec add_bacnet_points ou import_ede. Simulation sans confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        instance: { type: "integer", description: "Instance BACnet de l'équipement (device instance)." },
        name: { type: "string" },
        description: { type: "string" },
        ip: { type: "string", description: "Adresse IP BACnet/IP, facultative." },
        port: { type: "integer", description: "47808 par défaut." },
        network_number: { type: "integer", description: "Numéro de réseau BACnet, 0 (local) par défaut." },
        confirm: { type: "boolean" },
      },
      required: ["instance", "name"],
    },
    async run(args) {
      if (!INSTANCE.test(String(args.instance)) || Number(args.instance) > 4194302) throw new Error("instance : entier de 0 à 4194302.");
      const exists = await apex("GET", `${remoteDevicePath(args.instance)}?$select=key,local-name`).then(unwrap, () => null);
      if (exists) throw new Error(`L'équipement ${args.instance} existe déjà (« ${exists["local-name"] ?? ""} »). Ajoutez-lui des points avec add_bacnet_points.`);
      const what = `déclarer l'équipement BACnet ${args.instance} « ${args.name} »${args.ip ? ` à ${args.ip}:${args.port ?? 47808}` : " (adresse résolue par l'APEX)"}`;
      if (args.confirm !== true) return dryRun(what);
      await createRemoteDevice(args);
      saveCreated([...readCreated(), { kind: "bacnet-device", instance: Number(args.instance), name: String(args.name), at: new Date().toISOString() }]);
      log({ createDevice: Number(args.instance), name: args.name, ip: args.ip });
      return `Équipement ${args.instance} « ${args.name} » déclaré.`;
    },
  },
  {
    name: "add_bacnet_points",
    description:
      "Ajoute des points (objets) à un équipement BACnet distant et les persiste avec une politique d'interrogation (lecture, et écriture pour les valeurs et sorties). Types : AI, AO, AV, BI, BO, BV, MSI, MSO, MSV. " +
      "Avec discovered=true, prend les points trouvés par discover_objects (filtrables par types et search) : l'équipement découvert est alors gardé. Les objets déjà persistés sont laissés tels quels. Simulation sans confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "integer" },
        objects: {
          type: "array",
          items: { type: "object", properties: { type: { type: "string", description: "AI, AV, BV… ou AnalogInput, analog-values…" }, instance: { type: "integer" }, name: { type: "string" }, description: { type: "string" } }, required: ["type", "instance"] },
        },
        discovered: { type: "boolean", description: "Prendre les points découverts non encore persistés (après discover_objects)." },
        types: { type: "array", items: { type: "string" }, description: "Avec discovered : seulement ces types, ex. [\"AI\", \"AV\"]." },
        search: { type: "string", description: "Avec discovered : seulement les points dont le nom contient ce texte." },
        policy: { type: "string", description: "Politique d'interrogation de l'APEX (normal par défaut ; voir l'erreur pour la liste)." },
        confirm: { type: "boolean" },
      },
      required: ["device"],
    },
    async run({ device, objects, discovered, types, search, policy, confirm }) {
      if (!INSTANCE.test(String(device))) throw new Error("device : instance entière attendue.");
      const dev = await apex("GET", `${remoteDevicePath(device)}?$select=key,local-name,object-name,persisted`).then(unwrap, () => null);
      if (!dev) throw new Error(`Équipement ${device} inconnu : découvrez-le (discover_devices) ou créez-le (create_bacnet_device, import_ede).`);
      let source = objects;
      if (discovered) {
        const only = Array.isArray(types) && types.length ? new Set(types.map((t) => bacnetType(t)?.col).filter(Boolean)) : null;
        const words = String(search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const objs = await apexSelect(`${remoteDevicePath(device)}/objects`, "*($select=*($select=local-name,object-name,persisted))");
        source = [];
        for (const [col, items] of Object.entries(objs ?? {})) {
          const t = BACNET_TYPES.find((x) => x.col === col);
          if (!t || (only && !only.has(col))) continue;
          for (const [inst, raw] of entries(items)) {
            const o = unwrap(raw);
            const name = pick(o, "local-name", "object-name") ?? `${t.name} ${inst}`;
            if (o.persisted === true || words.some((w) => !String(name).toLowerCase().includes(w))) continue;
            source.push({ type: col, instance: Number(inst), name });
          }
        }
        if (!source.length) throw new Error("Aucun point découvert à ajouter : lancez discover_objects, ou les points sont déjà persistés.");
      }
      const list = normalizeObjects(source);
      const policies = await remotePolicies();
      const pol = policy ?? (policies.includes("normal") ? "normal" : policies[0]);
      if (policies.length && !policies.includes(pol)) throw new Error(`Politique « ${pol} » inconnue : ${policies.join(", ")}.`);
      const devName = pick(dev, "local-name", "object-name") ?? "";
      const what = `ajouter ${list.length} point(s) à l'équipement ${device} « ${devName} »${dev.persisted === false ? " (découvert : il sera gardé)" : ""}, politique ${pol} :\n${list.slice(0, 40).map((o) => `  ${o.type}/${o.instance} « ${o.name} »`).join("\n")}${list.length > 40 ? `\n  … et ${list.length - 40} autres` : ""}`;
      if (confirm !== true) return dryRun(what);
      const { lines, created } = await addRemoteObjects(device, list, pol);
      // A discovered device becomes persisted with its first point: it was kept by this server, which may remove it again.
      const keptDevice = dev.persisted === false && created.length ? [{ kind: "bacnet-device", instance: Number(device), name: devName, discovered: true }] : [];
      saveCreated([...readCreated(), ...keptDevice.map((c) => ({ ...c, at: new Date().toISOString() })), ...(keptDevice.length ? [] : created.map((c) => ({ ...c, at: new Date().toISOString() })))]);
      log({ addPoints: Number(device), count: created.length });
      return [`${created.length} point(s) ajouté(s) et persisté(s) sur l'équipement ${device}.`, ...lines].join("\n");
    },
  },
  {
    name: "import_ede",
    description:
      "Importe un fichier EDE (Engineering Data Exchange, export BACnet d'un équipement tiers) : déclare chaque équipement absent puis crée et persiste tous ses points d'un coup. Passez le contenu texte du fichier (CSV ;). Simulation (aperçu par équipement) sans confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        ede: { type: "string", description: "Contenu du fichier EDE." },
        device: { type: "integer", description: "N'importer que cet équipement (si le fichier en décrit plusieurs)." },
        ip: { type: "string", description: "Adresse IP de l'équipement (un seul équipement), facultative." },
        port: { type: "integer" },
        network_number: { type: "integer" },
        types: { type: "array", items: { type: "string" }, description: "N'importer que ces types, ex. [\"AI\", \"AV\"]." },
        name_prefix: { type: "string", description: "Préfixe ajouté au nom des points, ex. \"PAC1_\"." },
        policy: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["ede"],
    },
    async run({ ede, device, ip, port, network_number, types, name_prefix, policy, confirm }) {
      const parsed = parseEde(ede);
      let devices = parsed.devices.filter((d) => d.objects.length && (device === undefined || d.instance === Number(device)));
      const only = Array.isArray(types) && types.length ? new Set(types.map((t) => bacnetType(t)?.col).filter(Boolean)) : null;
      if (only) devices = devices.map((d) => ({ ...d, objects: d.objects.filter((o) => only.has(o.type)) })).filter((d) => d.objects.length);
      if (!devices.length) throw new Error(`Aucun point à importer${device !== undefined ? ` pour l'équipement ${device}` : ""}. Équipements du fichier : ${parsed.devices.map((d) => `${d.instance} (${d.objects.length} objets)`).join(", ") || "aucun"}.`);
      if (ip && devices.length > 1) throw new Error("ip ne s'applique qu'à un seul équipement : précisez device.");
      const prefix = String(name_prefix ?? "");
      const policies = await remotePolicies();
      const pol = policy ?? (policies.includes("normal") ? "normal" : policies[0]);
      if (policies.length && !policies.includes(pol)) throw new Error(`Politique « ${pol} » inconnue : ${policies.join(", ")}.`);
      const exists = new Map(await Promise.all(devices.map(async (d) => [d.instance, await apex("GET", `${remoteDevicePath(d.instance)}?$select=key`).then(() => true, () => false)])));
      const preview = devices.map((d) => {
        const count = {};
        for (const o of d.objects) count[o.type] = (count[o.type] ?? 0) + 1;
        return `- équipement ${d.instance} « ${d.name} » (${exists.get(d.instance) ? "déjà déclaré" : "à déclarer"}) : ${d.objects.length} point(s) : ${Object.entries(count).map(([k, v]) => `${v} ${k}`).join(", ")}\n${d.objects.slice(0, 8).map((o) => `    ${o.type}/${o.instance} « ${prefix}${o.name} »`).join("\n")}${d.objects.length > 8 ? `\n    …` : ""}`;
      });
      const skipped = [...parsed.skipped].map(([t, n]) => `${n} de type ${t}`).join(", ");
      const what = `import EDE, politique ${pol} :\n${preview.join("\n")}${skipped ? `\nIgnorés (types non pris en charge) : ${skipped}` : ""}`;
      if (confirm !== true) return dryRun(what);
      const out = [];
      let total = 0;
      for (const d of devices) {
        if (!exists.get(d.instance)) {
          await createRemoteDevice({ instance: d.instance, name: d.name || `Device ${d.instance}`, ip, port, network_number });
          saveCreated([...readCreated(), { kind: "bacnet-device", instance: d.instance, name: d.name, at: new Date().toISOString() }]);
        }
        const { lines, created } = await addRemoteObjects(d.instance, d.objects.map((o) => ({ ...o, name: `${prefix}${o.name}` })), pol);
        // Points of a device created here go with it; on an existing device they are remembered one by one.
        if (exists.get(d.instance)) saveCreated([...readCreated(), ...created.map((c) => ({ ...c, at: new Date().toISOString() }))]);
        total += created.length;
        out.push(`Équipement ${d.instance} « ${d.name} » : ${created.length} point(s) créé(s)${lines.length ? `\n${lines.map((l) => `  ${l}`).join("\n")}` : ""}`);
      }
      log({ importEde: devices.map((d) => d.instance), points: total });
      return `Import terminé : ${total} point(s).\n${out.join("\n")}`;
    },
  },
  {
    name: "delete_bacnet_device",
    description: "Supprime un équipement BACnet distant déclaré par ce serveur MCP (create_bacnet_device ou import_ede), avec ses points. Les équipements de la programmation sont refusés. Simulation sans confirm=true.",
    inputSchema: { type: "object", properties: { instance: { type: "integer" }, confirm: { type: "boolean" } }, required: ["instance"] },
    async run({ instance, confirm }) {
      const list = readCreated();
      const mine = list.find((c) => c.kind === "bacnet-device" && String(c.instance) === String(instance));
      if (!mine) throw new Error(`L'équipement ${instance} n'a pas été déclaré par ce serveur MCP : suppression refusée.`);
      const what = `supprimer l'équipement BACnet ${instance} « ${mine.name} » et tous ses points`;
      if (confirm !== true) return dryRun(what);
      await apex("DELETE", remoteDevicePath(instance));
      saveCreated(list.filter((c) => c !== mine && !(c.kind === "remote-object" && c.device === String(instance))));
      log({ deleteDevice: Number(instance), name: mine.name });
      return `Équipement ${instance} « ${mine.name} » supprimé.`;
    },
  },
  {
    name: "create_modbus_device",
    description:
      "Déclare un équipement Modbus (client) : en TCP (ip, port) ou sur un réseau RS-485 de l'APEX (network, voir list_modbus), avec son adresse esclave. Inversions d'octets/mots en option pour les types 32 bits. Simulation sans confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        ip: { type: "string", description: "Modbus TCP." },
        port: { type: "integer", description: "502 par défaut." },
        network: { type: "string", description: "Modbus RTU : nom du réseau RS-485, ex. « Modbus RS-485 Network 1 »." },
        slave: { type: "integer", description: "Adresse esclave (unit id), 1 par défaut." },
        description: { type: "string" },
        word_swap: { type: "boolean", description: "Inverser les mots des valeurs 32/64 bits (Int32, Uint32, Float, Double, Int64)." },
        byte_swap: { type: "boolean", description: "Inverser les octets." },
        confirm: { type: "boolean" },
      },
      required: ["name"],
    },
    async run({ name, ip, port, network, slave, description, word_swap, byte_swap, confirm }) {
      const key = String(name ?? "").trim();
      if (!key || /[/\\?#%]/.test(key)) throw new Error("name obligatoire, sans / \\ ? # %.");
      if (!ip === !network) throw new Error("Donnez soit ip (Modbus TCP), soit network (RS-485).");
      if (network) {
        const nets = Object.keys((await apex("GET", "/services/modbus/networks").catch(() => ({}))) ?? {});
        if (!nets.includes(network)) throw new Error(`Réseau « ${network} » inconnu : ${nets.join(", ") || "aucun réseau RS-485"}.`);
      }
      const exists = await apex("GET", `${modbusPath(key)}?$select=key`).then(() => true, () => false);
      if (exists) throw new Error(`L'équipement Modbus « ${key} » existe déjà.`);
      const id = Number(slave ?? 1);
      if (!Number.isInteger(id) || id < 0 || id > 255) throw new Error("slave : 0 à 255.");
      const encoding = JSON.parse(JSON.stringify(NO_SWAP));
      for (const k of Object.keys(encoding)) {
        if (byte_swap) encoding[k]["byte-swap"] = true;
        if (word_swap && "word-swap" in encoding[k]) encoding[k]["word-swap"] = true;
      }
      const address = ip ? { type: "TcpIp", ip: String(ip), port: Number(port ?? 502), "modbus-address": id } : { type: "Rs485", network: String(network), "modbus-address": id };
      const what = `déclarer l'équipement Modbus « ${key} » : ${ip ? `TCP ${ip}:${port ?? 502}` : network}, esclave ${id}${word_swap ? ", mots inversés" : ""}${byte_swap ? ", octets inversés" : ""}`;
      if (confirm !== true) return dryRun(what);
      await apex("POST", modbusPath(key), { key, address, description: String(description ?? ""), encoding, enabled: true });
      saveCreated([...readCreated(), { kind: "modbus-device", name: key, at: new Date().toISOString() }]);
      log({ createModbus: key, address });
      return `Équipement Modbus « ${key} » déclaré. Ajoutez ses points avec add_modbus_points.`;
    },
  },
  {
    name: "add_modbus_points",
    description:
      "Ajoute des points à un équipement Modbus (registre, adresse, type, échelle, unité, accès). Idéal depuis une table de registres de documentation constructeur. Simulation sans confirm=true.",
    inputSchema: { type: "object", properties: { device: { type: "string" }, points: { type: "array", items: MODBUS_POINT_SCHEMA }, confirm: { type: "boolean" } }, required: ["device", "points"] },
    async run({ device, points, confirm }) {
      if (!Array.isArray(points) || !points.length) throw new Error("points : liste non vide attendue.");
      const list = points.map(modbusPoint);
      const dup = list.map((p) => p.key).find((k, i, a) => a.indexOf(k) !== i);
      if (dup) throw new Error(`Nom en double : ${dup}.`);
      const current = await apex("GET", `${modbusPath(device)}/points`).catch((e) => {
        throw new Error(`Équipement Modbus « ${device} » inconnu (${e.message.slice(0, 80)}).`);
      });
      const taken = list.filter((p) => current?.[p.key]).map((p) => p.key);
      if (taken.length) throw new Error(`Points déjà présents : ${taken.join(", ")}.`);
      const what = `ajouter ${list.length} point(s) à « ${device} » :\n${list.map((p) => `  ${p.key} : ${p["register-type"]} ${p.address} ${p["data-type"]}${p["value-scale"] !== 1 ? ` ×${p["value-scale"]}` : ""} ${p.units} ${p["access-type"]}`).join("\n")}`;
      if (confirm !== true) return dryRun(what);
      await apex("POST", `${modbusPath(device)}/points`, Object.fromEntries(list.map((p) => [p.key, p])));
      const mineDevice = readCreated().some((c) => c.kind === "modbus-device" && c.name === device);
      if (!mineDevice) saveCreated([...readCreated(), ...list.map((p) => ({ kind: "modbus-point", device: String(device), name: p.key, at: new Date().toISOString() }))]);
      log({ addModbusPoints: device, points: list.map((p) => p.key) });
      return `${list.length} point(s) ajouté(s) à « ${device} ». Vérifiez les valeurs et l'état avec list_modbus device="${device}".`;
    },
  },
  {
    name: "delete_modbus",
    description: "Supprime un équipement Modbus déclaré par ce serveur MCP (avec ses points), ou des points ajoutés par lui à un autre équipement. Le reste est refusé. Simulation sans confirm=true.",
    inputSchema: { type: "object", properties: { device: { type: "string" }, points: { type: "array", items: { type: "string" }, description: "Seulement ces points (sinon l'équipement entier)." }, confirm: { type: "boolean" } }, required: ["device"] },
    async run({ device, points, confirm }) {
      const list = readCreated();
      if (!points?.length) {
        const mine = list.find((c) => c.kind === "modbus-device" && c.name === device);
        if (!mine) throw new Error(`L'équipement Modbus « ${device} » n'a pas été déclaré par ce serveur MCP : suppression refusée.`);
        if (confirm !== true) return dryRun(`supprimer l'équipement Modbus « ${device} » et ses points`);
        await apex("DELETE", modbusPath(device));
        saveCreated(list.filter((c) => c !== mine && !(c.kind === "modbus-point" && c.device === device)));
        log({ deleteModbus: device });
        return `Équipement Modbus « ${device} » supprimé.`;
      }
      const deviceIsMine = list.some((c) => c.kind === "modbus-device" && c.name === device);
      const refused = points.filter((p) => !deviceIsMine && !list.some((c) => c.kind === "modbus-point" && c.device === device && c.name === p));
      if (refused.length) throw new Error(`Points non créés par ce serveur MCP, suppression refusée : ${refused.join(", ")}.`);
      if (confirm !== true) return dryRun(`supprimer de « ${device} » les points ${points.join(", ")}`);
      for (const p of points) await apex("DELETE", `${modbusPath(device)}/points/${encodeURIComponent(p)}`);
      saveCreated(list.filter((c) => !(c.kind === "modbus-point" && c.device === device && points.includes(c.name))));
      log({ deleteModbusPoints: device, points });
      return `Supprimé(s) de « ${device} » : ${points.join(", ")}.`;
    },
  },
  {
    name: "bind_network_value",
    description:
      "Lie une network value du programme GFX (numéro, voir list_network_values) à un objet d'un équipement BACnet distant (instance de l'équipement et de l'objet ; le type d'objet est celui défini dans le programme). Modifie la configuration du programme : simulation sans confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        number: { type: "integer", description: "Numéro de la network value (NV)." },
        device: { type: "integer" },
        instance: { type: "integer", description: "Instance de l'objet sur cet équipement." },
        description: { type: "string" },
        confirm: { type: "boolean" },
      },
      required: ["number", "device", "instance"],
    },
    async run({ number, device, instance, description, confirm }) {
      for (const [k, v] of Object.entries({ number, device, instance })) if (!INSTANCE.test(String(v))) throw new Error(`${k} : entier attendu.`);
      const current = unwrap(await apex("GET", `/services/gfx/configuration/network-value-${number}`).catch(() => null));
      const path = (Array.isArray(current) ? current : []).find((p) => /\/objects\/[a-z-]+\/\d+$/.test(p));
      if (!path) throw new Error(`Network value ${number} introuvable dans le programme GFX (voir list_network_values).`);
      const what = `lier la NV ${number} (aujourd'hui ${path.replace("/services/bacnet/remote/devices/", "device ")}) à l'objet ${instance} de l'équipement ${device}`;
      if (confirm !== true) return dryRun(what);
      const r = unwrap(await apex("POST", "/services/gfx/configuration/add-update-network-value", { number: Number(number), "device-instance": Number(device), "object-instance": Number(instance), configuration: description ? { "local-desc": String(description) } : {} }));
      log({ bindNv: Number(number), device: Number(device), instance: Number(instance), before: path, after: r?.results ?? r });
      return `NV ${number} liée : ${fmt(r?.results ?? r)}.`;
    },
  },
);

// --- Discovery (Who-Is) and trend logs ------------------------------------------------------------

/** One line per remote device: instance | name | connection | address | model, discovered ones marked. */
function deviceLine(id, o) {
  const a = o.address;
  const addr = a && typeof a === "object" ? [a.ip, a.port, a["network-number"] !== undefined ? `réseau ${a["network-number"]}` : ""].filter(Boolean).join(":") : a;
  return `${id} | ${pick(o, "local-name", "object-name") ?? ""} | ${fmt(o["connection-status"])} | ${addr ?? ""}${o["model-name"] ? ` | ${o["vendor-name"] ?? ""} ${o["model-name"]}` : ""}${o.persisted === false ? " | découvert, non gardé" : ""}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = Number(env.POLL_MS || 1500);

/** Waits for a discovery job of the APEX to finish (its job field goes back to null). */
async function waitJob(path, field, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const s = unwrap(await apex("GET", `${path}?$select=${field}`).catch(() => ({})));
    if (!s?.[field]) return true;
  }
  return false;
}

TOOLS.push(
  {
    name: "discover_devices",
    description:
      "Lance un Who-Is BACnet depuis l'APEX et liste les équipements qui répondent (instance, nom, IP, réseau, constructeur, modèle). Les équipements découverts sont transitoires : ils ne sont gardés qu'une fois des points ajoutés (add_bacnet_points discovered=true). Ne modifie pas la configuration.",
    inputSchema: {
      type: "object",
      properties: {
        low_limit: { type: "integer", description: "Plus petite instance cherchée (facultatif)." },
        high_limit: { type: "integer", description: "Plus grande instance cherchée (facultatif)." },
        wait: { type: "integer", description: "Attente maximale en secondes, 20 par défaut." },
      },
    },
    async run({ low_limit, high_limit, wait }) {
      const lim = (v) => (v === undefined || v === null ? null : Number(v));
      await apex("POST", "/services/bacnet/remote/discover-devices", { "low-limit": lim(low_limit), "high-limit": lim(high_limit), "network-addresses": null, timeout: null, "clear-transients": true });
      const done = await waitJob("/services/bacnet/remote", "discover-devices-job", Math.min(Number(wait ?? 20), 60));
      const data = await apexSelect("/services/bacnet/remote/devices", "*($select=object-name,local-name,connection-status,address,vendor-name,model-name,persisted,discovery-status)");
      const all = entries(data).map(([id, raw]) => ({ id, o: unwrap(raw) })).filter(({ id }) => !["4194303", "4194304"].includes(id));
      const found = all.filter(({ o }) => o.persisted === false);
      const known = all.filter(({ o }) => o.persisted !== false && /online/i.test(String(o["connection-status"] ?? "")));
      return [
        `Who-Is ${done ? "terminé" : "encore en cours (relancez list_devices dans quelques secondes)"}.`,
        `${found.length} équipement(s) découvert(s), pas encore gardé(s) : instance | nom | connexion | adresse | modèle`,
        ...found.map(({ id, o }) => deviceLine(id, o)),
        `${known.length} équipement(s) déjà configuré(s) en ligne${known.length ? " :" : "."}`,
        ...known.map(({ id, o }) => deviceLine(id, o)),
        found.length ? "Suite : discover_objects device=… pour voir ses points, puis add_bacnet_points discovered=true." : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  },
  {
    name: "discover_objects",
    description:
      "Lit la liste des objets d'un équipement BACnet distant (découvert ou configuré) : nombre par type et points avec nom et état (gardé ou non). Ne modifie pas la configuration.",
    inputSchema: {
      type: "object",
      properties: { device: { type: "integer" }, search: { type: "string" }, limit: { type: "integer", description: "200 par défaut." } },
      required: ["device"],
    },
    async run({ device, search, limit }) {
      if (!INSTANCE.test(String(device))) throw new Error("device : instance entière attendue.");
      const path = remoteDevicePath(device);
      const dev = await apex("GET", `${path}?$select=local-name,object-name,persisted`).then(unwrap, () => null);
      if (!dev) throw new Error(`Équipement ${device} inconnu : lancez d'abord discover_devices.`);
      await apex("POST", `${path}/discover-objects`, {});
      const done = await waitJob(path, "discover-objects-job", 60);
      const objs = await apexSelect(`${path}/objects`, "*($select=*($select=local-name,object-name,present-value,units,persisted,state-text))");
      const counts = Object.entries(objs ?? {}).map(([col, items]) => `${entries(items).length} ${col}`);
      const words = String(search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const lines = [];
      for (const [col, items] of Object.entries(objs ?? {})) {
        if (!BACNET_TYPES.some((t) => t.col === col)) continue;
        for (const [inst, raw] of entries(items)) {
          const o = unwrap(raw);
          const name = pick(o, "local-name", "object-name") ?? "";
          if (words.some((w) => !name.toLowerCase().includes(w))) continue;
          lines.push(`${col}/${inst} | ${name} | ${o.persisted ? display(col, o) : "non gardé"}`);
        }
      }
      const max = Number(limit) > 0 ? Number(limit) : 200;
      return [
        `Équipement ${device} « ${pick(dev, "local-name", "object-name") ?? ""} »${dev.persisted === false ? " (découvert, non gardé)" : ""} : ${done ? "" : "lecture encore en cours, "}${counts.join(", ") || "aucun objet"}.`,
        `${lines.length} point(s)${lines.length > max ? `, ${max} affichés` : ""} : type/instance | nom | valeur (si gardé)`,
        ...lines.slice(0, max),
      ].join("\n");
    },
  },
);

const TREND_SOURCE = /^(analog|binary|multi-state)-(inputs|outputs|values)$/;

WRITE_TOOLS.push({
  name: "create_trend_log",
  description:
    "Crée un trend log (historique) sur un point, local ou d'un équipement distant : enregistrement à chaque changement (cov) ou périodique (interval, toutes les N minutes). L'historique apparaît ensuite dans list_trend_logs et get_history. Simulation sans confirm=true ; supprimable ensuite avec delete_object type=trend-logs.",
  inputSchema: {
    type: "object",
    properties: {
      point: { type: "string", description: "Point enregistré, ex. analog-values/464." },
      device: DEVICE,
      mode: { type: "string", enum: ["cov", "interval"], description: "interval par défaut pour une grandeur analogique, cov pour un binaire ou multi-état." },
      interval_minutes: { type: "number", description: "Période en minutes pour mode=interval, 15 par défaut." },
      buffer_size: { type: "integer", description: "Nombre d'enregistrements gardés, 5000 par défaut (environ 52 jours à 15 min)." },
      name: { type: "string", description: "Nom du trend log, « <nom du point> Trend Log » par défaut." },
      confirm: { type: "boolean" },
    },
    required: ["point"],
  },
  async run({ point, device, mode, interval_minutes, buffer_size, name, confirm }) {
    const { type, instance } = parsePoint(point);
    if (!TREND_SOURCE.test(type)) throw new Error("Seuls les AI, AO, AV, BI, BO, BV, MSI, MSO et MSV peuvent être enregistrés.");
    const remote = device !== undefined && device !== null && device !== "";
    const src = unwrap(await apex("GET", `${objectsPath(device)}/${type}/${instance}?$select=object-name,local-name,persisted`).catch(() => null));
    if (!src) throw new Error(`${remote ? `device ${device} ` : ""}${type}/${instance} introuvable.`);
    if (remote && src.persisted === false) throw new Error("Ce point distant n'est pas gardé par l'APEX : ajoutez-le d'abord (add_bacnet_points).");
    const pointName = pick(src, "local-name", "object-name") ?? `${type}/${instance}`;
    const m = mode ?? (type.startsWith("analog") ? "interval" : "cov");
    if (!["cov", "interval"].includes(m)) throw new Error("mode : cov ou interval.");
    const minutes = Number(interval_minutes ?? 15);
    if (m === "interval" && !(minutes > 0 && minutes <= 1440)) throw new Error("interval_minutes : de 0.1 à 1440.");
    const size = Number(buffer_size ?? 5000);
    if (!Number.isInteger(size) || size < 10 || size > 100000) throw new Error("buffer_size : 10 à 100000.");
    const logName = String(name ?? `${pointName} Trend Log`).slice(0, 128);
    const existing = (await trendLogs().catch(() => [])).filter((l) => l.point === `${type}/${instance}` && (remote ? l.device === String(device) : !l.device));
    const used = new Set(entries(await apex("GET", "/services/bacnet/local/objects/trend-logs?$select=*($select=key)").catch(() => ({}))).map(([k]) => Number(k)));
    let inst = 10000;
    while (used.has(inst)) inst++;
    const what = `créer le trend log trend-logs/${inst} « ${logName} » sur ${remote ? `device ${device} ` : ""}${type}/${instance} « ${pointName} » : ${m === "cov" ? "à chaque changement" : `toutes les ${minutes} min`}, ${size} enregistrements${existing.length ? ` (ce point est déjà enregistré par : ${existing.map((l) => l.key).join(", ")})` : ""}`;
    if (confirm !== true) return dryRun(what);
    await apex("POST", "/services/bacnet/local/objects/add", { "object-type": "TrendLog", "instance-number": inst, name: logName });
    saveCreated([...readCreated(), { type: "trend-logs", instance: inst, name: logName, at: new Date().toISOString() }]);
    await apex("POST", `/services/bacnet/local/objects/trend-logs/${inst}`, {
      "source-reference": {
        "property-identifier": "PresentValue",
        "object-identifier": { "object-type": bacnetType(type).name, "object-instance": Number(instance) },
        ...(remote ? { "device-identifier": { "object-type": "Device", "object-instance": Number(device) } } : {}),
      },
      "logging-type": m === "cov" ? "Cov" : "Polled",
      // BACnet log-interval is in hundredths of a second.
      "logging-interval": m === "cov" ? 0 : Math.round(minutes * 6000),
      "buffer-size": size,
      enable: true,
    });
    log({ createTrendLog: inst, name: logName, source: `${remote ? `device/${device}/` : ""}${type}/${instance}`, mode: m, minutes, size });
    return `Trend log créé : trend-logs/${inst} « ${logName} ». Lisez-le avec get_history point=${type}/${instance}${remote ? ` device=${device}` : ""}.`;
  },
});

// --- Backups of the APEX configuration ---------------------------------------------------------------

/** Hours between two automatic backups before a configuration change; 0 disables them. */
const AUTO_BACKUP_HOURS = Number(env.AUTO_BACKUP_HOURS ?? 12);
const AUTO_BACKUP_KEEP = 5;
const backupStamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

async function listBackups() {
  const root = unwrap(await apex("GET", "/services/backup"));
  return {
    excludes: Array.isArray(root?.excludes) ? root.excludes : [],
    backups: entries(root?.backups)
      .map(([k, b]) => ({ key: b.key ?? k, size: b.size, created: b["creation-time"], includes: b.includes }))
      .sort((a, b) => String(b.created).localeCompare(String(a.created))),
  };
}

/** Creates a full backup on the APEX and waits for its job (about 3 s on a real APEX). */
async function createBackup(name) {
  const r = unwrap(await apex("POST", "/services/backup/backups/create", { item: name, option: "full" }));
  const done = await waitJob("/services/backup", "job", 120);
  const made = (await listBackups()).backups.find((b) => b.key === name);
  if (!made) throw new Error(`Sauvegarde « ${name} » non trouvée après la création${done ? "" : " (encore en cours)"} : ${fmt(r)}`);
  return made;
}

let lastAutoBackup = 0;
/** Backup before a configuration change, unless a recent one was made by this server. Returns a note. */
async function autoBackup() {
  if (!(AUTO_BACKUP_HOURS > 0)) return "";
  const recent = readCreated().filter((c) => c.kind === "backup" && c.auto);
  const newest = Math.max(lastAutoBackup, ...recent.map((c) => Date.parse(c.at) || 0));
  if (Date.now() - newest < AUTO_BACKUP_HOURS * 3600e3) return "";
  const name = `mcp-auto-${backupStamp()}`;
  try {
    await createBackup(name);
  } catch (e) {
    return `\n(Sauvegarde automatique impossible : ${e.message})`;
  }
  lastAutoBackup = Date.now();
  // Only the last automatic backups are kept.
  const list = [...readCreated(), { kind: "backup", name, auto: true, at: new Date().toISOString() }];
  const autos = list.filter((c) => c.kind === "backup" && c.auto).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  for (const old of autos.slice(AUTO_BACKUP_KEEP)) await apex("DELETE", `/services/backup/backups/${encodeURIComponent(old.name)}`).catch(() => undefined);
  saveCreated(list.filter((c) => !autos.slice(AUTO_BACKUP_KEEP).includes(c)));
  log({ autoBackup: name });
  return `\n(Sauvegarde automatique de l'APEX faite avant cette modification : « ${name} », restaurable avec restore_backup.)`;
}

TOOLS.push({
  name: "list_backups",
  description: "Sauvegardes de configuration présentes sur l'APEX : nom, date, taille, et celles faites par ce serveur MCP (automatiques ou non).",
  inputSchema: { type: "object", properties: {} },
  async run() {
    const { backups, excludes } = await listBackups();
    const mine = new Map(readCreated().filter((c) => c.kind === "backup").map((c) => [c.name, c]));
    const lines = backups.map((b) => `${b.key} | ${b.created ?? "?"} | ${typeof b.size === "number" ? `${Math.round(b.size / 1024)} Ko` : "?"}${mine.has(b.key) ? (mine.get(b.key).auto ? " | auto MCP" : " | MCP") : ""}`);
    return [
      lines.length ? `${lines.length} sauvegarde(s) : nom | date | taille | origine` : "Aucune sauvegarde sur l'APEX.",
      ...lines,
      `Sauvegarde automatique avant modification : ${AUTO_BACKUP_HOURS > 0 ? `au plus une toutes les ${AUTO_BACKUP_HOURS} h, ${AUTO_BACKUP_KEEP} gardées` : "désactivée"}.`,
      excludes.length ? `Parties exclues possibles à la restauration : ${excludes.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  },
});

// --- Alarms -----------------------------------------------------------------------------------------

async function alarmRows() {
  const table = await apex("POST", "/services/alarms/get-alarm-table", {});
  return Array.isArray(table?.rows) ? table.rows : [];
}
const alarmLine = (r) => `#${r.id} | ${r.timestamp} | ${r["from-state"]}→${r["to-state"]} | ${String(r.source ?? "").replace("/services/bacnet/local/objects/", "")} | ${r.message ?? ""}`;

TOOLS.push({
  name: "alarm_setup",
  description: "Configuration des alarmes de l'APEX : classes (priorité et acquittement requis par état, destinataires), destinataires (e-mail, MQTT), comptes e-mail et connexions MQTT disponibles.",
  inputSchema: { type: "object", properties: {} },
  async run() {
    const [classes, recipients, email, mqtt] = await Promise.all([
      apex("GET", "/services/alarms/classes").catch(() => ({})),
      apex("GET", "/services/alarms/recipients").catch(() => ({})),
      apex("GET", "/services/email/accounts").catch(() => ({})),
      apex("GET", "/services/mqtt/connections").catch(() => ({})),
    ]);
    const out = ["Classes :"];
    for (const [k, raw] of entries(classes)) {
      const c = unwrap(raw);
      const st = (s) => `${s?.["ack-required"] ? "acquittement requis" : "sans acquittement"}, priorité ${s?.priority ?? "?"}`;
      out.push(`- ${k} : alarme (${st(c["offnormal-state"])}), défaut (${st(c["fault-state"])}), retour normal (${st(c["normal-state"])}) ; destinataires : ${Object.keys(c.recipients ?? {}).join(", ") || "aucun"}`);
    }
    const rec = entries(recipients).map(([k, raw]) => {
      const r = unwrap(raw);
      return `- ${k} : ${r.type ?? "?"}${r.topic ? ` sujet ${r.topic}` : ""}${r["addresses-to"]?.length ? ` vers ${r["addresses-to"].join(", ")}` : ""}${r.connection ? ` via ${r.connection}` : ""}${r.account ? ` via ${r.account}` : ""}`;
    });
    out.push(`Destinataires : ${rec.length ? "" : "aucun"}`, ...rec);
    out.push(`Comptes e-mail : ${Object.keys(email ?? {}).join(", ") || "aucun"}.`, `Connexions MQTT : ${Object.keys(mqtt ?? {}).join(", ") || "aucune"}.`);
    return out.join("\n");
  },
});

/** The "alarm" block of a BACnet object, as the APEX stores intrinsic reporting. */
function alarmBlock(type, o, args) {
  const block = { "event-detection-enable": args.enable !== false };
  if (args.enable === false) return block;
  block["event-enable"] = { "to-off-normal": true, "to-fault": true, "to-normal": true };
  block["notify-type"] = args.notify_type === "event" ? "Event" : "Alarm";
  if (args.time_delay !== undefined) block["time-delay"] = Number(args.time_delay);
  if (args.notification_class !== undefined) block["notification-class"] = Number(args.notification_class);
  if (args.messages) {
    block["event-message-texts-config"] = {
      "to-off-normal": String(args.messages.alarm ?? ""),
      "to-normal": String(args.messages.normal ?? ""),
      "to-fault": String(args.messages.fault ?? ""),
    };
  }
  if (type.startsWith("analog")) {
    if (args.high_limit === undefined && args.low_limit === undefined) throw new Error("Point analogique : high_limit et/ou low_limit attendus.");
    if (args.high_limit !== undefined) block["high-limit"] = Number(args.high_limit);
    if (args.low_limit !== undefined) block["low-limit"] = Number(args.low_limit);
    if (args.high_limit !== undefined && args.low_limit !== undefined && Number(args.low_limit) >= Number(args.high_limit)) throw new Error("low_limit doit être inférieur à high_limit.");
    block.deadband = Number(args.deadband ?? 0);
    block["limit-enable"] = { "high-limit-enable": args.high_limit !== undefined, "low-limit-enable": args.low_limit !== undefined };
  } else if (type.startsWith("binary")) {
    const v = String(args.alarm_value ?? "active").toLowerCase();
    if (!["active", "inactive"].includes(v)) throw new Error("alarm_value : active ou inactive.");
    block["alarm-value"] = v === "active" ? "Active" : "Inactive";
  } else if (type.startsWith("multi-state")) {
    const states = Array.isArray(o["state-text"]) ? o["state-text"] : [];
    const values = (args.alarm_values ?? []).map((x) => (Number.isInteger(Number(x)) ? Number(x) : states.findIndex((s) => String(s).toLowerCase() === String(x).toLowerCase()) + 1));
    if (!values.length || values.some((n) => !(n >= 1))) throw new Error(`Multi-état : alarm_values = numéros ou textes d'état en alarme${states.length ? ` (${states.map((s, i) => `${i + 1}=${s}`).join(", ")})` : ""}.`);
    block["alarm-values"] = values;
  }
  return block;
}

WRITE_TOOLS.push(
  {
    name: "ack_alarms",
    description: "Acquitte des alarmes : par numéros (#id de get_alarms), toutes celles non acquittées d'un point, ou toutes les non acquittées. Simulation sans confirm=true. L'acquittement est enregistré au nom du compte APEX du MCP.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "integer" } },
        point: { type: "string", description: "Toutes les alarmes non acquittées de ce point, ex. binary-inputs/104." },
        all: { type: "boolean", description: "Toutes les alarmes non acquittées." },
        confirm: { type: "boolean" },
      },
    },
    async run({ ids, point, all, confirm }) {
      const rows = await alarmRows();
      const unacked = rows.filter((r) => !/^acked$/i.test(String(r["ack-state"] ?? "")));
      let pick = [];
      if (Array.isArray(ids) && ids.length) pick = rows.filter((r) => ids.map(Number).includes(Number(r.id)));
      else if (point) pick = unacked.filter((r) => String(r.source ?? "").endsWith(`/objects/${point}`));
      else if (all === true) pick = unacked;
      else throw new Error("ids, point ou all=true attendu.");
      const todo = pick.filter((r) => !/^acked$/i.test(String(r["ack-state"] ?? "")));
      if (!todo.length) return "Rien à acquitter : ces alarmes sont déjà acquittées ou introuvables.";
      const what = `acquitter ${todo.length} alarme(s) :\n${todo.slice(0, 30).map(alarmLine).join("\n")}${todo.length > 30 ? `\n… et ${todo.length - 30} autres` : ""}`;
      if (confirm !== true) return dryRun(what);
      await apex("POST", "/services/alarms/ack-alarms", { ids: todo.map((r) => Number(r.id)) });
      log({ ackAlarms: todo.map((r) => r.id) });
      // Point alarms are acknowledged through BACnet: the table shows it a moment later.
      let still = todo;
      for (let i = 0; i < Math.ceil(6000 / Math.min(POLL_MS, 1000)) && still.length; i++) {
        const after = await alarmRows();
        still = after.filter((r) => todo.some((t) => t.id === r.id) && !/^acked$/i.test(String(r["ack-state"] ?? "")));
        if (still.length) await sleep(Math.min(POLL_MS, 1000));
      }
      return `${todo.length - still.length} alarme(s) acquittée(s).${still.length ? ` Non acquittées : ${still.map((r) => `#${r.id}`).join(", ")}.` : ""}`;
    },
  },
  {
    name: "configure_point_alarm",
    description:
      "Configure l'alarme d'un point local (BACnet intrinsic reporting) : seuils haut/bas et bande morte pour un analogique, valeur d'alarme pour un binaire, états en alarme pour un multi-état ; temporisation, classe de notification, messages ({ObjectName}, {EventState} possibles). enable=false désactive. Simulation sans confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        point: { type: "string", description: "Point local, ex. analog-values/12." },
        enable: { type: "boolean", description: "true par défaut ; false désactive la détection." },
        high_limit: { type: "number" },
        low_limit: { type: "number" },
        deadband: { type: "number" },
        alarm_value: { type: "string", enum: ["active", "inactive"] },
        alarm_values: { type: "array", items: { type: ["integer", "string"] } },
        time_delay: { type: "integer", description: "Temporisation en secondes." },
        notification_class: { type: "integer" },
        notify_type: { type: "string", enum: ["alarm", "event"] },
        messages: { type: "object", properties: { alarm: { type: "string" }, normal: { type: "string" }, fault: { type: "string" } } },
        confirm: { type: "boolean" },
      },
      required: ["point"],
    },
    async run(args) {
      const { type, instance } = parsePoint(args.point);
      if (!TREND_SOURCE.test(type)) throw new Error("Alarme configurable sur AI, AO, AV, BI, BO, BV, MSI, MSO, MSV.");
      const path = `/services/bacnet/local/objects/${type}/${instance}`;
      const { o, name } = await writableObject(path);
      const block = alarmBlock(type, o, args);
      const current = o.alarm && typeof o.alarm === "object" ? o.alarm : null;
      const describe = (b) =>
        !b?.["event-detection-enable"]
          ? "détection désactivée"
          : [
              b["high-limit"] !== undefined && b["limit-enable"]?.["high-limit-enable"] !== false ? `haut ${b["high-limit"]}` : "",
              b["low-limit"] !== undefined && b["limit-enable"]?.["low-limit-enable"] !== false ? `bas ${b["low-limit"]}` : "",
              b.deadband ? `bande morte ${b.deadband}` : "",
              b["alarm-value"] ? `alarme si ${b["alarm-value"]}` : "",
              b["alarm-values"] ? `alarme si état ${b["alarm-values"].join(", ")}` : "",
              b["time-delay"] ? `temporisation ${b["time-delay"]} s` : "",
            ]
              .filter(Boolean)
              .join(", ") || "détection active";
      const what = `${type}/${instance} « ${name} » (valeur ${display(type, o)}) : alarme ${current ? describe(current) : "non configurée"} → ${describe(block)}`;
      if (args.confirm !== true) return dryRun(what);
      await apex("POST", path, { alarm: block });
      await sleep(Math.min(POLL_MS, 1500));
      const after = unwrap(await apex("GET", `${path}?$select=alarm,event-state`));
      log({ configureAlarm: `${type}/${instance}`, name, alarm: block });
      if (block["event-detection-enable"] && !after.alarm?.["event-detection-enable"]) throw new Error(`L'APEX n'a pas activé l'alarme de ${type}/${instance} (configuration relue : ${fmt(after.alarm)}).`);
      return `Alarme configurée. ${what}. État actuel : ${after["event-state"] ?? "?"}.`;
    },
  },
  {
    name: "raise_alarm",
    description:
      "Envoie une alarme dans une classe d'alarme de l'APEX (elle part vers les destinataires de la classe, e-mail ou MQTT), par exemple après une analyse : « dérive de la loi d'eau ». Reliée à un point. to_state=Normal clôt une alarme envoyée avant. Simulation sans confirm=true.",
    inputSchema: {
      type: "object",
      properties: {
        point: { type: "string", description: "Point concerné, ex. analog-values/467." },
        device: DEVICE,
        message: { type: "string" },
        to_state: { type: "string", enum: ["Offnormal", "Fault", "Normal"], description: "Offnormal par défaut." },
        class: { type: "string", description: "Classe d'alarme, bacnet par défaut (voir alarm_setup)." },
        confirm: { type: "boolean" },
      },
      required: ["point", "message"],
    },
    async run({ point, device, message, to_state, class: cls, confirm }) {
      const { type, instance } = parsePoint(point);
      const source = `${objectsPath(device)}/${type}/${instance}`;
      await apex("GET", `${source}?$select=key`).catch(() => {
        throw new Error(`${point} introuvable.`);
      });
      const klass = String(cls ?? "bacnet");
      const classes = Object.keys((await apex("GET", "/services/alarms/classes").catch(() => ({}))) ?? {});
      if (classes.length && !classes.includes(klass)) throw new Error(`Classe « ${klass} » inconnue : ${classes.join(", ")}.`);
      const to = to_state ?? "Offnormal";
      const from = to === "Normal" ? "Offnormal" : "Normal";
      const what = `envoyer dans la classe ${klass} une alarme ${from}→${to} sur ${point} : « ${message} »`;
      if (confirm !== true) return dryRun(what);
      const r = unwrap(await apex("POST", `/services/alarms/classes/${encodeURIComponent(klass)}/add-alarm`, { source, "from-state": from, "to-state": to, message: String(message), data: "{}" }));
      log({ raiseAlarm: point, to, message, id: r?.results });
      return `Alarme envoyée (#${r?.results ?? "?"}) : ${what}.`;
    },
  },
  {
    name: "create_backup",
    description: "Fait une sauvegarde complète de la configuration de l'APEX (quelques secondes, environ 1 Mo), gardée sur l'APEX et restaurable avec restore_backup. Simulation sans confirm=true.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Nom, « mcp-<date> » par défaut." }, confirm: { type: "boolean" } } },
    async run({ name, confirm }) {
      const key = String(name ?? `mcp-${backupStamp()}`).trim();
      if (!/^[\w.-]{1,64}$/.test(key)) throw new Error("name : lettres, chiffres, . _ - (64 caractères max).");
      if ((await listBackups()).backups.some((b) => b.key === key)) throw new Error(`La sauvegarde « ${key} » existe déjà.`);
      if (confirm !== true) return dryRun(`sauvegarder la configuration de l'APEX sous « ${key} »`);
      const made = await createBackup(key);
      saveCreated([...readCreated(), { kind: "backup", name: key, at: new Date().toISOString() }]);
      log({ backup: key, size: made.size });
      return `Sauvegarde « ${key} » faite (${typeof made.size === "number" ? `${Math.round(made.size / 1024)} Ko` : "taille inconnue"}).`;
    },
  },
  {
    name: "delete_backup",
    description: "Supprime une sauvegarde faite par ce serveur MCP (les autres sont refusées). Simulation sans confirm=true.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, confirm: { type: "boolean" } }, required: ["name"] },
    async run({ name, confirm }) {
      const list = readCreated();
      const mine = list.find((c) => c.kind === "backup" && c.name === name);
      if (!mine) throw new Error(`La sauvegarde « ${name} » n'a pas été faite par ce serveur MCP : suppression refusée.`);
      if (confirm !== true) return dryRun(`supprimer la sauvegarde « ${name} »`);
      await apex("DELETE", `/services/backup/backups/${encodeURIComponent(name)}`);
      saveCreated(list.filter((c) => c !== mine));
      log({ deleteBackup: name });
      return `Sauvegarde « ${name} » supprimée.`;
    },
  },
  {
    name: "restore_backup",
    description:
      "Restaure une sauvegarde de l'APEX : remet toute la configuration (points, programmes, Modbus, équipements…) dans l'état de la sauvegarde, et retire ce qui a été ajouté depuis. Coupure des services pendant la restauration. Opération lourde : simulation sans confirm=true, et confirmation explicite de l'utilisateur obligatoire.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        keep: { type: "array", items: { type: "string" }, description: "Parties à ne pas restaurer, parmi celles listées par list_backups (ex. Users, AlarmsTrends)." },
        confirm: { type: "boolean" },
      },
      required: ["name"],
    },
    async run({ name, keep, confirm }) {
      const { backups, excludes } = await listBackups();
      const b = backups.find((x) => x.key === name);
      if (!b) throw new Error(`Sauvegarde « ${name} » introuvable : ${backups.map((x) => x.key).join(", ") || "aucune"}.`);
      const kept = Array.isArray(keep) ? keep : [];
      const bad = kept.filter((k) => !excludes.includes(k));
      if (bad.length) throw new Error(`keep : parmi ${excludes.join(", ")}.`);
      const what = `restaurer la sauvegarde « ${name} » du ${b.created ?? "?"}${kept.length ? `, sans restaurer ${kept.join(", ")}` : ""}. Tout ce qui a été configuré depuis cette date sera perdu, et les services de l'APEX redémarrent`;
      if (confirm !== true) return dryRun(what);
      const r = unwrap(await apex("POST", "/services/backup/backups/restore", { item: name, excludes: kept.join(","), remove: "true" }));
      log({ restore: name, keep: kept });
      return `Restauration lancée (${fmt(r)}). L'APEX applique la sauvegarde « ${name} » : ses services, dont ce serveur MCP, peuvent être indisponibles quelques minutes.`;
    },
  },
);

/** Tools that change the configuration: a backup is made before them (see autoBackup). */
const AUTO_BACKUP_TOOLS = new Set([
  "write_property", "write_schedule", "create_object", "delete_object", "create_bacnet_device", "add_bacnet_points", "import_ede",
  "delete_bacnet_device", "create_modbus_device", "add_modbus_points", "delete_modbus", "bind_network_value", "create_trend_log", "configure_point_alarm",
]);

if (ALLOW_WRITE) TOOLS.push(...WRITE_TOOLS);
const MUTATING = new Set(["save_site_notes", ...WRITE_TOOLS.map((t) => t.name)]);

/** Flux queries that write or call out are refused: the token is an all-access one. */
const FLUX_WRITE = /\b(to|wideTo)\s*\(|import\s+"(http|sql|mqtt|slack|pagerduty|influxdata\/influxdb\/secrets|experimental\/(http|mqtt|bigtable)|contrib\/)/;

if (INFLUX) {
  TOOLS.push({
    name: "query_influx",
    description:
      `Requête Flux en lecture sur l'InfluxDB du site (bucket « ${INFLUX.bucket} », données collectées par Telegraf/Node-RED). Réponse CSV. ` +
      `Découvrir : import "influxdata/influxdb/schema" schema.measurements(bucket: "${INFLUX.bucket}"). ` +
      `Toujours agréger les longues périodes, ex. from(bucket: "${INFLUX.bucket}") |> range(start: -7d) |> filter(fn: (r) => r._measurement == "mqtt_consumer") |> aggregateWindow(every: 1h, fn: mean).`,
    inputSchema: { type: "object", properties: { flux: { type: "string" } }, required: ["flux"] },
    async run({ flux }) {
      if (FLUX_WRITE.test(String(flux))) throw new Error("Requête refusée : lecture seule (to(), http, sql… interdits).");
      const res = await fetch(`${INFLUX.url}/api/v2/query?org=${encodeURIComponent(INFLUX.org)}`, {
        method: "POST",
        headers: { Authorization: `Token ${INFLUX.token}`, "Content-Type": "application/vnd.flux", Accept: "application/csv" },
        body: String(flux),
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`InfluxDB ${res.status} : ${text.slice(0, 500)}`);
      return text.trim() || "Aucune donnée.";
    },
  });
}

const INSTRUCTIONS = [
  "Serveur MCP d'un automate Distech ECLYPSE APEX (GTB). Les points sont des objets BACnet ; les noms viennent de la programmation de l'intégrateur.",
  "Commencez par site_notes pour le contexte du site, puis list_points (filtré par type, texte ou état) et read_points / read_point. Les historiques viennent des trend logs (list_trend_logs, get_history, compare_histories)" +
    (INFLUX ? " et d'InfluxDB (query_influx)." : "."),
  "Les valeurs sont celles de l'automate, en unités BACnet (DegreesCelsius, Percent…). Citez les points par type/instance et nom.",
  "Pour trouver les équipements BACnet du réseau : discover_devices (Who-Is), puis discover_objects pour voir leurs points.",
  ALLOW_WRITE && AUTO_BACKUP_HOURS > 0
    ? `Une sauvegarde de l'APEX est faite automatiquement avant une modification de configuration (au plus une toutes les ${AUTO_BACKUP_HOURS} h) ; avant un gros chantier, proposez create_backup avec un nom parlant.`
    : "",
  ALLOW_WRITE
    ? `Écriture possible (write_point, write_property, write_schedule, create_object, delete_object ; intégration : create_bacnet_device, add_bacnet_points, import_ede, create_modbus_device, add_modbus_points, bind_network_value, create_trend_log ; alarmes : ack_alarms, configure_point_alarm, raise_alarm ; sauvegardes : create_backup, restore_backup) : appelez toujours d'abord sans confirm pour une simulation, montrez-la, et ne rappelez avec confirm=true qu'après accord explicite de l'utilisateur pour cette action précise. Priorité BACnet ${PRIORITY} par défaut, jamais en dessous de ${MIN_PRIORITY}.`
    : "Accès en lecture seule : aucune écriture dans l'automate n'est possible.",
].filter(Boolean).join("\n");

// --- Prompts: ready-made analyses offered by the client (slash commands in Claude Code) -------------

const PROMPTS = [
  {
    name: "bilan_alarmes",
    title: "Bilan des alarmes",
    description: "Alarmes non acquittées et points anormaux, regroupés par équipement, avec les actions à mener.",
    arguments: [],
    text: () =>
      "Fais le bilan des alarmes de l'APEX : lis site_notes, puis get_alarms (unacked_only) et list_points avec status=abnormal. Regroupe par équipement (préfixe du nom : CTA1, UG65…), distingue défauts de communication, défauts matériels et alarmes process, signale ce qui semble ancien ou répétitif, et termine par une liste d'actions priorisées.",
  },
  {
    name: "audit_equipement",
    title: "Audit d'un équipement",
    description: "État complet d'un équipement (CTA, chaufferie, zone…) à partir du préfixe de ses points.",
    arguments: [{ name: "equipement", description: "Préfixe ou mot du nom des points, ex. CTA1", required: true }],
    text: ({ equipement }) =>
      `Audite l'équipement « ${equipement} » : lis site_notes, liste ses points avec list_points search="${equipement}", lis ses alarmes, et regarde les historiques disponibles des points principaux (list_trend_logs search="${equipement}", compare_histories sur 7 jours). Vérifie la cohérence (consignes vs mesures, marche vs défauts, valeurs figées à 0 ou hors plage, forçages et priorités actives). Conclus par les anomalies et les points à vérifier sur site.`,
  },
  {
    name: "analyse_courbes",
    title: "Analyse de courbes",
    description: "Compare des grandeurs sur une période (loi d'eau, consigne vs mesure, confort…).",
    arguments: [
      { name: "points", description: "Points ou trend logs séparés par des virgules, ex. analog-values/459, analog-values/460", required: true },
      { name: "periode", description: "Période relative, ex. 7d (par défaut) ou 24h", required: false },
    ],
    text: ({ points, periode }) =>
      `Compare ces séries sur ${periode || "7d"} avec compare_histories (interval hour) : ${points}. Décris les tendances, les corrélations (ex. départ en fonction de la T extérieure pour une loi d'eau), les écarts consigne/mesure, les cycles courts ou valeurs figées, et propose des réglages argumentés. Si une série n'a pas de trend log, dis-le et propose d'en créer un dans la programmation.`,
  },
  {
    name: "integrer_equipement",
    title: "Intégrer un équipement",
    description: "Intègre un équipement tiers à partir de sa documentation : fichier EDE (BACnet) ou table de registres (Modbus).",
    arguments: [{ name: "source", description: "Chemin ou description du fichier EDE / de la table Modbus, et adresse de l'équipement", required: true }],
    text: ({ source }) =>
      `Intègre cet équipement dans l'APEX : ${source}. Pour un équipement BACnet présent sur le réseau, lance discover_devices puis discover_objects, et propose add_bacnet_points discovered=true avec les points utiles. Pour un fichier EDE (BACnet), lis son contenu et appelle import_ede sans confirm pour l'aperçu. Pour une table de registres Modbus, vérifie list_modbus (réseaux RS-485 disponibles), puis prépare create_modbus_device et add_modbus_points (registre, adresse, type, échelle, unité, accès) en signalant chaque hypothèse (adressage 0/1, ordre des mots des valeurs 32 bits). Montre-moi le plan complet, et ne confirme qu'après mon accord. Ensuite vérifie la communication (list_points device=…, list_modbus device=…) et propose des trend logs (create_trend_log) sur les grandeurs importantes.`,
  },
  {
    name: "documenter_site",
    title: "Documenter le site",
    description: "Construit avec l'utilisateur la description du site (circuits, points clés, consignes) gardée sur l'APEX.",
    arguments: [],
    text: () =>
      "Aide-moi à documenter ce site pour les analyses futures : lis site_notes, parcours list_points par type pour repérer les équipements (préfixes) et les points clés, puis propose une description Markdown structurée (équipements, rôle des points importants, consignes attendues, particularités). Pose-moi les questions nécessaires, et enregistre avec save_site_notes seulement quand je valide.",
  },
];

// --- MCP over HTTP -------------------------------------------------------------------------------

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05", "2025-11-25"];
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const cut = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `\n… (tronqué, ${s.length} caractères : filtrez davantage)` : s);

async function rpc(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(msg?.id ?? null, -32600, "Invalid Request");
  const { id, method, params } = msg;
  if (id === undefined) return null; // notification (notifications/initialized…)
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "eclypse-apex", title: "ECLYPSE APEX", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: TOOLS.map(({ run, ...t }) => ({ ...t, annotations: { readOnlyHint: !MUTATING.has(t.name), destructiveHint: t.name.startsWith("delete_"), openWorldHint: false } })),
      });
    case "prompts/list":
      return ok(id, { prompts: PROMPTS.map(({ text, ...p }) => p) });
    case "prompts/get": {
      const prompt = PROMPTS.find((p) => p.name === params?.name);
      if (!prompt) return fail(id, -32602, `Unknown prompt: ${params?.name}`);
      const args = params.arguments ?? {};
      const missing = prompt.arguments.filter((a) => a.required && !args[a.name]);
      if (missing.length) return fail(id, -32602, `Missing argument: ${missing.map((a) => a.name).join(", ")}`);
      return ok(id, { description: prompt.description, messages: [{ role: "user", content: { type: "text", text: prompt.text(args) } }] });
    }
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
      const started = Date.now();
      try {
        // A configuration change is preceded by a backup of the APEX (at most one every AUTO_BACKUP_HOURS).
        const backup = AUTO_BACKUP_TOOLS.has(tool.name) && params.arguments?.confirm === true ? await autoBackup() : "";
        const text = (await tool.run(params.arguments ?? {})) + backup;
        console.log(JSON.stringify({ at: new Date().toISOString(), tool: tool.name, ms: Date.now() - started }));
        return ok(id, { content: [{ type: "text", text: cut(String(text)) }] });
      } catch (e) {
        console.log(JSON.stringify({ at: new Date().toISOString(), tool: tool.name, error: e.message }));
        return ok(id, { content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

function authorized(req, pathToken) {
  const header = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1]?.trim();
  const given = Buffer.from(header || pathToken || "");
  const expected = Buffer.from(TOKEN);
  return TOKEN.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", ...headers });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const m = /^\/mcp(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (!m) {
    if (url.pathname === "/" && req.method === "GET") return send(res, 200, `ECLYPSE APEX MCP ${VERSION}\nPoint d'accès : /mcp (jeton requis)\nÉcriture : ${ALLOW_WRITE ? "activée" : "désactivée"}\n`);
    return send(res, 404, "Not found");
  }
  if (!authorized(req, m[1] ? decodeURIComponent(m[1]) : undefined)) return send(res, 401, { error: "invalid_token" });
  if (req.method !== "POST") return send(res, 405, "Method not allowed", { Allow: "POST" });
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1e6) return send(res, 413, "Payload too large");
    chunks.push(c);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return send(res, 400, fail(null, -32700, "Parse error"));
  }
  const answers = (await Promise.all((Array.isArray(body) ? body : [body]).map(rpc))).filter(Boolean);
  if (!answers.length) {
    res.writeHead(202);
    return res.end();
  }
  send(res, 200, Array.isArray(body) ? answers : answers[0]);
});

if (!TOKEN) console.error("MCP_TOKEN manquant : toutes les requêtes seront refusées.");
server.listen(PORT, () => console.log(`ECLYPSE APEX MCP ${VERSION} on :${PORT}, APEX ${APEX}, write ${ALLOW_WRITE ? `on (priority ${PRIORITY})` : "off"}${INFLUX ? ", InfluxDB on" : ""}`));
