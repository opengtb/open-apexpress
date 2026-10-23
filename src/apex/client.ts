import type { CreateOptions } from "../recipes/types";

export const API_BASE = "/api/rest/v2";
const CTZ = `${API_BASE}/services/containerization`;

export type ApexErrorKind = "auth" | "forbidden" | "policy" | "not-found" | "network" | "timeout" | "tls" | "http";

export class ApexError extends Error {
  constructor(
    public kind: ApexErrorKind,
    message: string,
    public status?: number,
    public body?: string,
  ) {
    super(message);
  }
}

export interface Exchange {
  method: string;
  path: string;
  status: number | "error";
  ms: number;
  request?: unknown;
  response?: string;
}

export interface ApexConfig {
  /** Host or IP, optionally with port (e.g. "192.168.1.2" or "192.168.1.2:8443"). */
  host: string;
  username: string;
  password: string;
  /** https by default; http is only used by the demo APEX. */
  scheme?: "https" | "http";
  timeoutMs?: number;
  onExchange?: (e: Exchange) => void;
}

export interface ContainerInfo {
  name: string;
  image?: string;
  /** Normalized lowercase state: running, exited, created, restarting, paused, dead… */
  state?: string;
  status?: string;
  /** Id of the image the container runs ("sha256:…", the digest of the image config). */
  imageId?: string;
  hostPorts: number[];
  raw: unknown;
}

export class ApexClient {
  readonly baseUrl: string;
  private auth: string;

  constructor(private config: ApexConfig) {
    const host = config.host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.baseUrl = `${config.scheme ?? "https"}://${host}`;
    this.auth = "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64");
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const started = performance.now();
    const log = (status: number | "error", response?: string) =>
      this.config.onExchange?.({ method, path, status, ms: Math.round(performance.now() - started), request: body, response });
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: this.auth,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs ?? this.config.timeoutMs ?? 20000),
        // ECLYPSE controllers use self-signed certificates.
        tls: { rejectUnauthorized: false },
      } as RequestInit);
    } catch (e) {
      const err = e as Error & { code?: string };
      log("error", err.message);
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        throw new ApexError("timeout", "timeout");
      }
      if (/cert|ssl|tls/i.test(`${err.code} ${err.message}`)) throw new ApexError("tls", err.message);
      throw new ApexError("network", err.message);
    }
    const text = await res.text();
    log(res.status, text.length > 4000 ? text.slice(0, 4000) + "…" : text);
    if (!res.ok) {
      const kind: ApexErrorKind =
        res.status === 401
          ? "auth"
          : /administrative policy|authorization denied|authz/i.test(text)
            ? "policy"
            : res.status === 403
              ? "forbidden"
              : res.status === 404
                ? "not-found"
                : "http";
      throw new ApexError(kind, extractMessage(text) || `HTTP ${res.status}`, res.status, text);
    }
    if (!text.trim()) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  // --- Platform -----------------------------------------------------------

  apiVersion() {
    return this.request("GET", "/api/rest");
  }

  platform() {
    return this.request<Record<string, unknown>>("GET", `${API_BASE}/services/platform`);
  }

  containerization() {
    return this.request<Record<string, unknown>>("GET", CTZ);
  }

  // --- Containers ----------------------------------------------------------

  async listContainers(): Promise<ContainerInfo[]> {
    return parseContainers(await this.request("GET", `${CTZ}/containers`));
  }

  async listImages(): Promise<string[]> {
    return parseImages(await this.request("GET", `${CTZ}/images`));
  }

  /** Image reference -> image id. */
  async listImageIds(): Promise<Record<string, string>> {
    return parseImageIds(await this.request("GET", `${CTZ}/images`));
  }

  async listVolumes(): Promise<string[]> {
    return parseNames(unwrap(await this.request("GET", `${CTZ}/volumes`), "volumes"));
  }

  pullImage(image: string) {
    // Pulling a large image can take a while: the call may only return once it is done.
    return this.request("POST", `${CTZ}/images/pull-image`, { image }, 15 * 60 * 1000);
  }

  createContainer(name: string, options: CreateOptions) {
    return this.request("POST", `${CTZ}/containers/create-container`, { name, options }, 60000);
  }

  startContainer(name: string) {
    return this.request("POST", `${CTZ}/containers/start`, { "container-name": name }, 60000);
  }

  stopContainer(name: string) {
    return this.request("POST", `${CTZ}/containers/stop`, { "container-name": name }, 60000);
  }

  deleteContainer(name: string) {
    return this.request("DELETE", `${CTZ}/containers/${encodeURIComponent(name)}`, undefined, 60000);
  }

  deleteVolume(name: string) {
    return this.request("DELETE", `${CTZ}/volumes/${encodeURIComponent(name)}`, undefined, 60000);
  }

  deleteImage(image: string) {
    return this.request("DELETE", `${CTZ}/images/${encodeURIComponent(image)}`, undefined, 60000);
  }
}

// ---------------------------------------------------------------------------
// Tolerant parsing: the exact response shapes of the APEX are not documented,
// so we accept arrays, maps keyed by name, and Docker Engine-like objects.
// ---------------------------------------------------------------------------

function extractMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    const m = j?.message ?? j?.error?.message ?? j?.error ?? j?.detail ?? j?.title;
    if (typeof m === "string") return m;
  } catch {
    /* not JSON */
  }
  return text.trim().slice(0, 300);
}

