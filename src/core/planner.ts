import { hostPorts, lintContainer, type Issue } from "../apex/opa";
import type { ContainerInfo } from "../apex/client";
import { fillPortal } from "./portal";
import { RECIPES, recipeById } from "../recipes/catalog";
import type { ContainerSpec, Credential, L10n, ParamValue, Recipe, ServiceLink } from "../recipes/types";

export type ExistingPolicy = "keep" | "replace";

export interface PlanRequest {
  /** Selected recipes with the values entered by the user (missing values use defaults). */
  selection: Record<string, Record<string, ParamValue>>;
  apexIp: string;
  /** What to do with a container that already exists on the APEX. */
  onExisting?: ExistingPolicy;
  existing?: { containers: ContainerInfo[] };
}

export type ContainerAction = "create" | "replace" | "keep";

export interface PlannedContainer extends ContainerSpec {
  recipeId: string;
  action: ContainerAction;
  issues: Issue[];
  /** Image update: the new image is pulled before the old container is removed, the old image is deleted after. */
  update?: { previousImage: string; previousId?: string };
}

export interface PlannedRecipe {
  id: string;
  name: string;
  autoAdded: boolean;
  values: Record<string, ParamValue>;
  links: ServiceLink[];
  credentials: Credential[];
  notes: L10n[];
  containers: PlannedContainer[];
}

export interface Plan {
  apexIp: string;
  recipes: PlannedRecipe[];
  /** Containers in deployment order. */
  containers: PlannedContainer[];
  issues: Issue[];
  ramMb: number;
  ok: boolean;
}

const ALNUM = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomSecret(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALNUM[b % ALNUM.length]).join("");
}

/** Default values merged with user values, secrets generated when empty. */
export function resolveValues(recipe: Recipe, input: Record<string, ParamValue> = {}): Record<string, ParamValue> {
  const values: Record<string, ParamValue> = {};
  for (const p of recipe.params) {
    let v = input[p.id];
    if (v === undefined || v === null || v === "") v = p.default ?? "";
    if ((v === "" || v === undefined) && p.generate) v = randomSecret(p.generate === "token" ? 40 : 16);
    if (p.type === "number" && v !== "") v = Number(v);
    if (p.type === "boolean") v = v === true || v === "true";
    values[p.id] = v;
  }
  return values;
}

/** Selected recipes plus their dependencies, in dependency order. */
export function resolveOrder(selected: string[]): { id: string; autoAdded: boolean }[] {
  const wanted = new Set<string>();
  const visit = (id: string) => {
    if (wanted.has(id)) return;
    const r = recipeById(id);
    if (!r) return;
    for (const dep of r.requires ?? []) visit(dep);
    wanted.add(id);
  };
  selected.forEach(visit);
  // Catalog order already lists dependencies first; keep it for a predictable plan.
  const ordered = RECIPES.filter((r) => wanted.has(r.id)).map((r) => r.id);
  const deps = (id: string): string[] => recipeById(id)?.requires ?? [];
  const placed: string[] = [];
  const place = (id: string) => {
    if (placed.includes(id)) return;
    deps(id).forEach(place);
    placed.push(id);
  };
  ordered.forEach(place);
  // The portal lists every other service: always last.
  const portalIdx = placed.indexOf("portal");
  if (portalIdx >= 0) placed.push(...placed.splice(portalIdx, 1));
  return placed.map((id) => ({ id, autoAdded: !selected.includes(id) }));
}

const issue = (level: Issue["level"], code: string, fr: string, en: string, containerName?: string): Issue => ({
  level,
  code,
  message: { fr, en },
  container: containerName,
});

