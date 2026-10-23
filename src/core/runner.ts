import { ApexClient, ApexError, hasImage, normalizeImage, type ContainerInfo } from "../apex/client";
import { hostPorts } from "../apex/opa";
import { recipeById } from "../recipes/catalog";
import type { L10n } from "../recipes/types";
import type { Plan, PlannedContainer } from "./planner";

export type Phase = "prepare" | "remove" | "pull" | "create" | "start" | "wait" | "check" | "cleanup" | "done";
export type StepStatus = "running" | "ok" | "warning" | "error" | "skipped";

export type RunEvent =
  | { type: "start"; total: number; at: string }
  | { type: "step"; container: string; phase: Phase; status: StepStatus; message?: L10n }
  | { type: "log"; level: "info" | "warning" | "error"; message: L10n }
  | { type: "done"; ok: boolean; cancelled: boolean; counts: Record<"ok" | "warning" | "error" | "skipped", number>; seconds: number };

export interface RunOptions {
  pullTimeoutSec?: number;
  oneShotTimeoutSec?: number;
  checkSeconds?: number;
  /**
   * After the container runs, wait this long for its web UI to answer (0 = no check).
   * "running" is not enough: Zigbee2MQTT, for instance, only opens its UI once its coordinator answers.
   */
  webCheckSeconds?: number;
  pollMs?: number;
  stopOnError?: boolean;
  signal?: AbortSignal;
}

class Cancelled extends Error {}

const m = (fr: string, en: string): L10n => ({ fr, en });

export function describeError(e: unknown): L10n {
  // Errors that already carry their own bilingual message.
  if (e && typeof e === "object" && "l10n" in e) return (e as { l10n: L10n }).l10n;
  if (e instanceof ApexError) {
    switch (e.kind) {
      case "auth":
        return m("Identifiant ou mot de passe refusé (401).", "Username or password rejected (401).");
      case "forbidden":
        return m(`Accès refusé (403) : ce compte n'a pas les droits suffisants. ${e.message}`, `Access denied (403): this account lacks permissions. ${e.message}`);
      case "policy":
        return m(
          `Refusé par l'OPA de l'APEX : ${e.message}. Vérifiez ports 50xxx, ExposedPorts, Mounts et CpusetCpus.`,
          `Rejected by the APEX OPA plugin: ${e.message}. Check 50xxx ports, ExposedPorts, Mounts and CpusetCpus.`,
        );
      case "not-found":
        return m(`Ressource introuvable (404) : ${e.message}`, `Resource not found (404): ${e.message}`);
      case "timeout":
        return m("L'APEX ne répond pas (délai dépassé).", "The APEX does not answer (timeout).");
      case "tls":
        return m(`Erreur TLS : ${e.message}`, `TLS error: ${e.message}`);
      case "network":
        return m(`APEX injoignable : ${e.message}`, `APEX unreachable: ${e.message}`);
      default:
        return m(`Erreur HTTP ${e.status ?? ""} : ${e.message}`, `HTTP error ${e.status ?? ""}: ${e.message}`);
    }
  }
  const msg = e instanceof Error ? e.message : String(e);
  return m(msg, msg);
}

const isNoSuchImage = (e: unknown) =>
  e instanceof ApexError && /no such image|pull access denied|image [^ ]* not found/i.test(`${e.message} ${e.body ?? ""}`);

