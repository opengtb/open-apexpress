import type { CreateOptions, L10n } from "../recipes/types";

export type IssueLevel = "error" | "warning";

export interface Issue {
  level: IssueLevel;
  code: string;
  message: L10n;
  container?: string;
}

export const HOST_PORT_MIN = 50000;
export const HOST_PORT_MAX = 50999;
/** Host ports seen rejected by the OPA plugin in the field. */
const KNOWN_REJECTED_PORTS = new Set([50880]);
const NAME_RE = /^[a-z0-9][a-z0-9_.-]*$/;

const issue = (level: IssueLevel, code: string, fr: string, en: string): Issue => ({ level, code, message: { fr, en } });

/**
 * Lint create options against the rules the APEX OPA authorization plugin enforces,
 * as observed in the field. Errors are almost certainly rejected, warnings may be.
 */
export function lintContainer(name: string, options: CreateOptions): Issue[] {
  const issues: Issue[] = [];
  if (!NAME_RE.test(name)) {
    issues.push(
      issue(
        "error",
        "name",
        `Nom « ${name} » invalide : minuscules, chiffres, « - », « _ » ou « . » uniquement, sans espace.`,
        `Invalid name "${name}": lowercase letters, digits, "-", "_" or "." only, no spaces.`,
      ),
    );
  }
  if (!options || typeof options !== "object" || typeof options.Image !== "string" || !options.Image.trim()) {
    issues.push(issue("error", "image", "Champ « Image » manquant.", 'Missing "Image" field.'));
    return issues;
  }
  const tag = imageTag(options.Image);
  if (tag === "latest") {
    issues.push(
      issue(
        "warning",
        "latest",
        `Image « ${options.Image} » en tag latest : préférez une version fixe (certains latest ne sont pas ARM64).`,
        `Image "${options.Image}" uses the latest tag: prefer a fixed version (some latest tags are not ARM64).`,
      ),
    );
  }

  const host = options.HostConfig ?? {};
  const exposed = new Set(Object.keys(options.ExposedPorts ?? {}));
  for (const [containerPort, bindings] of Object.entries(host.PortBindings ?? {})) {
    if (!exposed.has(containerPort)) {
      issues.push(
        issue(
          "error",
          "exposed",
          `Le port ${containerPort} est publié mais absent de ExposedPorts (obligatoire pour l'OPA).`,
          `Port ${containerPort} is published but missing from ExposedPorts (required by the OPA).`,
        ),
      );
    }
    for (const b of bindings ?? []) {
      const hp = b?.HostPort;
      if (hp === undefined || hp === "") continue; // empty = random port, accepted
      const port = Number(hp);
      if (!Number.isInteger(port) || port < HOST_PORT_MIN || port > HOST_PORT_MAX) {
        issues.push(
          issue(
            "error",
            "host-port",
            `Port hôte ${hp} hors de la plage ${HOST_PORT_MIN}-${HOST_PORT_MAX} acceptée par l'OPA.`,
            `Host port ${hp} is outside the ${HOST_PORT_MIN}-${HOST_PORT_MAX} range accepted by the OPA.`,
          ),
        );
      } else if (KNOWN_REJECTED_PORTS.has(port)) {
        issues.push(
          issue("warning", "host-port-known", `Le port ${port} a déjà été refusé par l'OPA sur le terrain.`, `Port ${port} has already been rejected by the OPA in the field.`),
        );
      }
    }
  }
  if (Array.isArray(host.Binds) && host.Binds.length) {
    issues.push(issue("error", "binds", "Binds est refusé : utilisez Mounts avec des volumes nommés.", "Binds are rejected: use Mounts with named volumes."));
  }
  for (const m of host.Mounts ?? []) {
    if (m.Type !== "volume") {
      issues.push(
        issue("error", "mount-type", `Montage « ${m.Target} » de type ${m.Type} : seuls les volumes nommés passent.`, `Mount "${m.Target}" of type ${m.Type}: only named volumes are accepted.`),
      );
    }
  }
  if (host.Privileged === true) {
    issues.push(issue("error", "privileged", "Les conteneurs privilégiés sont refusés.", "Privileged containers are rejected."));
  }
  if (Array.isArray(host.Devices) && host.Devices.length) {
    issues.push(issue("error", "devices", "Pas d'accès aux périphériques (USB, série) sur l'APEX.", "No device access (USB, serial) on the APEX."));
  }
  if (Array.isArray(host.CapAdd) && host.CapAdd.length) {
    issues.push(issue("warning", "cap-add", "CapAdd sera très probablement refusé par l'OPA.", "CapAdd will most likely be rejected by the OPA."));
  }
  if (host.NetworkMode === "host") {
    issues.push(issue("warning", "network-host", "Le réseau « host » sera très probablement refusé.", 'The "host" network will most likely be rejected.'));
  }
  if (host.CpusetCpus !== "0") {
    issues.push(
      issue(
        "warning",
        "cpuset",
        'Ajoutez "CpusetCpus": "0" dans HostConfig : la régulation garde les autres cœurs.',
        'Add "CpusetCpus": "0" to HostConfig: the control logic keeps the other cores.',
      ),
    );
  }
  return issues.map((i) => ({ ...i, container: name }));
}

/** Tag of an image reference ("latest" when omitted, undefined for digests). */
export function imageTag(image: string): string | undefined {
  if (image.includes("@")) return undefined;
  const last = image.slice(image.lastIndexOf("/") + 1);
  return last.includes(":") ? last.slice(last.indexOf(":") + 1) : "latest";
}

/** Host ports published by create options. */
export function hostPorts(options: CreateOptions): { port: number; containerPort: string }[] {
  const out: { port: number; containerPort: string }[] = [];
  for (const [containerPort, bindings] of Object.entries(options.HostConfig?.PortBindings ?? {})) {
    for (const b of bindings ?? []) if (b?.HostPort) out.push({ port: Number(b.HostPort), containerPort });
  }
  return out;
}
