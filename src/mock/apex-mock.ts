/**
 * Simulated ECLYPSE APEX: just enough of the REST API v2 containerization service
 * to develop, test and demo Open Apexpress without a real controller.
 *
 * It enforces the OPA rules observed in the field (50xxx host ports, ExposedPorts,
 * no Binds, CpusetCpus "0", lowercase names). Response shapes are an educated guess
 * (maps keyed by name, kebab-case fields, like the rest of the ECLYPSE API).
 */

import { createBacnet } from "./bacnet-mock";

export interface MockOptions {
  port?: number;
  hostname?: string;
  username?: string;
  password?: string;
  tls?: { cert: string; key: string };
  /** Simulated pull duration. */
  pullDelayMs?: number;
  /** How long one-shot (RestartPolicy "no") containers run before exiting. */
  oneShotMs?: number;
  latencyMs?: number;
  /** Tags republished on the registry: pulling them again gives a new image id. */
  republished?: string[];
  /** Pre-existing containers (already "running"). */
  seed?: { name: string; image: string; hostPorts?: Record<string, string> }[];
}

interface MockContainer {
  name: string;
  image: string;
  state: "created" | "running" | "exited" | "restarting";
  options: Record<string, any>;
  created: string;
  imageId?: string;
  timer?: ReturnType<typeof setTimeout>;
}

const POLICY = "request rejected by administrative policy";

