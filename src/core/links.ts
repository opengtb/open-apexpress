import type { ContainerInfo } from "../apex/client";
import { RECIPES } from "../recipes/catalog";
import type { L10n } from "../recipes/types";
import { resolveValues } from "./planner";

export interface ContainerLink {
  label: L10n;
  url: string;
}

interface CatalogEntry {
  names: string[];
  repos: string[];
  links: { label: L10n; url: string; port: number | null }[];
}

const repo = (image = "") => image.replace(/@.*$/, "").replace(/:[^/]*$/, "");
/** Images used by many things: a container is only recognized by its name with them. */
const GENERIC = new Set(["nginx", "alpine", "busybox", "postgres", "redis"]);
const linkPort = (url: string): number | null => {
  const m = /^[a-z]+:\/\/[^/:]+:(\d+)/i.exec(url);
  return m ? Number(m[1]) : null;
};

let cache: { apexIp: string; entries: CatalogEntry[] } | undefined;

/** Default containers and links of every recipe, built for this APEX IP. */
function catalog(apexIp: string): CatalogEntry[] {
  if (cache?.apexIp === apexIp) return cache.entries;
  const all = Object.fromEntries(RECIPES.map((r) => [r.id, resolveValues(r)]));
  const entries = RECIPES.flatMap((recipe) => {
    try {
      const built = recipe.build({ apexIp, values: all[recipe.id]!, all });
      return [
        {
          names: built.containers.map((c) => c.name),
          repos: [...new Set(built.containers.map((c) => repo(c.options.Image)))].filter((x) => !GENERIC.has(x)),
          links: built.links.map((l) => ({ ...l, port: linkPort(l.url) })),
        },
      ];
    } catch {
      return [];
    }
  });
  cache = { apexIp, entries };
  return entries;
}

function recognize(apexIp: string, c: ContainerInfo): CatalogEntry | undefined {
  const entries = catalog(apexIp);
  return entries.find((e) => e.names.includes(c.name)) ?? entries.find((e) => !!c.image && e.repos.includes(repo(c.image)));
}

/**
 * Web links of a container on the APEX, recognized by its name or image (same rules as the portal):
 * the recipe links on the ports it really publishes, or its only web link moved to its only port.
 */
export function containerLinks(apexIp: string, c: ContainerInfo): ContainerLink[] {
  const r = recognize(apexIp, c);
  if (!r) return [];
  const web = r.links.filter((l) => /^https?:/.test(l.url));
  // Recipes with several containers (ChirpStack): only the links on this container's ports.
  if (!c.hostPorts.length) return r.names.length === 1 ? web.map(({ label, url }) => ({ label, url })) : [];
  const out = web.filter((l) => l.port !== null && c.hostPorts.includes(l.port));
  if (!out.length && web.length === 1 && c.hostPorts.length === 1 && r.names.length === 1) {
    return [{ label: web[0]!.label, url: web[0]!.url.replace(/:\d+/, `:${c.hostPorts[0]}`) }];
  }
  return out.map(({ label, url }) => ({ label, url }));
}

/** Volumes mounted by a container: "type=volume,src=…,dst=…" strings (real APEX) or { source } objects. */
export function mountedVolumes(raw: unknown): string[] {
  const mounts = raw && typeof raw === "object" ? (raw as Record<string, unknown>).mounts ?? (raw as Record<string, unknown>).Mounts : undefined;
  if (!Array.isArray(mounts)) return [];
  return mounts.flatMap((m) => {
    if (typeof m === "string") return /type=volume/.test(m) ? (/src=([^,]+)/.exec(m)?.slice(1) ?? []) : [];
    const src = m && typeof m === "object" ? ((m as any).source ?? (m as any).Source ?? (m as any).Name) : undefined;
    return typeof src === "string" ? [src] : [];
  });
}

/** Ports of the container that the recipe documents as non-web (MQTT, WebSocket…), with their label. */
export function containerOtherPorts(apexIp: string, c: ContainerInfo): Record<number, L10n> {
  const r = recognize(apexIp, c);
  const out: Record<number, L10n> = {};
  for (const l of r?.links ?? []) if (l.port !== null && !/^https?:/.test(l.url) && c.hostPorts.includes(l.port)) out[l.port] = l.label;
  return out;
}
