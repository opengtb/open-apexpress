/** Text available in French and English. */
export type L10n = { fr: string; en: string };
export type Lang = keyof L10n;

export type Category = "messaging" | "iot" | "automation" | "data" | "remote" | "tools";

/** How much field experience we have with a recipe on a real APEX. */
// "experimental" is shown as "To test": not validated on a real APEX with Open Apexpress yet.
export type RecipeStatus = "validated" | "experimental";

export type ParamValue = string | number | boolean;

export interface ParamOption {
  value: string;
  label: L10n;
}

export interface Param {
  id: string;
  label: L10n;
  help?: L10n;
  type: "text" | "password" | "number" | "select" | "boolean" | "textarea";
  default?: ParamValue;
  /** Generated when left empty (passwords, tokens). */
  generate?: "password" | "token";
  options?: ParamOption[];
  required?: boolean;
  /** Hidden behind "advanced options" in the UI. */
  advanced?: boolean;
  placeholder?: string;
}

/** Subset of the Docker Engine create options accepted by the APEX. */
export interface CreateOptions {
  Image: string;
  Cmd?: string[];
  Entrypoint?: string[];
  Env?: string[];
  ExposedPorts?: Record<string, Record<string, never>>;
  HostConfig?: {
    CpusetCpus?: string;
    RestartPolicy?: { Name: string; MaximumRetryCount?: number };
    PortBindings?: Record<string, { HostPort: string }[]>;
    Mounts?: { Target: string; Source: string; Type: "volume"; ReadOnly: boolean; Consistency: string }[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ContainerSpec {
  /** Container name on the APEX (lowercase). */
  name: string;
  options: CreateOptions;
  /** One-shot container: wait until it exits, then optionally delete it. */
  oneShot?: { removeAfter: boolean; timeoutSec?: number };
  description?: L10n;
}

export interface ServiceLink {
  label: L10n;
  url: string;
}

export interface Credential {
  label: L10n;
  value: string;
}

export interface BuildResult {
  containers: ContainerSpec[];
  links: ServiceLink[];
  credentials: Credential[];
  notes: L10n[];
}

export interface BuildContext {
  /** IP address of the APEX as seen by the containers (for IP_APEX:port communication). */
  apexIp: string;
  /** Resolved parameter values of this recipe. */
  values: Record<string, ParamValue>;
  /** Resolved parameter values of every recipe in the plan (dependencies included). */
  all: Record<string, Record<string, ParamValue>>;
}

export interface Recipe {
  id: string;
  name: string;
  category: Category;
  /** Two-letter badge and color used as a logo in the UI. */
  badge: string;
  color: string;
  status: RecipeStatus;
  summary: L10n;
  description: L10n;
  /** Rough memory footprint in MB, for the RAM budget gauge. */
  ramMb: number;
  /** Recipes that must be deployed (or already present) before this one. */
  requires?: string[];
  homepage?: string;
  /** Field-tested troubleshooting tips, shown in the settings and after the install. */
  troubleshooting?: L10n[];
  params: Param[];
  build(ctx: BuildContext): BuildResult;
}

export interface Pack {
  id: string;
  name: L10n;
  description: L10n;
  recipes: string[];
}
