import index from "../ui/index.html";
import { ApexClient, ApexError, hasImage, normalizeImage, type ContainerInfo, type Exchange } from "./apex/client";
import { lintContainer } from "./apex/opa";
import { buildPlan, type ExistingPolicy, type Plan, type PlannedContainer } from "./core/planner";
import { containerLinks, containerOtherPorts, mountedVolumes } from "./core/links";
import { renderReport } from "./core/report";
import { loadSite, saveDeployed, type DeployedContainer } from "./core/site-store";
import { checkImage, rebuildFromApex, type UpdateInfo } from "./core/updates";
import { describeError, runPlan, type RunEvent } from "./core/runner";
import { probeCoordinator } from "./apex/zigbee-probe";
import {
  archiveName,
  BACKUP_CONTAINER,
  backupCommand,
  ensureImage,
  freeHelperPort,
  HelperError,
  helperOptions,
  HELPER_IMAGE,
  randomKey,
  removeHelper,
  RESTORE_CONTAINER,
  restoreCommand,
  startHelper,
  VOLUME_RE,
  volumeUsers,
  waitForHelper,
} from "./core/volumes";
import { startMockApex, type MockApex } from "./mock/apex-mock";
import { PACKS, RECIPES } from "./recipes/catalog";
import type { CreateOptions, Lang, ParamValue } from "./recipes/types";
import { VERSION } from "./version";

interface Session {
  client: ApexClient;
  host: string;
  apexIp: string;
  username: string;
  demo: boolean;
}

interface Backup {
  id: string;
  volume: string;
  file: string;
  state: "running" | "ready" | "error" | "done";
  step: "stop" | "pull" | "archive" | "restart" | "ready";
  stopped: string[];
  url?: string;
  size?: number;
  error?: { fr: string; en: string };
  timer?: ReturnType<typeof setTimeout>;
}

interface Job {
  id: string;
  plan: Plan;
  events: RunEvent[];
  finished: boolean;
  controller: AbortController;
  listeners: Set<{ send: (e: RunEvent) => void; close: () => void }>;
}

