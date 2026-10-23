// Image updates. The APEX lists each image with its id, which is the digest of its config: the same
// value the registry gives for the arm64 manifest. So a tag republished on Docker Hub (eclipse-mosquitto:2,
// tailscale:stable…) is detected by comparing both, and newer version tags come from the Docker Hub API.
import type { ContainerInfo } from "../apex/client";
import { lintContainer } from "../apex/opa";
import { RECIPES } from "../recipes/catalog";
import type { ContainerSpec, CreateOptions, L10n } from "../recipes/types";
import { resolveValues } from "./planner";

export interface UpdateInfo {
  /** Same tag, newer build on Docker Hub. */
  rebuilt?: boolean;
  /** Newest tag of the same shape and major version (safe update). */
  newer?: string;
  /** Newest tag of a higher major version: may need a migration, shown as information only. */
  major?: string;
  error?: string;
}

interface Ref {
  repo: string;
  tag: string;
}

/** Docker Hub reference ("library/" added for official images); undefined for other registries or digests. */
export function hubRef(image: string): Ref | undefined {
  if (image.includes("@")) return undefined;
  let name = image.replace(/^docker\.io\//, "");
  const first = name.split("/")[0]!;
  if (name.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")) return undefined;
  const slash = name.lastIndexOf("/");
  const colon = name.lastIndexOf(":");
  const tag = colon > slash ? name.slice(colon + 1) : "latest";
  if (colon > slash) name = name.slice(0, colon);
  return { repo: name.includes("/") ? name : `library/${name}`, tag };
}

interface Version {
  prefix: string;
  nums: number[];
  suffix: string;
}

export function parseVersion(tag: string): Version | undefined {
  const m = /^(v?)(\d+(?:\.\d+)*)(.*)$/.exec(tag);
  if (!m) return undefined;
  return { prefix: m[1]!, nums: m[2]!.split(".").map(Number), suffix: m[3]! };
}

const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

/** Tags with the same shape (prefix, number of parts, suffix) and higher: the newest of the same major, and of a higher one. */
export function pickNewer(current: string, tags: { name: string; arm64: boolean }[]): Pick<UpdateInfo, "newer" | "major"> {
  const v = parseVersion(current);
  if (!v) return {};
  let newer: Version | undefined;
  let major: Version | undefined;
  for (const t of tags) {
    const c = parseVersion(t.name);
    if (!t.arm64 || !c || c.prefix !== v.prefix || c.suffix !== v.suffix || c.nums.length !== v.nums.length) continue;
    if (compare(c.nums, v.nums) <= 0) continue;
    if (c.nums[0] === v.nums[0]) {
      if (!newer || compare(c.nums, newer.nums) > 0) newer = c;
    } else if (!major || compare(c.nums, major.nums) > 0) major = c;
  }
  const str = (x?: Version) => (x ? `${x.prefix}${x.nums.join(".")}${x.suffix}` : undefined);
  return { newer: str(newer), major: str(major) };
}

/** A full version (2.14.1) is practically never republished: only moving tags (2, stable, alpine) are compared by digest. */
const isMovingTag = (tag: string) => (parseVersion(tag)?.nums.length ?? 0) < 3;

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.replace(/\?.*$/, "")}`);
  return res.json();
}

/** Config digest of the arm64 image of a tag (= image id on the APEX). */
export async function armConfigDigest(ref: Ref): Promise<string | undefined> {
  const { token } = await getJson(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${ref.repo}:pull`);
  const headers = { Authorization: `Bearer ${token}`, Accept: ACCEPT };
  let manifest = await getJson(`https://registry-1.docker.io/v2/${ref.repo}/manifests/${ref.tag}`, headers);
  if (Array.isArray(manifest.manifests)) {
    const arm = manifest.manifests.find((m: any) => m.platform?.architecture === "arm64" && m.platform?.os === "linux");
    if (!arm) return undefined;
    manifest = await getJson(`https://registry-1.docker.io/v2/${ref.repo}/manifests/${arm.digest}`, headers);
  }
  return manifest.config?.digest;
}

async function hubTags(repo: string): Promise<{ name: string; arm64: boolean }[]> {
  const data = await getJson(`https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100&ordering=last_updated`);
  return (data.results ?? []).map((t: any) => ({
    name: String(t.name),
    arm64: (t.images ?? []).some((i: any) => i.architecture === "arm64" && (i.os ?? "linux") === "linux"),
  }));
}

const cache = new Map<string, { at: number; info: UpdateInfo }>();
const CACHE_MS = 6 * 3600_000;

