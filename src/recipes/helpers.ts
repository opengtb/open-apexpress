import type { CreateOptions, L10n, Param, ParamValue } from "./types";

export const t = (fr: string, en: string): L10n => ({ fr, en });

export interface PortMap {
  /** Port inside the container, e.g. "1883/tcp". */
  container: string;
  host: number | string;
}

export interface VolumeMap {
  volume: string;
  target: string;
}

export interface ContainerInput {
  image: string;
  ports?: PortMap[];
  volumes?: VolumeMap[];
  env?: Record<string, ParamValue | undefined>;
  cmd?: string[];
  entrypoint?: string[];
  /** "unless-stopped" by default, "no" for one-shot containers. */
  restart?: "unless-stopped" | "no" | "always" | "on-failure";
  /** Extra container ports exposed without a host binding. */
  exposeOnly?: string[];
}

/**
 * Build Docker create options following the rules the APEX OPA plugin accepts:
 * ExposedPorts for every published port, Mounts (never Binds), CpusetCpus "0".
 */
export function container(input: ContainerInput): CreateOptions {
  const options: CreateOptions = { Image: input.image };
  if (input.entrypoint) options.Entrypoint = input.entrypoint;
  if (input.cmd) options.Cmd = input.cmd;

  const env = Object.entries(input.env ?? {})
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  if (env.length) options.Env = env;

  const exposed = [...(input.ports ?? []).map((p) => p.container), ...(input.exposeOnly ?? [])];
  if (exposed.length) options.ExposedPorts = Object.fromEntries(exposed.map((p) => [p, {}]));

  const restart = input.restart ?? "unless-stopped";
  options.HostConfig = {
    CpusetCpus: "0",
    RestartPolicy: { Name: restart, MaximumRetryCount: 0 },
  };
  if (input.ports?.length) {
    options.HostConfig.PortBindings = Object.fromEntries(
      input.ports.map((p) => [p.container, [{ HostPort: String(p.host) }]]),
    );
  }
  if (input.volumes?.length) {
    options.HostConfig.Mounts = input.volumes.map((v) => ({
      Target: v.target,
      Source: v.volume,
      Type: "volume" as const,
      ReadOnly: false,
      Consistency: "default",
    }));
  }
  return options;
}

/** POSIX shell single-quoting. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Shell snippet writing a file from a single-quoted string (no variable expansion inside).
 * Unlike a heredoc, it is a plain command that can be chained with `&&` on the same line.
 */
export function writeFile(path: string, content: string): string {
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  return `mkdir -p '${dir}' && printf '%s\\n' ${shellQuote(content.replace(/\n$/, ""))} > '${path}'`;
}

/** Same as writeFile, but only when the file does not exist yet (keeps user edits and generated keys). */
export function writeFileOnce(path: string, content: string): string {
  return `if [ ! -f '${path}' ]; then ${writeFile(path, content)}\nfi`;
}

export const str = (v: ParamValue | undefined): string => (v === undefined ? "" : String(v));
export const num = (v: ParamValue | undefined): number => Number(v);
export const bool = (v: ParamValue | undefined): boolean => v === true || v === "true";

/** TOML/YAML-safe double-quoted string. */
export const quote = (v: ParamValue | undefined): string => JSON.stringify(str(v));

// Reusable parameters ------------------------------------------------------

export const hostPortParam = (port: number, label = t("Port sur l'APEX", "Port on the APEX")): Param => ({
  id: "hostPort",
  label,
  help: t(
    "Port publié sur l'APEX. L'OPA n'accepte que la plage 50000-50500.",
    "Port published on the APEX. The OPA plugin only accepts the 50000-50500 range.",
  ),
  type: "number",
  default: port,
  required: true,
});

export const imageParam = (image: string): Param => ({
  id: "image",
  label: t("Image Docker", "Docker image"),
  help: t(
    "Image et tag. Gardez un tag de version fixe, testé en ARM64.",
    "Image and tag. Keep a fixed version tag, tested on ARM64.",
  ),
  type: "text",
  default: image,
  required: true,
  advanced: true,
});

export const nameParam = (name: string): Param => ({
  id: "name",
  label: t("Nom du conteneur", "Container name"),
  help: t("En minuscules, sans espace.", "Lowercase, no spaces."),
  type: "text",
  default: name,
  required: true,
  advanced: true,
});

export const timezoneParam: Param = {
  id: "tz",
  label: t("Fuseau horaire", "Time zone"),
  type: "text",
  default: "Europe/Paris",
  advanced: true,
};

/** URL of an MQTT broker deployed by the mosquitto recipe. */
export function mosquittoUrl(apexIp: string, all: Record<string, Record<string, ParamValue>>, scheme = "mqtt"): string {
  const port = all.mosquitto?.hostPort ?? 50083;
  return `${scheme}://${apexIp}:${port}`;
}

/** Credentials of the mosquitto recipe when authentication is enabled. */
export function mosquittoAuth(all: Record<string, Record<string, ParamValue>>): { user: string; password: string } | null {
  const m = all.mosquitto;
  if (!m || !bool(m.auth)) return null;
  return { user: str(m.user), password: str(m.password) };
}