/** Unwrap { containers: {...} } style envelopes. */
export function unwrap(data: unknown, key: string): unknown {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    for (const k of [key, "items", "data", "results"]) {
      if (k in obj && obj[k] && typeof obj[k] === "object") return obj[k];
    }
  }
  return data;
}

function entries(data: unknown): [string | undefined, Record<string, unknown>][] {
  if (Array.isArray(data)) return data.filter(isObj).map((e) => [undefined, e]);
  if (isObj(data)) {
    return Object.entries(data).map(([k, v]) => [k, isObj(v) ? v : { value: v }]);
  }
  return [];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const found = Object.keys(obj).find((x) => x.toLowerCase() === k.toLowerCase());
    if (found !== undefined && obj[found] !== undefined && obj[found] !== null) return obj[found];
  }
  return undefined;
}

/** Depth-first search of a value under a key matching the regex. */
function deepFind(value: unknown, re: RegExp, depth = 0): unknown {
  if (depth > 5 || !value || typeof value !== "object") return undefined;
  for (const [k, v] of Object.entries(value)) {
    if (re.test(k) && (typeof v === "string" || typeof v === "number")) return v;
  }
  for (const v of Object.values(value)) {
    const found = deepFind(v, re, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** `docker ps` style text: "0.0.0.0:50050->80/tcp, :::50050->80/tcp". */
function collectPortText(value: unknown, out: Set<number>) {
  for (const s of Array.isArray(value) ? value : [value]) {
    if (typeof s !== "string") continue;
    for (const m of s.matchAll(/:(\d+)->\d+\/(?:tcp|udp|sctp)/g)) out.add(Number(m[1]));
  }
}

function deepCollectPorts(value: unknown, out: Set<number>, depth = 0) {
  if (depth > 6 || !value || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (/^(host-?port|hostport|public-?port|publicport)$/i.test(k)) {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) out.add(n);
    } else if (/ports?$/i.test(k) && (typeof v === "string" || (Array.isArray(v) && v.some((x) => typeof x === "string")))) {
      collectPortText(v, out);
    } else {
      deepCollectPorts(v, out, depth + 1);
    }
  }
}

export function parseContainers(data: unknown): ContainerInfo[] {
  const out: ContainerInfo[] = [];
  for (const [key, e] of entries(unwrap(data, "containers"))) {
    const names = pick(e, "Names");
    const name = String(
      pick(e, "key", "name", "container-name", "Name") ??
        (Array.isArray(names) ? String(names[0]).replace(/^\//, "") : undefined) ??
        key ??
        "",
    ).replace(/^\//, "");
    if (!name) continue;
    let state = pick(e, "state", "State");
    if (isObj(state)) state = pick(state, "Status", "status");
    if (state === undefined) state = deepFind(e, /^state$/i);
    const status = pick(e, "status", "Status");
    const image = pick(e, "image", "Image");
    const imageId = pick(e, "image-id", "ImageID", "imageId");
    const ports = new Set<number>();
    deepCollectPorts(e, ports);
    out.push({
      name,
      image: typeof image === "string" ? image : undefined,
      state: typeof state === "string" ? state.toLowerCase() : undefined,
      status: typeof status === "string" ? status : undefined,
      imageId: typeof imageId === "string" ? imageId : undefined,
      hostPorts: [...ports],
      raw: e,
    });
  }
  return out;
}

export function parseImages(data: unknown): string[] {
  const refs = new Set<string>();
  for (const [key, e] of entries(unwrap(data, "images"))) {
    if (key && key.includes(":")) refs.add(key);
    for (const k of ["key", "name", "image", "RepoTags", "repo-tags", "tags", "Tags", "value"]) {
      const v = pick(e, k);
      for (const s of Array.isArray(v) ? v : [v]) if (typeof s === "string" && s && !/^sha256:/.test(s)) refs.add(s);
    }
    if (key && !refs.size) refs.add(key);
  }
  return [...refs];
}

export function parseImageIds(data: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, e] of entries(unwrap(data, "images"))) {
    const id = pick(e, "id", "Id", "image-id");
    if (typeof id !== "string") continue;
    const refs = [key, ...[pick(e, "key", "name", "image"), pick(e, "RepoTags", "repo-tags", "tags")].flat()];
    for (const r of refs) if (typeof r === "string" && r && !/^sha256:/.test(r)) out[normalizeImage(r)] = id;
  }
  return out;
}

export function parseNames(data: unknown): string[] {
  const names: string[] = [];
  for (const [key, e] of entries(data)) {
    const n = pick(e, "key", "name", "Name") ?? key;
    if (typeof n === "string" && n) names.push(n);
  }
  return names;
}

/** Canonical form of an image reference: docker.io/library/ prefix removed, tag defaulting to latest. */
export function normalizeImage(ref: string): string {
  let r = ref.trim().replace(/^docker\.io\//, "").replace(/^library\//, "");
  const lastSegment = r.slice(r.lastIndexOf("/") + 1);
  if (!lastSegment.includes(":") && !r.includes("@")) r += ":latest";
  return r;
}

export function hasImage(images: string[], ref: string): boolean {
  const target = normalizeImage(ref);
  return images.some((i) => normalizeImage(i) === target);
}