/** Update check of one image, given the id of the image the APEX runs. Cached: registry pulls are rate-limited. */
export async function checkImage(image: string, currentId?: string, fresh = false): Promise<UpdateInfo> {
  const key = `${image}|${currentId ?? ""}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.info;
  const ref = hubRef(image);
  if (!ref) return {};
  let info: UpdateInfo;
  try {
    const [tags, digest] = await Promise.all([
      parseVersion(ref.tag) ? hubTags(ref.repo) : Promise.resolve([]),
      currentId && isMovingTag(ref.tag) ? armConfigDigest(ref) : Promise.resolve(undefined),
    ]);
    info = { ...pickNewer(ref.tag, tags), rebuilt: !!digest && !!currentId && digest !== currentId };
  } catch (e) {
    info = { error: (e as Error).message };
  }
  cache.set(key, { at: Date.now(), info });
  return info;
}

/** Same image reference with another tag. */
export function withTag(image: string, tag: string): string {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return `${colon > slash ? image.slice(0, colon) : image}:${tag}`;
}

// --- Create options of a container already on the APEX ------------------------------------------------

/** Default container specs of the catalog, by container name. */
function catalogSpecs(): Map<string, { recipeId: string; spec: ContainerSpec }> {
  const all = Object.fromEntries(RECIPES.map((r) => [r.id, resolveValues(r)]));
  const map = new Map<string, { recipeId: string; spec: ContainerSpec }>();
  for (const r of RECIPES) {
    try {
      for (const spec of r.build({ apexIp: "0.0.0.0", values: all[r.id]!, all }).containers) map.set(spec.name, { recipeId: r.id, spec });
    } catch {
      /* needs required values */
    }
  }
  return map;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);
const field = (raw: unknown, ...keys: string[]): unknown => {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  for (const k of keys) {
    const found = Object.keys(obj).find((x) => x.toLowerCase() === k.toLowerCase());
    if (found) return obj[found];
  }
  return undefined;
};

export type RebuildResult = { ok: true; recipeId: string; options: CreateOptions } | { ok: false; reason: L10n };

/**
 * Create options rebuilt from what the APEX lists (image, "0.0.0.0:50083->1883/tcp" ports,
 * "type=volume,src=…,dst=…" mounts, flattened command). The environment is not listed: only
 * catalog containers that use none can be rebuilt this way.
 */
export function rebuildFromApex(info: ContainerInfo): RebuildResult {
  const known = catalogSpecs().get(info.name);
  const no = (fr: string, en: string): RebuildResult => ({ ok: false, reason: { fr, en } });
  const reinstall = no(
    "Configuration inconnue de ce PC. Open Apexpress garde la configuration de ce qu'il installe sur le PC qui l'a installé : l'APEX ne rend pas les variables d'environnement. Installé depuis un autre PC ou avant cette fonction : réinstallez ce service une fois depuis le catalogue (« Le remplacer »), il pourra ensuite être mis à jour d'un clic depuis ce PC.",
    'Configuration unknown to this PC. Open Apexpress keeps the configuration of what it installs on the PC that installed it: the APEX does not give back environment variables. Installed from another PC or before this feature: reinstall this service once from the catalog ("Replace it"), it can then be updated in one click from this PC.',
  );
  if (!known || known.spec.oneShot) return reinstall;
  const base = known.spec.options;
  if (base.Env?.length) return reinstall;

  const options: CreateOptions = { Image: info.image ?? base.Image };
  const ports: Record<string, { HostPort: string }[]> = {};
  for (const p of strings(field(info.raw, "port-bindings", "ports"))) {
    for (const m of p.matchAll(/:(\d+)->(\d+\/(?:tcp|udp|sctp))/g)) ports[m[2]!] = [{ HostPort: m[1]! }];
  }
  const mounts = strings(field(info.raw, "mounts")).flatMap((s) => {
    const kv = Object.fromEntries(s.split(",").map((x) => x.split("=") as [string, string]));
    return kv.type === "volume" && kv.src && kv.dst ? [{ Target: kv.dst, Source: kv.src, Type: "volume" as const, ReadOnly: false, Consistency: "default" }] : [];
  });
  const command = field(info.raw, "command");
  if (typeof command !== "string") return reinstall;

  if (base.Entrypoint?.join(" ") === "sh -c" || (base.Cmd?.[0] === "sh" && base.Cmd[1] === "-c")) {
    const at = command.indexOf("sh -c '");
    if (at < 0 || !command.endsWith("'")) return reinstall;
    const script = command.slice(at + 7, -1);
    if (base.Entrypoint) {
      options.Entrypoint = ["sh", "-c"];
      options.Cmd = [script];
    } else options.Cmd = ["sh", "-c", script];
  } else if (base.Cmd?.length) {
    const tokens = command.split(/\s+/);
    const at = tokens.indexOf(base.Cmd[0]!);
    if (at < 0 || tokens.slice(at).some((t) => /['"\\]/.test(t))) return reinstall;
    options.Cmd = tokens.slice(at);
  }
  if (Object.keys(ports).length) options.ExposedPorts = Object.fromEntries(Object.keys(ports).map((p) => [p, {}]));
  options.HostConfig = {
    CpusetCpus: "0",
    RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
    ...(Object.keys(ports).length ? { PortBindings: ports } : {}),
    ...(mounts.length ? { Mounts: mounts } : {}),
  };
  if (lintContainer(info.name, options).some((i) => i.level === "error")) return reinstall;
  return { ok: true, recipeId: known.recipeId, options };
}
