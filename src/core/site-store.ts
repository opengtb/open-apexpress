// What Open Apexpress deployed on each APEX, kept on this PC: the APEX does not give back the environment
// of a container, so this copy is what lets a container be recreated identically (updates).
// It holds the generated passwords: it stays in the user profile, never on the APEX.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CreateOptions } from "../recipes/types";

export interface DeployedContainer {
  recipeId: string;
  options: CreateOptions;
  savedAt: string;
}

interface SiteFile {
  host: string;
  containers: Record<string, DeployedContainer>;
}

export function dataDir(): string {
  return process.env.APEXPRESS_DATA_DIR ?? (process.env.APPDATA ? join(process.env.APPDATA, "Apexpress") : join(homedir(), ".apexpress"));
}

const siteFile = (host: string) => join(dataDir(), "sites", `${host.toLowerCase().replace(/[^a-z0-9.-]+/g, "_")}.json`);

export function loadSite(host: string): Record<string, DeployedContainer> {
  try {
    return (JSON.parse(readFileSync(siteFile(host), "utf8")) as SiteFile).containers ?? {};
  } catch {
    return {};
  }
}

export function saveDeployed(host: string, containers: { name: string; recipeId: string; options: CreateOptions }[]) {
  if (!containers.length) return;
  const current = loadSite(host);
  const savedAt = new Date().toISOString();
  for (const c of containers) current[c.name] = { recipeId: c.recipeId, options: c.options, savedAt };
  const file = siteFile(host);
  mkdirSync(join(dataDir(), "sites"), { recursive: true });
  writeFileSync(file, JSON.stringify({ host, containers: current } satisfies SiteFile, null, 2));
}