export function buildPlan(req: PlanRequest): Plan {
  const apexIp = req.apexIp.trim().replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
  const issues: Issue[] = [];
  const existing = new Map((req.existing?.containers ?? []).map((c) => [c.name, c]));
  const order = resolveOrder(Object.keys(req.selection));
  const all: Record<string, Record<string, ParamValue>> = {};
  for (const { id } of order) all[id] = resolveValues(recipeById(id)!, req.selection[id]);

  const policy = req.onExisting ?? "keep";
  const recipes: PlannedRecipe[] = [];

  for (const { id, autoAdded } of order) {
    const recipe = recipeById(id)!;
    const values = all[id]!;
    for (const p of recipe.params) {
      if (p.required && (values[p.id] === "" || values[p.id] === undefined)) {
        issues.push(
          issue("error", "required", `${recipe.name} : « ${p.label.fr} » est obligatoire.`, `${recipe.name}: "${p.label.en}" is required.`),
        );
      }
    }
    let built;
    try {
      built = recipe.build({ apexIp, values, all });
    } catch (e) {
      issues.push(issue("error", "build", `${recipe.name} : ${(e as Error).message}`, `${recipe.name}: ${(e as Error).message}`));
      continue;
    }
    recipes.push({
      id,
      name: recipe.name,
      autoAdded,
      values,
      links: built.links,
      credentials: built.credentials,
      notes: built.notes,
      containers: built.containers.map((c) => {
        const found = existing.get(c.name);
        // The portal is stateless and its page must list the current services: always recreate it.
        const alwaysReplace = c.oneShot || id === "portal";
        const action: ContainerAction = alwaysReplace ? (found ? "replace" : "create") : found ? (policy === "replace" ? "replace" : "keep") : "create";
        return { ...c, recipeId: id, action, issues: lintContainer(c.name, c.options) };
      }),
    });
    // A kept service still runs with the settings of its first install: the passwords and tokens
    // generated now are not applied, showing them would hand out credentials that do not work.
    const planned = recipes.at(-1)!;
    if (planned.containers.length && planned.containers.every((c) => c.action === "keep") && planned.credentials.length) {
      planned.credentials = [];
      planned.notes.unshift({
        fr: "Service conservé tel quel : ses identifiants et jetons restent ceux de sa première installation. Pour appliquer de nouveaux réglages, réinstallez-le avec « Le remplacer ».",
        en: 'Service kept as is: its credentials and tokens are still those of its first install. To apply new settings, reinstall it with "Replace it".',
      });
    }
  }

  const portal = recipes.find((r) => r.id === "portal");
  if (portal?.containers[0]) fillPortal(apexIp, portal, recipes, all.portal!, req.existing?.containers ?? []);

  // Cross-container checks: names and host ports must be unique on the APEX.
  const containers = recipes.flatMap((r) => r.containers);
  const names = new Map<string, number>();
  const ports = new Map<number, string>();
  for (const c of containers) {
    names.set(c.name, (names.get(c.name) ?? 0) + 1);
    for (const { port } of hostPorts(c.options)) {
      const other = ports.get(port);
      if (other && other !== c.name) {
        c.issues.push(
          issue("error", "port-conflict", `Le port ${port} est utilisé à la fois par ${other} et ${c.name}.`, `Port ${port} is used by both ${other} and ${c.name}.`, c.name),
        );
      }
      ports.set(port, c.name);
    }
  }
  for (const [name, count] of names) {
    if (count > 1) issues.push(issue("error", "duplicate-name", `Le nom de conteneur ${name} est utilisé ${count} fois.`, `Container name ${name} is used ${count} times.`, name));
  }
  for (const c of containers) {
    if (c.action === "keep") continue;
    for (const { port } of hostPorts(c.options)) {
      const owner = [...existing.values()].find((e) => e.name !== c.name && e.hostPorts.includes(port));
      if (owner) {
        c.issues.push(
          issue("error", "port-taken", `Le port ${port} est déjà utilisé sur l'APEX par ${owner.name}.`, `Port ${port} is already used on the APEX by ${owner.name}.`, c.name),
        );
      }
    }
    if (c.action === "replace" && !c.oneShot) {
      c.issues.push(
        issue("warning", "replace", `${c.name} existe déjà : il sera supprimé puis recréé (ses volumes sont conservés).`, `${c.name} already exists: it will be deleted and recreated (its volumes are kept).`, c.name),
      );
    }
  }
  for (const c of containers) {
    if (c.action === "keep") {
      c.issues = [
        issue("warning", "keep", `${c.name} existe déjà sur l'APEX : il est conservé tel quel.`, `${c.name} already exists on the APEX: it is kept as is.`, c.name),
      ];
    }
  }

  // The MQTT Web client talks to Mosquitto over WebSocket: a broker installed before that option has no such port.
  const mosquitto = recipes.find((r) => r.id === "mosquitto")?.containers[0];
  const kept = mosquitto?.action === "keep" ? existing.get(mosquitto.name) : undefined;
  if (all.mqttweb && kept?.hostPorts.length && !kept.hostPorts.includes(Number(all.mosquitto?.wsPort))) {
    issues.push(
      issue(
        "warning",
        "mosquitto-ws",
        `Le Mosquitto déjà présent n'écoute pas en WebSocket (port ${all.mosquitto?.wsPort}) : le client MQTT Web ne pourra pas s'y connecter. Choisissez « Le remplacer » pour le réinstaller (messages retenus conservés).`,
        `The existing Mosquitto does not listen over WebSocket (port ${all.mosquitto?.wsPort}): the MQTT Web client will not be able to connect. Choose "Replace it" to reinstall it (retained messages are kept).`,
        mosquitto!.name,
      ),
    );
  }

  const ramMb = recipes
    .filter((r) => r.containers.some((c) => c.action !== "keep"))
    .reduce((sum, r) => sum + (recipeById(r.id)?.ramMb ?? 0), 0);
  const allIssues = [...issues, ...containers.flatMap((c) => c.issues)];
  return {
    apexIp,
    recipes,
    containers,
    issues: allIssues,
    ramMb,
    ok: !allIssues.some((i) => i.level === "error") && containers.length > 0,
  };
}
