// Volume backup and restore without SSH nor `docker cp`: a short-lived busybox container mounts
// the volume and talks plain HTTP on a free 50xxx port. Backup: tar.gz served by `httpd`.
// Restore: the archive is posted to a CGI script that checks it, empties the volume and extracts it.
import { ApexError, hasImage, type ApexClient, type ContainerInfo } from "../apex/client";
import { writeFile } from "../recipes/helpers";
import { RECIPES } from "../recipes/catalog";
import { mountedVolumes } from "./links";
import { resolveValues } from "./planner";
import type { CreateOptions, L10n } from "../recipes/types";

export const HELPER_IMAGE = "busybox:1.36";
export const BACKUP_CONTAINER = "apexpress-backup";
export const RESTORE_CONTAINER = "apexpress-restore";
const HELPER_PORTS = [50498, 50497, 50496, 50495, 50494, 50493, 50492, 50491, 50490];
export const VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

const l10n = (fr: string, en: string): L10n => ({ fr, en });

/** Shell command of the backup helper: archive /data, then serve it under an unguessable name. */
export function backupCommand(key: string): string {
  return `mkdir -p /www && cd /data && tar czf /www/.part . && mv /www/.part /www/${key}.tar.gz && exec httpd -f -p 8080 -h /www`;
}

/** Shell command of the restore helper: a CGI script that only empties the volume once the archive reads fine. */
export function restoreCommand(key: string): string {
  const cgi = [
    "#!/bin/sh",
    'printf "Content-Type: text/plain\\r\\n\\r\\n"',
    'head -c "$CONTENT_LENGTH" > /tmp/r.tgz',
    "if ! tar tzf /tmp/r.tgz > /dev/null 2>&1; then echo BAD; exit 0; fi",
    "find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar xzf /tmp/r.tgz -C /data && echo OK || echo FAIL",
  ].join("\n");
  return `${writeFile(`/www/cgi-bin/${key}`, cgi)} && chmod 755 /www/cgi-bin/${key} && touch /www/ready && exec httpd -f -p 8080 -h /www`;
}

export function helperOptions(volume: string, port: number, command: string): CreateOptions {
  return {
    Image: HELPER_IMAGE,
    Cmd: ["sh", "-c", command],
    ExposedPorts: { "8080/tcp": {} },
    HostConfig: {
      CpusetCpus: "0",
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      PortBindings: { "8080/tcp": [{ HostPort: String(port) }] },
      Mounts: [{ Target: "/data", Source: volume, Type: "volume", ReadOnly: false, Consistency: "default" }],
    },
  };
}

/** First helper port that no container publishes. */
export function freeHelperPort(containers: ContainerInfo[]): number {
  const used = new Set(containers.flatMap((c) => c.hostPorts));
  const port = HELPER_PORTS.find((p) => !used.has(p));
  if (!port) throw new ApexError("http", "No free helper port in 50490-50498");
  return port;
}

/** Default container name -> volumes, from the catalog (for APEX answers that do not list mounts). */
function catalogMounts(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const all = Object.fromEntries(RECIPES.map((r) => [r.id, resolveValues(r, {})]));
  for (const r of RECIPES) {
    try {
      for (const c of r.build({ apexIp: "0.0.0.0", values: all[r.id]!, all }).containers) {
        map.set(c.name, (c.options.HostConfig?.Mounts ?? []).map((m) => m.Source));
      }
    } catch {
      /* recipes with required values may not build with defaults */
    }
  }
  return map;
}

/** Running containers that mount the volume (helpers excluded). */
export function volumeUsers(volume: string, containers: ContainerInfo[]): string[] {
  const known = catalogMounts();
  return containers
    .filter((c) => c.state === "running" && c.name !== BACKUP_CONTAINER && c.name !== RESTORE_CONTAINER)
    .filter((c) => mountedVolumes(c.raw).includes(volume) || known.get(c.name)?.includes(volume))
    .map((c) => c.name);
}

/** Pull an image if the APEX does not have it, and wait until it is listed. */
export async function ensureImage(client: ApexClient, image: string, pollMs: number, signal?: AbortSignal): Promise<boolean> {
  if (hasImage(await client.listImages().catch(() => []), image)) return false;
  await client.pullImage(image);
  for (let i = 0; i < 200 && !signal?.aborted; i++) {
    if (hasImage(await client.listImages().catch(() => []), image)) break;
    await Bun.sleep(pollMs);
  }
  return true;
}

/** Create and start a helper, retrying while a freshly pulled image is not usable yet. */
export async function startHelper(client: ApexClient, name: string, options: CreateOptions, pollMs: number) {
  await removeHelper(client, name);
  for (let i = 0; ; i++) {
    try {
      await client.createContainer(name, options);
      break;
    } catch (e) {
      if (i < 60 && e instanceof ApexError && /no such image/i.test(e.message)) {
        await Bun.sleep(pollMs);
        continue;
      }
      throw e;
    }
  }
  await client.startContainer(name);
}

export async function removeHelper(client: ApexClient, name: string) {
  await client.stopContainer(name).catch(() => undefined);
  await client.deleteContainer(name).catch(() => undefined);
}

/** Wait until the helper answers on `url`; fails early if the container stops. */
export async function waitForHelper(
  client: ApexClient,
  name: string,
  url: string,
  opts: { pollMs: number; timeoutMs: number; signal?: AbortSignal },
): Promise<Response> {
  const deadline = Date.now() + opts.timeoutMs;
  for (let i = 0; Date.now() < deadline; i++) {
    if (opts.signal?.aborted) throw new ApexError("timeout", "cancelled");
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    if (res?.ok) return res;
    // Every few polls, check the helper is still alive (tar error, volume full…).
    if (i % 3 === 2) {
      const state = (await client.listContainers().catch(() => [])).find((c) => c.name === name)?.state;
      if (state && state !== "running" && state !== "created") {
        throw new HelperError(
          l10n(
            `Le conteneur d'aide s'est arrêté (état ${state}) : archive impossible. Espace disque de l'APEX plein ?`,
            `The helper container stopped (state ${state}): archive failed. Is the APEX disk full?`,
          ),
        );
      }
    }
    await Bun.sleep(opts.pollMs);
  }
  throw new HelperError(
    l10n(
      `Pas de réponse de l'APEX sur ${new URL(url).host}. Un pare-feu bloque-t-il les ports 50490-50498 entre ce PC et l'APEX ?`,
      `No answer from the APEX on ${new URL(url).host}. Does a firewall block ports 50490-50498 between this PC and the APEX?`,
    ),
  );
}

export class HelperError extends Error {
  constructor(public l10n: L10n) {
    super(l10n.en);
  }
}

export const randomKey = () => crypto.randomUUID().replace(/-/g, "");

/** File name offered for download, e.g. z2m-data-2026-10-15-1432.tar.gz. */
export function archiveName(volume: string, date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${volume}-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.tar.gz`;
}