export function startMockApex(opts: MockOptions = {}) {
  const username = opts.username ?? "admin";
  const password = opts.password ?? "admin";
  const containers = new Map<string, MockContainer>();
  const images = new Map<string, { pulled: string; id: string }>();
  const newId = () => `sha256:${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  const volumes = new Set<string>();
  const pulling = new Set<string>();
  const requests: { method: string; path: string; body?: any }[] = [];
  const bacnet = createBacnet();

  const normalize = (ref: string) => {
    let r = ref.replace(/^docker\.io\//, "").replace(/^library\//, "");
    if (!r.slice(r.lastIndexOf("/") + 1).includes(":")) r += ":latest";
    return r;
  };

  for (const s of opts.seed ?? []) {
    images.set(normalize(s.image), { pulled: new Date().toISOString(), id: newId() });
    containers.set(s.name, {
      name: s.name,
      image: s.image,
      state: "running",
      created: new Date().toISOString(),
      options: {
        Image: s.image,
        HostConfig: {
          PortBindings: Object.fromEntries(Object.entries(s.hostPorts ?? {}).map(([k, v]) => [k, [{ HostPort: v }]])),
        },
      },
    });
  }

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const error = (status: number, message: string) => json({ message }, status);

  const containerView = (c: MockContainer) => ({
    key: c.name,
    image: c.image,
    "image-id": c.imageId ?? images.get(normalize(c.image))?.id,
    state: c.state,
    status: c.state === "running" ? "Up 1 minute" : c.state === "exited" ? "Exited (0) 1 second ago" : c.state,
    created: c.created,
    "port-bindings": Object.fromEntries(
      Object.entries(c.options.HostConfig?.PortBindings ?? {}).map(([k, v]: [string, any]) => [k, v.map((b: any) => ({ "host-port": b.HostPort }))]),
    ),
    mounts: (c.options.HostConfig?.Mounts ?? []).map((m: any) => ({ source: m.Source, target: m.Target })),
  });

  function policyCheck(name: string, o: any): string | null {
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(name)) return "Illegal character in container name";
    const hc = o.HostConfig ?? {};
    if (hc.Binds?.length) return POLICY;
    if (hc.Privileged || hc.Devices?.length || hc.CapAdd?.length || hc.NetworkMode === "host") return POLICY;
    if (hc.CpusetCpus !== "0") return POLICY;
    const exposed = Object.keys(o.ExposedPorts ?? {});
    for (const [port, bindings] of Object.entries<any[]>(hc.PortBindings ?? {})) {
      if (!exposed.includes(port)) return POLICY;
      for (const b of bindings) {
        if (!b.HostPort) continue;
        const p = Number(b.HostPort);
        if (p < 50000 || p > 50999 || p === 50880) return POLICY;
      }
    }
    for (const m of hc.Mounts ?? []) if (m.Type !== "volume") return POLICY;
    return null;
  }

  function usedPorts(except?: string): Set<string> {
    const used = new Set<string>();
    for (const c of containers.values()) {
      if (c.name === except || c.state !== "running") continue;
      for (const bindings of Object.values<any[]>(c.options.HostConfig?.PortBindings ?? {})) for (const b of bindings) if (b.HostPort) used.add(String(b.HostPort));
    }
    return used;
  }

  /** Stand-in for the busybox httpd of the volume backup/restore helpers, reached on a published port. */
  async function published(port: string, path: string, req: Request): Promise<Response> {
    const c = [...containers.values()].find(
      (x) => x.state === "running" && Object.values<any[]>(x.options.HostConfig?.PortBindings ?? {}).some((b) => b.some((y) => y.HostPort === port)),
    );
    const cmd: string = c?.options.Cmd?.join(" ") ?? "";
    if (!c || !cmd.includes("httpd")) return new Response("Connection refused", { status: 502 });
    if (path.endsWith(".tar.gz") && cmd.includes(path.slice(1))) {
      const volume = c.options.HostConfig?.Mounts?.[0]?.Source ?? "?";
      const archive = Bun.gzipSync(new TextEncoder().encode(`demo backup of ${volume}\n`));
      return new Response(req.method === "HEAD" ? null : archive, { headers: { "Content-Length": String(archive.length) } });
    }
    if (path === "/ready" && cmd.includes("/www/ready")) return new Response("");
    if (req.method === "POST" && path.startsWith("/cgi-bin/") && cmd.includes(path)) {
      const data = new Uint8Array(await req.arrayBuffer());
      return new Response(data[0] === 0x1f && data[1] === 0x8b ? "OK\n" : "BAD\n");
    }
    return new Response("Not found", { status: 404 });
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, "");
    const helper = path.match(/^\/__published\/(\d+)(\/.*)?$/);
    if (helper) return published(helper[1]!, helper[2] ?? "/", req);
    const body = req.method === "POST" ? await req.json().catch(() => undefined) : undefined;
    requests.push({ method: req.method, path, body });
    if (opts.latencyMs) await Bun.sleep(opts.latencyMs);

    const auth = req.headers.get("authorization") ?? "";
    const expected = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
    if (auth !== expected) return error(401, "Unauthorized");

    const ctz = "/api/rest/v2/services/containerization";
    if (req.method === "GET" && path === "/api/rest") return json({ versions: ["v1", "v2"], current: "v2" });
    if (req.method === "GET" && path === "/api/rest/v2/services/platform") {
      return json({
        name: "ECLYPSE-APEX-DEMO",
        model: "ECY-APEX",
        "firmware-version": "2.1.0 (simulated)",
        "serial-number": "DEMO-0001",
        memory: { total: 2048, available: 1800 },
        // The real service also returns the network setup, Wi-Fi hotspot password in clear included.
        network: { hostname: "ECLYPSE-DEMO", interfaces: { bridge: { ipv4: { "ip-address": "192.168.1.2" } }, wireless: { ssid: "ECLYPSE-demo", password: "eclypse1234" } } },
        monitoring: { jvm: { uptime: "5h 48m" }, sensors: { "cpu-temperature": { value: 40.2, units: "DegreesCelsius" } }, storage: { internal: { "used-space": 5.8e9, "free-space": 14.3e9, "total-space": 20.1e9 } } },
      });
    }
    if (req.method === "GET" && path === ctz) {
      return json({ containers: containers.size, images: images.size, volumes: volumes.size, enabled: true });
    }
    if (req.method === "GET" && path === `${ctz}/containers`) {
      return json(Object.fromEntries([...containers.values()].map((c) => [c.name, containerView(c)])));
    }
    if (req.method === "GET" && path === `${ctz}/images`) {
      return json(Object.fromEntries([...images.entries()].map(([ref, i]) => [ref, { key: ref, pulled: i.pulled, id: i.id }])));
    }
    if (req.method === "GET" && path === `${ctz}/volumes`) {
      return json(Object.fromEntries([...volumes].map((v) => [v, { key: v, driver: "local" }])));
    }
    if (req.method === "POST" && path === `${ctz}/images/pull-image`) {
      const ref = body?.image;
      if (typeof ref !== "string" || !ref) return error(400, "Missing image");
      if (/doesnotexist/.test(ref)) return error(404, `pull access denied for ${ref}, repository does not exist`);
      const n = normalize(ref);
      if ((!images.has(n) || opts.republished?.includes(n)) && !pulling.has(n)) {
        pulling.add(n);
        setTimeout(() => {
          pulling.delete(n);
          images.set(n, { pulled: new Date().toISOString(), id: newId() });
        }, opts.pullDelayMs ?? 1500);
      }
      return json({ status: "pulling", image: ref }, 202);
    }
    if (req.method === "POST" && path === `${ctz}/containers/create-container`) {
      const name = body?.name;
      const o = body?.options;
      if (typeof name !== "string" || !o?.Image) return error(400, "Missing name or options");
      if (containers.has(name)) return error(409, `Conflict. The container name "/${name}" is already in use`);
      const policy = policyCheck(name, o);
      if (policy) return error(policy === POLICY ? 403 : 400, policy);
      if (!images.has(normalize(o.Image))) return error(404, `No such image: ${o.Image}`);
      for (const m of o.HostConfig?.Mounts ?? []) volumes.add(m.Source);
      containers.set(name, { name, image: o.Image, state: "created", options: o, created: new Date().toISOString(), imageId: images.get(normalize(o.Image))!.id });
      return json({ key: name, id: crypto.randomUUID().replace(/-/g, "") }, 201);
    }
    if (req.method === "POST" && (path === `${ctz}/containers/start` || path === `${ctz}/containers/stop`)) {
      const c = containers.get(body?.["container-name"]);
      if (!c) return error(404, `No such container: ${body?.["container-name"]}`);
      clearTimeout(c.timer);
      if (path.endsWith("stop")) {
        c.state = "exited";
        return json({ key: c.name, state: c.state });
      }
      const used = usedPorts(c.name);
      for (const bindings of Object.values<any[]>(c.options.HostConfig?.PortBindings ?? {})) {
        for (const b of bindings) if (b.HostPort && used.has(String(b.HostPort))) return error(500, `Bind for 0.0.0.0:${b.HostPort} failed: port is already allocated`);
      }
      // "crash" images loop forever; "amd64" images cannot run on the ARM64 APEX.
      c.state = /crash|amd64/.test(c.image) ? "restarting" : "running";
      if (c.state === "running" && c.options.HostConfig?.RestartPolicy?.Name === "no") {
        c.timer = setTimeout(() => (c.state = "exited"), opts.oneShotMs ?? 1500);
      }
      return json({ key: c.name, state: c.state });
    }
    const containerMatch = path.match(new RegExp(`^${ctz}/containers/([^/]+)$`));
    if (containerMatch) {
      const c = containers.get(containerMatch[1]!);
      if (!c) return error(404, `No such container: ${containerMatch[1]}`);
      if (req.method === "GET") return json(containerView(c));
      if (req.method === "DELETE") {
        if (c.state === "running" || c.state === "restarting") return error(409, "You cannot remove a running container. Stop the container before attempting removal");
        clearTimeout(c.timer);
        containers.delete(c.name);
        return json({ key: c.name, deleted: true });
      }
    }
    const volumeMatch = path.match(new RegExp(`^${ctz}/volumes/([^/]+)$`));
    if (volumeMatch && req.method === "DELETE") {
      const v = volumeMatch[1]!;
      if (!volumes.has(v)) return error(404, `No such volume: ${v}`);
      const inUse = [...containers.values()].some((c) => (c.options.HostConfig?.Mounts ?? []).some((m: any) => m.Source === v));
      if (inUse) return error(409, `remove ${v}: volume is in use`);
      volumes.delete(v);
      return json({ key: v, deleted: true });
    }
    const imageMatch = path.match(new RegExp(`^${ctz}/images/(.+)$`));
    if (imageMatch && req.method === "DELETE") {
      const target = imageMatch[1]!;
      // By id: an image whose tag went to a newer build.
      if (target.startsWith("sha256:")) {
        if ([...containers.values()].some((c) => c.imageId === target)) return error(409, "image is being used by a container");
        return json({ key: target, deleted: true });
      }
      const ref = normalize(target);
      if (!images.has(ref)) return error(404, `No such image: ${target}`);
      if ([...containers.values()].some((c) => normalize(c.image) === ref)) return error(409, "image is being used by a container");
      images.delete(ref);
      return json({ key: ref, deleted: true });
    }
    return bacnet(req.method, path, body) ?? error(404, `Unknown resource ${req.method} ${path}`);
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: opts.hostname ?? "127.0.0.1",
    tls: opts.tls,
    fetch: handle,
  });

  return {
    url: `${opts.tls ? "https" : "http"}://${server.hostname}:${server.port}`,
    host: `${server.hostname}:${server.port}`,
    port: server.port!,
    username,
    password,
    state: { containers, images, volumes, requests },
    stop: () => {
      for (const c of containers.values()) clearTimeout(c.timer);
      server.stop(true);
    },
  };
}

export type MockApex = ReturnType<typeof startMockApex>;
