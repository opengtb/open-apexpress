import type { L10n } from "./i18n";

const fromUrl = new URLSearchParams(location.search).get("t");
if (fromUrl) {
  try {
    sessionStorage.setItem("apexpress-token", fromUrl);
  } catch {
    /* storage unavailable */
  }
}
const TOKEN = fromUrl ?? (() => {
  try {
    return sessionStorage.getItem("apexpress-token") ?? "";
  } catch {
    return "";
  }
})();

export class ApiError extends Error {
  constructor(
    public status: number,
    public l10n: L10n,
    public data?: any,
  ) {
    super(l10n.en);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { "x-apexpress-token": TOKEN, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, {
      fr: "Open Apexpress ne répond plus. La fenêtre de l'application a-t-elle été fermée ?",
      en: "Open Apexpress stopped responding. Was the application window closed?",
    });
  }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const err = (data as any)?.error ?? { fr: `Erreur ${res.status}`, en: `Error ${res.status}` };
    throw new ApiError(res.status, err, data);
  }
  return data as T;
}

/** Server-sent events of the running deployment. */
export function deployEvents(onEvent: (e: any) => void, onEnd: () => void): () => void {
  const source = new EventSource(`/api/deploy/events?t=${encodeURIComponent(TOKEN)}`);
  let ended = false;
  source.onmessage = (m) => {
    const e = JSON.parse(m.data);
    onEvent(e);
    if (e.type === "done") {
      ended = true;
      source.close();
      onEnd();
    }
  };
  source.onerror = () => {
    source.close();
    if (!ended) onEnd();
  };
  return () => source.close();
}

export const reportUrl = (lang: string) => `/api/report?lang=${lang}&t=${encodeURIComponent(TOKEN)}`;
export const backupDownloadUrl = (id: string) => `/api/backups/${id}/download?t=${encodeURIComponent(TOKEN)}`;

/** Send a .tar.gz archive to restore into a volume of the APEX. */
export async function uploadArchive(volume: string, file: File): Promise<{ ok: boolean; restarted: string[] }> {
  let res: Response;
  try {
    res = await fetch(`/api/volumes/${encodeURIComponent(volume)}/restore`, {
      method: "POST",
      headers: { "x-apexpress-token": TOKEN, "Content-Type": "application/octet-stream" },
      body: file,
    });
  } catch {
    throw new ApiError(0, {
      fr: "Open Apexpress ne répond plus. La fenêtre de l'application a-t-elle été fermée ?",
      en: "Open Apexpress stopped responding. Was the application window closed?",
    });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error ?? { fr: `Erreur ${res.status}`, en: `Error ${res.status}` }, data);
  return data;
}

// --- Shared types (mirrors of the server ones) ---------------------------------

export type ParamValue = string | number | boolean;

export interface Param {
  id: string;
  label: L10n;
  help?: L10n;
  type: "text" | "password" | "number" | "select" | "boolean" | "textarea";
  default?: ParamValue;
  generate?: "password" | "token";
  options?: { value: string; label: L10n }[];
  required?: boolean;
  advanced?: boolean;
  placeholder?: string;
}

export interface Recipe {
  id: string;
  name: string;
  category: string;
  badge: string;
  color: string;
  status: "validated" | "experimental";
  summary: L10n;
  description: L10n;
  ramMb: number;
  requires?: string[];
  homepage?: string;
  troubleshooting?: L10n[];
  params: Param[];
}

export interface Pack {
  id: string;
  name: L10n;
  description: L10n;
  recipes: string[];
}

export interface Issue {
  level: "error" | "warning";
  code: string;
  message: L10n;
  container?: string;
}

export interface PlannedContainer {
  name: string;
  recipeId: string;
  action: "create" | "replace" | "keep";
  options: any;
  oneShot?: { removeAfter: boolean };
  description?: L10n;
  issues: Issue[];
}

export interface PlannedRecipe {
  id: string;
  name: string;
  autoAdded: boolean;
  values: Record<string, ParamValue>;
  links: { label: L10n; url: string }[];
  credentials: { label: L10n; value: string }[];
  notes: L10n[];
  containers: PlannedContainer[];
}

export interface Plan {
  apexIp: string;
  recipes: PlannedRecipe[];
  containers: PlannedContainer[];
  issues: Issue[];
  ramMb: number;
  ok: boolean;
}

export interface ApexContainer {
  name: string;
  image?: string;
  state?: string;
  status?: string;
  hostPorts: number[];
  /** Web UIs recognized from the catalog. */
  links?: { label: L10n; url: string }[];
  /** Known non-web ports (MQTT, WebSocket…) and what they are. */
  otherPorts?: Record<number, L10n>;
  volumes?: string[];
}

export interface UpdateInfo {
  rebuilt?: boolean;
  newer?: string;
  major?: string;
  error?: string;
  updatable: boolean;
  /** Where the configuration to recreate comes from: remembered on this PC, or rebuilt from the APEX listing. */
  source?: "pc" | "apex";
  reason?: L10n;
}

export interface ApexSnapshot {
  containers: ApexContainer[];
  images: string[];
  volumes: string[];
  platform?: Record<string, unknown>;
}

export interface SessionInfo {
  host: string;
  apexIp: string;
  username: string;
  demo: boolean;
}