export interface ServerOptions {
  port?: number;
  token?: string;
  /** Speed-ups for tests and demo. */
  runOptions?: { pollMs?: number; checkSeconds?: number; webCheckSeconds?: number };
  onQuit?: () => void;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (status: number, message: { fr: string; en: string } | string, extra: Record<string, unknown> = {}) =>
  json({ error: typeof message === "string" ? { fr: message, en: message } : message, ...extra }, status);

export function startServer(opts: ServerOptions = {}) {
  const token = opts.token ?? crypto.randomUUID();
  let session: Session | undefined;
  let mock: MockApex | undefined;
  let job: Job | undefined;
  const backups = new Map<string, Backup>();
  /** A backup or restore helper is running on the APEX: one at a time, never during a deployment. */
  let transferBusy = false;
  /** The demo APEX changes port on every start: its deployments are only remembered in memory. */
  const demoSite: Record<string, DeployedContainer> = {};
  const site = (s: Session) => (s.demo ? demoSite : loadSite(s.host));
  const remember = (s: Session, containers: { name: string; recipeId: string; options: CreateOptions }[]) => {
    if (!s.demo) return saveDeployed(s.host, containers);
    for (const c of containers) demoSite[c.name] = { recipeId: c.recipeId, options: c.options, savedAt: new Date().toISOString() };
  };
  const journal: Exchange[] = [];
  const onExchange = (e: Exchange) => {
    journal.push({ ...e, request: redact(e.request) });
    if (journal.length > 400) journal.splice(0, journal.length - 400);
  };

  const requireSession = () => {
    if (!session) throw new HttpError(409, { fr: "Pas de connexion à un APEX.", en: "Not connected to an APEX." });
    return session;
  };

  async function snapshot(s: Session) {
    const [containers, images, volumes] = await Promise.all([
      s.client.listContainers(),
      s.client.listImages().catch(() => [] as string[]),
      s.client.listVolumes().catch(() => [] as string[]),
    ]);
    return { containers: containers.map((c) => publicContainer(c, s.apexIp)), images, volumes };
  }

  async function connect(host: string, username: string, password: string, apexIp: string | undefined, demo: boolean) {
    const client = new ApexClient({ host, username, password, scheme: demo ? "http" : "https", onExchange, timeoutMs: 15000 });
    // The containerization service tells us whether this controller can run containers at all.
    try {
      await client.containerization();
    } catch (e) {
      if (e instanceof ApexError && e.kind === "not-found") {
        throw new HttpError(
          400,
          {
            fr: "Cet automate ne propose pas la conteneurisation (API REST v2). Est-ce bien un ECLYPSE APEX à jour ?",
            en: "This controller does not offer containerization (REST API v2). Is it an up-to-date ECLYPSE APEX?",
          },
        );
      }
      throw new HttpError(400, describeError(e));
    }
    const platform = await client.platform().catch(() => undefined);
    session = { client, host, apexIp: apexIp?.trim() || host.replace(/:\d+$/, ""), username, demo };
    return { platform, ...(await snapshot(session)) };
  }

  /** Base URL of a port published on the APEX, as reached from this PC. */
  function published(s: Session, port: number): string {
    if (s.demo && mock) return `${mock.url}/__published/${port}`;
    const host = s.host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
    return `http://${host}:${port}`;
  }

  const pollMs = () => opts.runOptions?.pollMs ?? 2000;

  function assertIdle() {
    if (job && !job.finished) throw new HttpError(409, { fr: "Un déploiement est en cours.", en: "A deployment is running." });
    if (transferBusy) throw new HttpError(409, { fr: "Une sauvegarde ou une restauration est déjà en cours.", en: "A backup or restore is already running." });
  }

  async function stopUsers(s: Session, volume: string, stopped: string[]) {
    for (const name of volumeUsers(volume, await s.client.listContainers())) {
      await s.client.stopContainer(name);
      stopped.push(name);
    }
  }

  async function restartUsers(s: Session, stopped: string[]) {
    for (const name of stopped) await s.client.startContainer(name).catch(() => undefined);
  }

  async function runBackup(s: Session, b: Backup, stop: boolean) {
    try {
      if (stop) await stopUsers(s, b.volume, b.stopped);
      b.step = "pull";
      await ensureImage(s.client, HELPER_IMAGE, pollMs());
      b.step = "archive";
      const port = freeHelperPort(await s.client.listContainers());
      const key = randomKey();
      await startHelper(s.client, BACKUP_CONTAINER, helperOptions(b.volume, port, backupCommand(key)), pollMs());
      b.url = `${published(s, port)}/${key}.tar.gz`;
      const head = await waitForHelper(s.client, BACKUP_CONTAINER, b.url, { pollMs: pollMs(), timeoutMs: 30 * 60_000 });
      b.size = Number(head.headers.get("content-length")) || undefined;
      b.step = "restart";
      await restartUsers(s, b.stopped);
      b.step = "ready";
      b.state = "ready";
      // Not downloaded within 30 minutes: free the APEX anyway.
      b.timer = setTimeout(() => finishBackup(s, b), 30 * 60_000);
    } catch (e) {
      b.state = "error";
      b.error = e instanceof HelperError ? e.l10n : describeError(e);
      await removeHelper(s.client, BACKUP_CONTAINER);
      await restartUsers(s, b.stopped);
      transferBusy = false;
    }
  }

  function finishBackup(s: Session, b: Backup) {
    if (b.state === "done") return;
    clearTimeout(b.timer);
    b.state = "done";
    transferBusy = false;
    removeHelper(s.client, BACKUP_CONTAINER);
  }

  function planFrom(body: any, existing: ContainerInfo[]): Plan {
    const s = requireSession();
    return buildPlan({
      selection: (body?.selection ?? {}) as Record<string, Record<string, ParamValue>>,
      apexIp: body?.apexIp || s.apexIp,
      onExisting: (body?.onExisting as ExistingPolicy) ?? "keep",
      existing: { containers: existing },
    });
  }

  function startJob(plan: Plan): Job {
    const s = requireSession();
    const j: Job = { id: crypto.randomUUID(), plan, events: [], finished: false, controller: new AbortController(), listeners: new Set() };
    job = j;
    const emit = (e: RunEvent) => {
      // Remember each container once it is on the APEX: needed to recreate it identically later (updates).
      const c = e.type === "step" && e.phase === "done" && (e.status === "ok" || e.status === "warning") ? plan.containers.find((x) => x.name === e.container && !x.oneShot) : undefined;
      if (c) {
        try {
          remember(s, [c]);
        } catch (err) {
          j.events.push({ type: "log", level: "warning", message: { fr: `Configuration de ${c.name} non mémorisée : ${err}`, en: `Configuration of ${c.name} not remembered: ${err}` } });
        }
      }
      j.events.push(e);
      for (const l of j.listeners) l.send(e);
    };
    // The demo APEX has no real services behind its ports: no web UI check there.
    runPlan(s.client, plan, emit, { signal: j.controller.signal, webCheckSeconds: s.demo ? 0 : 90, ...opts.runOptions })
      .catch((e) => emit({ type: "log", level: "error", message: describeError(e) }))
      .finally(() => {
        j.finished = true;
        for (const l of j.listeners) l.close();
        j.listeners.clear();
      });
    return j;
  }

  const api: Record<string, (req: Request, params: Record<string, string>) => Promise<Response> | Response> = {
    "GET /api/meta": () =>
      json({
        version: VERSION,
        recipes: RECIPES.map(({ build, ...r }) => r),
        packs: PACKS,
        session: session ? { host: session.host, apexIp: session.apexIp, username: session.username, demo: session.demo } : null,
      }),

    "POST /api/connect": async (req) => {
      const b = (await req.json()) as Record<string, string>;
      if (!b.host?.trim() || !b.username?.trim()) return fail(400, { fr: "Adresse et identifiant requis.", en: "Address and username are required." });
      const data = await connect(b.host.trim(), b.username.trim(), b.password ?? "", b.apexIp, false);
      return json({ session: { host: session!.host, apexIp: session!.apexIp, username: session!.username, demo: false }, ...data });
    },

    "POST /api/demo": async () => {
      mock?.stop();
      mock = startMockApex({ pullDelayMs: 2500, oneShotMs: 2000, latencyMs: 120, username: "demo", password: "demo" });
      const data = await connect(mock.host, "demo", "demo", "192.168.1.2", true);
      return json({ session: { host: "apex-demo", apexIp: session!.apexIp, username: "demo", demo: true }, ...data });
    },

    "POST /api/disconnect": () => {
      session = undefined;
      mock?.stop();
      mock = undefined;
      return json({ ok: true });
    },

    "GET /api/apex": async () => json(await snapshot(requireSession())),

    "POST /api/plan": async (req) => {
      const s = requireSession();
      const existing = await s.client.listContainers().catch(() => []);
      return json(planFrom(await req.json(), existing));
    },

    "POST /api/deploy": async (req) => {
      const s = requireSession();
      if (job && !job.finished) return fail(409, { fr: "Un déploiement est déjà en cours.", en: "A deployment is already running." });
      if (transferBusy) return fail(409, { fr: "Une sauvegarde ou une restauration est en cours.", en: "A backup or restore is running." });
      const existing = await s.client.listContainers();
      const plan = planFrom(await req.json(), existing);
      if (!plan.ok) return fail(400, { fr: "Le plan contient des erreurs.", en: "The plan has errors." }, { plan });
      const j = startJob(plan);
      return json({ jobId: j.id, plan });
    },

    "GET /api/deploy/events": () => {
      const j = job;
      if (!j) return fail(404, "No deployment");
      const encoder = new TextEncoder();
      let listener: { send: (e: RunEvent) => void; close: () => void } | undefined;
      const stream = new ReadableStream({
        start(controller) {
          const send = (e: RunEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
          j.events.forEach(send);
          if (j.finished) return controller.close();
          listener = { send, close: () => controller.close() };
          j.listeners.add(listener);
        },
        cancel() {
          if (listener) j.listeners.delete(listener);
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    },

    "POST /api/deploy/cancel": () => {
      job?.controller.abort();
      return json({ ok: true });
    },

    "GET /api/report": (req) => {
      const lang = (new URL(req.url).searchParams.get("lang") === "en" ? "en" : "fr") as Lang;
      if (!job) return fail(404, { fr: "Aucun déploiement à exporter.", en: "No deployment to export." });
      const md = renderReport(job.plan, job.events, lang, session?.demo ?? false);
      return new Response(md, {
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename="apexpress-${job.plan.apexIp}-${new Date().toISOString().slice(0, 10)}.md"`,
        },
      });
    },

    "GET /api/updates": async (req) => {
      const s = requireSession();
      const fresh = new URL(req.url).searchParams.get("fresh") === "1";
      const [containers, ids] = await Promise.all([s.client.listContainers(), s.client.listImageIds().catch(() => ({}) as Record<string, string>)]);
      const known = site(s);
      const out: Record<string, UpdateInfo & { updatable: boolean; source?: "pc" | "apex"; reason?: { fr: string; en: string } }> = {};
      const queue = containers.filter((c) => c.image && c.name !== BACKUP_CONTAINER && c.name !== RESTORE_CONTAINER && c.state !== "exited");
      // A few at a time: Docker Hub answers slowly and rate-limits.
      for (let i = 0; i < queue.length; i += 4) {
        await Promise.all(
          queue.slice(i, i + 4).map(async (c) => {
            const info = await checkImage(c.image!, c.imageId ?? ids[normalizeImage(c.image!)], fresh);
            const rebuild = known[c.name] ? undefined : rebuildFromApex(c);
            out[c.name] = {
              ...info,
              updatable: !rebuild || rebuild.ok,
              source: !rebuild ? "pc" : rebuild.ok ? "apex" : undefined,
              reason: rebuild && !rebuild.ok ? rebuild.reason : undefined,
            };
          }),
        );
      }
      return json(out);
    },

    "POST /api/containers/:name/update": async (req, p) => {
      const s = requireSession();
      assertIdle();
      const { image } = (await req.json()) as { image?: string };
      if (!image?.trim()) return fail(400, { fr: "Image requise.", en: "Image required." });
      const containers = await s.client.listContainers();
      const info = containers.find((c) => c.name === p.name);
      if (!info) return fail(404, { fr: `Conteneur ${p.name} introuvable.`, en: `Container ${p.name} not found.` });
      const saved = site(s)[info.name];
      const rebuilt = saved ? undefined : rebuildFromApex(info);
      if (rebuilt && !rebuilt.ok) return fail(400, rebuilt.reason);
      const base = saved ?? (rebuilt as Extract<typeof rebuilt, { ok: true }>);
      const ids = await s.client.listImageIds().catch(() => ({}) as Record<string, string>);
      const options = { ...base.options, Image: image.trim() };
      const issues = lintContainer(info.name, options);
      const container: PlannedContainer = {
        name: info.name,
        options,
        recipeId: base.recipeId,
        action: "replace",
        issues,
        update: { previousImage: info.image ?? "", previousId: info.imageId ?? ids[normalizeImage(info.image ?? "")] },
      };
      const recipe = RECIPES.find((r) => r.id === base.recipeId);
      const plan: Plan = {
        apexIp: s.apexIp,
        recipes: [
          {
            id: base.recipeId,
            name: recipe?.name ?? info.name,
            autoAdded: false,
            values: {},
            links: containerLinks(s.apexIp, { ...info, image: image.trim() }),
            credentials: [],
            notes: [],
            containers: [container],
          },
        ],
        containers: [container],
        issues,
        ramMb: 0,
        ok: !issues.some((i) => i.level === "error"),
      };
      if (!plan.ok) return fail(400, { fr: "Le conteneur ne passe pas les règles de l'OPA.", en: "The container does not pass the OPA rules." }, { plan });
      const j = startJob(plan);
      return json({ jobId: j.id, plan });
    },

    "POST /api/containers/:name/:action": async (_req, p) => {
      const s = requireSession();
      const name = p.name!;
      switch (p.action) {
        case "start":
          await s.client.startContainer(name);
          break;
        case "stop":
          await s.client.stopContainer(name);
          break;
        case "restart":
          await s.client.stopContainer(name).catch(() => undefined);
          await s.client.startContainer(name);
          break;
        case "delete":
          await s.client.stopContainer(name).catch(() => undefined);
          await s.client.deleteContainer(name);
          break;
        default:
          return fail(400, "Unknown action");
      }
      return json(await snapshot(s));
    },

    "POST /api/volumes/:name/delete": async (_req, p) => {
      const s = requireSession();
      await s.client.deleteVolume(p.name!);
      return json(await snapshot(s));
    },

    "GET /api/volumes/:name/users": async (_req, p) => {
      const s = requireSession();
      return json({ users: volumeUsers(p.name!, await s.client.listContainers()) });
    },

    "POST /api/volumes/:name/backup": async (req, p) => {
      const s = requireSession();
      assertIdle();
      const volume = p.name!;
      if (!VOLUME_RE.test(volume)) return fail(400, { fr: "Nom de volume invalide.", en: "Invalid volume name." });
      const body = (await req.json().catch(() => ({}))) as { stop?: boolean };
      const b: Backup = { id: randomKey(), volume, file: archiveName(volume), state: "running", step: "stop", stopped: [] };
      backups.set(b.id, b);
      transferBusy = true;
      runBackup(s, b, body.stop !== false);
      return json({ id: b.id });
    },

    "GET /api/backups/:id": (_req, p) => {
      const b = backups.get(p.id!);
      if (!b) return fail(404, { fr: "Sauvegarde inconnue.", en: "Unknown backup." });
      const { timer, url, ...view } = b;
      return json(view);
    },

    "GET /api/backups/:id/download": async (_req, p) => {
      const s = requireSession();
      const b = backups.get(p.id!);
      if (!b || b.state !== "ready" || !b.url) return fail(404, { fr: "Archive indisponible : relancez la sauvegarde.", en: "Archive unavailable: run the backup again." });
      const res = await fetch(b.url).catch(() => undefined);
      if (!res?.ok || !res.body) return fail(502, { fr: "L'APEX ne fournit plus l'archive : relancez la sauvegarde.", en: "The APEX no longer serves the archive: run the backup again." });
      // The helper is removed once the whole archive went through.
      const body = res.body.pipeThrough(new TransformStream({ flush: () => finishBackup(s, b) }));
      return new Response(body, {
        headers: {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${b.file}"`,
          ...(b.size ? { "Content-Length": String(b.size) } : {}),
        },
      });
    },

    "POST /api/volumes/:name/restore": async (req, p) => {
      const s = requireSession();
      assertIdle();
      const volume = p.name!;
      if (!VOLUME_RE.test(volume)) return fail(400, { fr: "Nom de volume invalide.", en: "Invalid volume name." });
      const data = new Uint8Array(await req.arrayBuffer());
      if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) {
        return fail(400, { fr: "Ce fichier n'est pas une archive .tar.gz.", en: "This file is not a .tar.gz archive." });
      }
      transferBusy = true;
      const stopped: string[] = [];
      try {
        // Always stop what uses the volume: its files are replaced underneath.
        await stopUsers(s, volume, stopped);
        await ensureImage(s.client, HELPER_IMAGE, pollMs());
        const port = freeHelperPort(await s.client.listContainers());
        const key = randomKey();
        await startHelper(s.client, RESTORE_CONTAINER, helperOptions(volume, port, restoreCommand(key)), pollMs());
        await waitForHelper(s.client, RESTORE_CONTAINER, `${published(s, port)}/ready`, { pollMs: pollMs(), timeoutMs: 5 * 60_000 });
        const res = await fetch(`${published(s, port)}/cgi-bin/${key}`, {
          method: "POST",
          body: data,
          headers: { "Content-Type": "application/octet-stream" },
          signal: AbortSignal.timeout(30 * 60_000),
        });
        const answer = (await res.text()).trim();
        if (answer === "BAD") return fail(400, { fr: "Archive illisible : le volume n'a pas été modifié.", en: "Unreadable archive: the volume was not changed." });
        if (answer !== "OK") {
          return fail(502, {
            fr: "L'extraction a échoué en cours de route : le volume est peut-être incomplet. Relancez la restauration.",
            en: "Extraction failed midway: the volume may be incomplete. Run the restore again.",
          });
        }
        return json({ ok: true, restarted: stopped });
      } catch (e) {
        if (e instanceof HelperError) return fail(502, e.l10n);
        throw e;
      } finally {
        await removeHelper(s.client, RESTORE_CONTAINER);
        await restartUsers(s, stopped);
        transferBusy = false;
      }
    },

    "POST /api/tools/zigbee-probe": async (req) => {
      const b = (await req.json()) as { host?: string; port?: number };
      const host = String(b.host ?? "").trim();
      const port = Number(b.port ?? 6638);
      if (!/^[a-z0-9.-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
        return fail(400, { fr: "IP ou port du coordinateur invalide.", en: "Invalid coordinator IP or port." });
      }
      return json(await probeCoordinator(host, port));
    },

    "POST /api/tools/lint": async (req) => {
      const b = (await req.json()) as { name: string; options: unknown };
      const options = typeof b.options === "string" ? JSON.parse(b.options) : b.options;
      return json({ issues: lintContainer(String(b.name ?? ""), options as CreateOptions) });
    },

    "POST /api/tools/custom": async (req) => {
      requireSession();
      if (job && !job.finished) return fail(409, { fr: "Un déploiement est déjà en cours.", en: "A deployment is already running." });
      if (transferBusy) return fail(409, { fr: "Une sauvegarde ou une restauration est en cours.", en: "A backup or restore is running." });
      const b = (await req.json()) as { name: string; options: CreateOptions; replace?: boolean };
      const existing = await session!.client.listContainers();
      const issues = lintContainer(b.name, b.options);
      const found = existing.some((c) => c.name === b.name);
      const container: PlannedContainer = {
        name: b.name,
        options: b.options,
        recipeId: "custom",
        action: found ? (b.replace ? "replace" : "keep") : "create",
        issues,
      };
      const plan: Plan = {
        apexIp: session!.apexIp,
        recipes: [{ id: "custom", name: b.name, autoAdded: false, values: {}, links: [], credentials: [], notes: [], containers: [container] }],
        containers: [container],
        issues,
        ramMb: 0,
        ok: !issues.some((i) => i.level === "error"),
      };
      if (!plan.ok) return fail(400, { fr: "Le conteneur ne passe pas les règles de l'OPA.", en: "The container does not pass the OPA rules." }, { plan });
      const j = startJob(plan);
      return json({ jobId: j.id, plan });
    },

    "POST /api/tools/arm64": async (req) => {
      const s = requireSession();
      const { image } = (await req.json()) as { image: string };
      if (!image?.trim()) return fail(400, { fr: "Image requise.", en: "Image required." });
      return json(await armTest(s.client, image.trim(), opts.runOptions?.pollMs ?? 2000));
    },

    "GET /api/journal": () => json(journal),

    "POST /api/quit": () => {
      setTimeout(() => opts.onQuit?.(), 200);
      return json({ ok: true });
    },
  };

  const routes = Object.entries(api).map(([key, handler]) => {
    const [method, pattern] = key.split(" ") as [string, string];
    const names: string[] = [];
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)")) + "$");
    return { method, re, names, handler };
  });

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    // Volume archives to restore go through this server.
    maxRequestBodySize: 2 * 1024 ** 3,
    development: process.env.APEXPRESS_DEV === "1",
    routes: { "/": index },
    async fetch(req) {
      const url = new URL(req.url);
      // Only the local UI may drive the APEX: check host (DNS rebinding) and session token (CSRF).
      const host = req.headers.get("host") ?? "";
      if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return new Response("Forbidden", { status: 403 });
      const provided = req.headers.get("x-apexpress-token") ?? url.searchParams.get("t");
      if (provided !== token) return new Response("Forbidden", { status: 403 });
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)]));
        try {
          return await r.handler(req, params);
        } catch (e) {
          if (e instanceof HttpError) return fail(e.status, e.body);
          return fail(502, describeError(e));
        }
      }
      return new Response("Not found", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/?t=${token}`,
    port: server.port!,
    token,
    stop() {
      job?.controller.abort();
      mock?.stop();
      server.stop(true);
    },
  };
}

class HttpError extends Error {
  constructor(
    public status: number,
    public body: { fr: string; en: string },
  ) {
    super(body.en);
  }
}

function publicContainer(c: ContainerInfo, apexIp: string) {
  return {
    name: c.name,
    image: c.image,
    state: c.state,
    status: c.status,
    hostPorts: c.hostPorts,
    links: containerLinks(apexIp, c),
    otherPorts: containerOtherPorts(apexIp, c),
    volumes: mountedVolumes(c.raw),
  };
}

/** Mask passwords and tokens in the request bodies kept in the journal. */
function redact(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value)
    .replace(/((?:PASSWORD|TOKEN|SECRET|AUTHKEY)[A-Z_]*=)[^"\\]+/gi, "$1***")
    .replace(/(mosquitto_passwd -b -c \S+ \S+ )'[^']*'/g, "$1'***'")
    .replace(/("--token",")[^"]+/g, "$1***");
  return JSON.parse(text);
}

/** Pull an image and run it with --help: "exited" means it runs on ARM64, "restarting" means it does not. */
async function armTest(client: ApexClient, image: string, pollMs: number) {
  const name = `apexpress-armtest-${Math.random().toString(36).slice(2, 8)}`;
  const steps: string[] = [];
  try {
    if (!hasImage(await client.listImages().catch(() => []), image)) {
      await client.pullImage(image);
      steps.push("pull");
      for (let i = 0; i < 200; i++) {
        if (hasImage(await client.listImages().catch(() => []), image)) break;
        await Bun.sleep(pollMs);
      }
    }
    for (let i = 0; ; i++) {
      try {
        await client.createContainer(name, {
          Image: image,
          Cmd: ["--help"],
          HostConfig: { CpusetCpus: "0", RestartPolicy: { Name: "no", MaximumRetryCount: 0 } },
        });
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
    let state: string | undefined;
    for (let i = 0; i < 15; i++) {
      await Bun.sleep(pollMs);
      state = (await client.listContainers()).find((c) => c.name === name)?.state;
      if (state === "exited" || state === "restarting" || state === "dead") break;
    }
    const compatible = state === "exited" ? true : state === "restarting" || state === "dead" ? false : null;
    return { image, state: state ?? "unknown", compatible };
  } catch (e) {
    return { image, state: "error", compatible: false, error: describeError(e) };
  } finally {
    await client.stopContainer(name).catch(() => undefined);
    await client.deleteContainer(name).catch(() => undefined);
  }
}