export async function runPlan(client: ApexClient, plan: Plan, emit: (e: RunEvent) => void, opts: RunOptions = {}): Promise<boolean> {
  const pollMs = opts.pollMs ?? 3000;
  const pullTimeout = (opts.pullTimeoutSec ?? 900) * 1000;
  const oneShotTimeout = (opts.oneShotTimeoutSec ?? 180) * 1000;
  const checkMs = (opts.checkSeconds ?? 20) * 1000;
  const webCheckMs = (opts.webCheckSeconds ?? 0) * 1000;
  const stopOnError = opts.stopOnError ?? true;
  const started = Date.now();
  const counts = { ok: 0, warning: 0, error: 0, skipped: 0 };

  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new Cancelled());
      const timer = setTimeout(resolve, ms);
      opts.signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Cancelled())), { once: true });
    });
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new Cancelled();
  };
  const step = (c: PlannedContainer, phase: Phase, status: StepStatus, message?: L10n) => emit({ type: "step", container: c.name, phase, status, message });

  const findContainer = async (name: string): Promise<ContainerInfo | undefined> => (await client.listContainers()).find((x) => x.name === name);

  /** Web UI links of this container (a link whose port it publishes). Returns a warning when none answers. */
  const waitForWebUi = async (c: PlannedContainer): Promise<L10n | undefined> => {
    const recipe = plan.recipes.find((r) => r.id === c.recipeId);
    const ports = new Set(hostPorts(c.options).map((p) => p.port));
    const urls = (recipe?.links ?? [])
      .map((l) => l.url)
      .filter((u) => /^https?:/.test(u) && ports.has(Number(/:(\d+)/.exec(u.replace(/^https?:\/\//, ""))?.[1])));
    if (!urls.length) return undefined;
    step(c, "check", "running", m("Attente de l'interface web…", "Waiting for the web UI…"));
    const deadline = Date.now() + webCheckMs;
    while (Date.now() < deadline) {
      for (const url of urls) {
        // Any HTTP answer (even 401 or a redirect) means the service is up.
        const ok = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(4000) }).then(() => true, () => false);
        if (ok) return undefined;
      }
      await sleep(Math.min(pollMs, 3000));
    }
    const help = recipe && recipeById(recipe.id)?.troubleshooting?.length ? m(` Voir l'aide « ${recipe.name} » dans Open Apexpress.`, ` See the "${recipe.name}" help in Open Apexpress.`) : m("", "");
    return m(
      `Le conteneur tourne mais ${urls[0]} ne répond pas après ${webCheckMs / 1000} s : le service n'a pas démarré. Lisez son journal avec FileBrowser.${help.fr}`,
      `The container runs but ${urls[0]} does not answer after ${webCheckMs / 1000} s: the service did not start. Read its log with FileBrowser.${help.en}`,
    );
  };

  /** After an update, the previous image only takes space on the APEX (by id when the tag was republished). */
  const removeOldImage = async (c: PlannedContainer) => {
    if (!c.update) return;
    const old = normalizeImage(c.update.previousImage) === normalizeImage(c.options.Image) ? c.update.previousId : c.update.previousImage;
    if (!old) return;
    const users = (await client.listContainers().catch(() => [])).filter((x) => x.name !== c.name && (x.image === c.update!.previousImage || x.imageId === old));
    if (users.length) return;
    step(c, "cleanup", "running");
    const removed = await client.deleteImage(old).then(() => true, () => false);
    const label = old.startsWith("sha256:") ? `${c.update.previousImage} (${old.slice(7, 19)})` : old;
    step(c, "cleanup", removed ? "ok" : "skipped", removed ? m(`Ancienne image ${label} supprimée.`, `Old image ${label} deleted.`) : undefined);
  };

  emit({ type: "start", total: plan.containers.length, at: new Date().toISOString() });
  let images: string[] = [];
  let imagesParsable = true;
  try {
    images = await client.listImages();
  } catch (e) {
    emit({ type: "log", level: "warning", message: m("Liste des images illisible, on télécharge systématiquement.", "Image list unreadable, images will always be pulled.") });
    imagesParsable = false;
  }

  let failed = false;
  let cancelled = false;
  for (const c of plan.containers) {
    if (cancelled || (failed && stopOnError)) {
      step(c, "done", "skipped", cancelled ? m("Annulé.", "Cancelled.") : m("Ignoré suite à une erreur précédente.", "Skipped after a previous error."));
      counts.skipped++;
      continue;
    }
    try {
      checkAbort();
      if (c.action === "keep") {
        const info = await findContainer(c.name).catch(() => undefined);
        if (info?.state && info.state !== "running" && !c.oneShot) {
          step(c, "start", "running");
          await client.startContainer(c.name);
        }
        step(c, "done", "skipped", m("Déjà présent sur l'APEX, conservé.", "Already on the APEX, kept."));
        counts.skipped++;
        continue;
      }

      // Update: the new image first, so that a failed download leaves the service untouched.
      if (c.update) {
        step(c, "pull", "running", m(`Téléchargement de ${c.options.Image}…`, `Pulling ${c.options.Image}…`));
        const ref = normalizeImage(c.options.Image);
        const ready = (ids: Record<string, string>) => !!ids[ref] && ids[ref] !== c.update!.previousId;
        let ids = await client.listImageIds().catch(() => ({}) as Record<string, string>);
        if (!ready(ids)) {
          await client.pullImage(c.options.Image);
          const deadline = Date.now() + pullTimeout;
          while (!ready(ids)) {
            if (Date.now() > deadline) {
              const l10n = m("Téléchargement non terminé à temps : le service n'a pas été touché.", "Download not finished in time: the service was not touched.");
              throw Object.assign(new Error(l10n.en), { l10n });
            }
            await sleep(pollMs);
            ids = await client.listImageIds().catch(() => ids);
          }
        }
        images = Object.keys(ids);
        step(c, "pull", "ok", m(`Image ${c.options.Image} disponible.`, `Image ${c.options.Image} available.`));
      }

      if (c.action === "replace") {
        step(c, "remove", "running");
        await client.stopContainer(c.name).catch(() => undefined);
        await client.deleteContainer(c.name).catch((e) => {
          if (!(e instanceof ApexError && e.kind === "not-found")) throw e;
        });
        step(c, "remove", "ok");
      }

      // Image -----------------------------------------------------------------
      const image = c.options.Image;
      if (c.update) {
        // Pulled above.
      } else if (!imagesParsable || !hasImage(images, image)) {
        step(c, "pull", "running", m(`Téléchargement de ${image}…`, `Pulling ${image}…`));
        await client.pullImage(image);
        const deadline = Date.now() + pullTimeout;
        let polls = 0;
        while (Date.now() < deadline) {
          images = await client.listImages().catch(() => images);
          if (hasImage(images, image)) break;
          // Unknown list format: do not wait for nothing, the create retry loop covers it.
          if (++polls >= 3 && images.length === 0) break;
          await sleep(pollMs);
        }
        step(c, "pull", "ok", m(`Image ${image} disponible.`, `Image ${image} available.`));
      } else {
        step(c, "pull", "skipped", m(`Image ${image} déjà présente.`, `Image ${image} already present.`));
      }

      // Create (retried while the image is still being pulled) -------------------
      step(c, "create", "running");
      const createDeadline = Date.now() + pullTimeout;
      for (;;) {
        checkAbort();
        try {
          await client.createContainer(c.name, c.options);
          break;
        } catch (e) {
          if (isNoSuchImage(e) && Date.now() < createDeadline) {
            step(c, "create", "running", m("Image pas encore prête, nouvel essai…", "Image not ready yet, retrying…"));
            await sleep(pollMs * 2);
            continue;
          }
          throw e;
        }
      }
      step(c, "create", "ok");

      step(c, "start", "running");
      await client.startContainer(c.name);
      step(c, "start", "ok");

      // One-shot containers: wait for completion ---------------------------------
      if (c.oneShot) {
        step(c, "wait", "running", m("Initialisation en cours…", "Initialization running…"));
        const deadline = Date.now() + (c.oneShot.timeoutSec ? c.oneShot.timeoutSec * 1000 : oneShotTimeout);
        let finished = false;
        let unknown = 0;
        while (Date.now() < deadline) {
          await sleep(pollMs);
          const info = await findContainer(c.name).catch(() => undefined);
          if (info?.state === "exited" || info?.state === "dead") {
            finished = true;
            break;
          }
          if (!info?.state && ++unknown >= 5) {
            // State not readable: the init scripts only take a few seconds.
            finished = true;
            break;
          }
        }
        if (!finished) throw new Error(`${c.name}: initialization did not finish in time`);
        step(c, "wait", "ok");
        if (c.oneShot.removeAfter) {
          step(c, "cleanup", "running");
          await client.deleteContainer(c.name).catch(() => undefined);
          step(c, "cleanup", "ok");
        }
        step(c, "done", "ok");
        counts.ok++;
        continue;
      }

      // Health check -------------------------------------------------------------
      step(c, "check", "running");
      const deadline = Date.now() + checkMs;
      let state: string | undefined;
      let stableRuns = 0;
      while (Date.now() < deadline) {
        await sleep(Math.min(pollMs, 3000));
        state = (await findContainer(c.name).catch(() => undefined))?.state;
        if (state === "running") {
          if (++stableRuns >= 2) break;
        } else if (state === "exited" || state === "dead") {
          break;
        }
      }
      if (state === "running" || state === undefined) {
        const web = webCheckMs > 0 ? await waitForWebUi(c) : undefined;
        if (web) {
          step(c, "check", "warning", web);
          step(c, "done", "warning", web);
          counts.warning++;
        } else {
          step(c, "check", "ok");
          await removeOldImage(c);
          step(c, "done", "ok");
          counts.ok++;
        }
      } else {
        const msg = m(
          `Le conteneur est « ${state} » : il redémarre ou s'arrête. Lisez ses journaux avec FileBrowser.`,
          `The container is "${state}": it restarts or stops. Read its logs with FileBrowser.`,
        );
        step(c, "check", "warning", msg);
        step(c, "done", "warning", msg);
        counts.warning++;
      }
    } catch (e) {
      if (e instanceof Cancelled) {
        cancelled = true;
        step(c, "done", "skipped", m("Annulé.", "Cancelled."));
        counts.skipped++;
        failed = true;
        continue;
      }
      const message = describeError(e);
      step(c, "done", "error", message);
      emit({ type: "log", level: "error", message });
      counts.error++;
      failed = true;
    }
  }
  const ok = counts.error === 0 && !cancelled;
  emit({ type: "done", ok, cancelled, counts, seconds: Math.round((Date.now() - started) / 1000) });
  return ok;
}
