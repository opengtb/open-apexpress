import { API_BASE, type ContainerInfo } from "../apex/client";
import { hostPorts, lintContainer } from "../apex/opa";
import { RECIPES } from "../recipes/catalog";
import { container, writeFile } from "../recipes/helpers";
import type { ParamValue } from "../recipes/types";
import { resolveValues, type PlannedRecipe } from "./planner";

/**
 * The portal is a static page served by nginx on the APEX. Its "actualiser" button lists the
 * containers again through a read-only nginx proxy to the APEX REST API: the user types the
 * APEX credentials in the page, they are only kept in the browser tab (never on the APEX).
 */

interface PortalLink {
  label: string;
  url: string;
  port: number | null;
  container?: string;
}

interface PortalRecipe {
  id: string;
  name: string;
  badge: string;
  color: string;
  category: string;
  summary: string;
  /** Default container names and image repositories, to recognize a container. */
  names: string[];
  repos: string[];
  links: PortalLink[];
}

interface PortalContainer {
  name: string;
  image?: string;
  state?: string;
  hostPorts: number[];
}

interface PortalData {
  apexIp: string;
  self: string;
  generated: string;
  recipes: PortalRecipe[];
  /** Real links of the services deployed with this plan (non-default ports, labels). */
  known: PortalLink[];
  containers: PortalContainer[];
}

const CATEGORY_FR: Record<string, string> = {
  messaging: "messagerie",
  iot: "iot",
  automation: "automatisation",
  data: "données",
  remote: "accès distant",
  tools: "outils",
};

/** Containers can only list the containers: GET on a single path. */
const PROXY_PATH = "/apex/containers";

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const repo = (image = "") => image.replace(/@.*$/, "").replace(/:[^/]*$/, "");
const linkPort = (url: string): number | null => {
  const m = /^[a-z]+:\/\/[^/:]+:(\d+)/i.exec(url);
  return m ? Number(m[1]) : null;
};

function portalData(apexIp: string, portal: PlannedRecipe, recipes: PlannedRecipe[], existing: ContainerInfo[]): PortalData {
  const catalog: PortalRecipe[] = RECIPES.filter((r) => r.id !== "portal").flatMap((recipe) => {
    const values = resolveValues(recipe);
    let built;
    try {
      built = recipe.build({ apexIp, values, all: { [recipe.id]: values } });
    } catch {
      return [];
    }
    return [
      {
        id: recipe.id,
        name: recipe.name,
        badge: recipe.badge,
        color: recipe.color,
        category: CATEGORY_FR[recipe.category] ?? recipe.category,
        summary: recipe.summary.fr,
        names: built.containers.map((c) => c.name),
        repos: [...new Set(built.containers.map((c) => repo(c.options.Image)))],
        links: built.links.map((l) => ({ label: l.label.fr, url: l.url, port: linkPort(l.url) })),
      },
    ];
  });

  const services = recipes.filter((r) => r.id !== "portal");
  const known = services.flatMap((r) =>
    r.links.map((l) => {
      const port = linkPort(l.url);
      const owner = r.containers.find((c) => port !== null && hostPorts(c.options).some((p) => p.port === port)) ?? r.containers.find((c) => !c.oneShot);
      return { label: l.label.fr, url: l.url, port, container: owner?.name };
    }),
  );
  const planned: PortalContainer[] = services.flatMap((r) =>
    r.containers
      .filter((c) => !c.oneShot)
      .map((c) => ({ name: c.name, image: c.options.Image, state: "running", hostPorts: hostPorts(c.options).map((p) => p.port) })),
  );
  const plannedNames = new Set(services.flatMap((r) => r.containers.map((c) => c.name)));
  const others = existing
    .filter((c) => !plannedNames.has(c.name))
    .map((c) => ({ name: c.name, image: c.image, state: c.state, hostPorts: c.hostPorts }));

  return {
    apexIp,
    self: portal.containers[0]!.name,
    generated: new Date().toISOString(),
    recipes: catalog,
    known,
    containers: [...planned, ...others],
  };
}

/**
 * Browser side of the portal. Serialized with Function.prototype.toString, so it must not
 * reference anything outside its own body. The APEX answer is parsed with the same tolerant
 * rules as src/apex/client.ts (parseContainers).
 */
function portalApp() {
  type Link = { label: string; url: string; port: number | null; container?: string };
  type Box = { name: string; image?: string; state?: string; hostPorts: number[] };
  type Recipe = { id: string; name: string; badge: string; color: string; category: string; summary: string; names: string[]; repos: string[]; links: Link[] };
  type Data = { apexIp: string; self: string; generated: string; recipes: Recipe[]; known: Link[]; containers: Box[] };
  type Card = { order: number; name: string; badge: string; color: string; category: string; summary: string; links: Link[]; ports: string[] };
  type Obj = Record<string, unknown>;

  const D: Data = JSON.parse(document.getElementById("portal-data")!.textContent!);
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  const repo = (image = "") => image.replace(/@.*$/, "").replace(/:[^/]*$/, "");
  const KEY = "apexpress-portal-auth";
  const store = {
    get: () => {
      try {
        return sessionStorage.getItem(KEY);
      } catch {
        return null;
      }
    },
    set: (v: string | null) => {
      try {
        if (v) sessionStorage.setItem(KEY, v);
        else sessionStorage.removeItem(KEY);
      } catch {
        /* storage blocked: credentials are asked again next time */
      }
    },
  };

  function cards(list: Box[]): Card[] {
    const out = new Map<string, Card>();
    for (const c of list) {
      if (c.name === D.self) continue;
      // One-shot init containers stay on the APEX once done: nothing to show for them.
      if (!c.hostPorts.length && !/running|restarting/.test(c.state ?? "")) continue;
      const r = D.recipes.find((x) => x.names.includes(c.name)) ?? D.recipes.find((x) => !!c.image && x.repos.includes(repo(c.image)));
      const key = r ? r.id : `c:${c.name}`;
      let card = out.get(key);
      if (!card) {
        card = {
          order: r ? D.recipes.indexOf(r) : 1000,
          name: r?.name ?? c.name,
          badge: r?.badge ?? c.name.slice(0, 2).toUpperCase(),
          color: r?.color ?? "#6a7682",
          category: r?.category ?? "conteneur",
          summary: r?.summary ?? c.image ?? "",
          links: [],
          ports: [],
        };
        out.set(key, card);
      }
      const target = card;
      const add = (l: Link) => {
        if (!target.links.some((x) => x.url === l.url)) target.links.push(l);
      };
      const known = D.known.filter((k) => k.container === c.name);
      for (const port of c.hostPorts) {
        card.ports.push(`${c.name}:${port}`);
        const hits = known.filter((l) => l.port === port);
        const defaults = r ? r.links.filter((l) => l.port === port) : [];
        if (hits.length) hits.forEach(add);
        else if (defaults.length) defaults.forEach(add);
        else if (!r) add({ label: `Port ${port}`, url: `http://${D.apexIp}:${port}`, port });
        else if (c.hostPorts.length === 1) {
          // Port changed from the recipe default: reuse its only web link on the real port.
          const web = r.links.filter((l) => l.port !== null && /^https?:/.test(l.url));
          if (web.length === 1) add({ ...web[0]!, url: web[0]!.url.replace(/:\d+/, `:${port}`), port });
        }
      }
      known.filter((l) => l.port === null).forEach(add);
      // Ports not readable from the APEX answer: fall back to the known or default links.
      if (!c.hostPorts.length) (known.length ? known : (r?.links ?? [])).forEach(add);
    }
    return [...out.values()].sort((a, b) => a.order - b.order);
  }

  function parse(data: unknown): Box[] {
    const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
    const pick = (o: Obj, ...keys: string[]) => {
      for (const k of keys) {
        const f = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase());
        if (f !== undefined && o[f] !== undefined && o[f] !== null) return o[f];
      }
      return undefined;
    };
    const deepFind = (v: unknown, re: RegExp, depth = 0): unknown => {
      if (depth > 5 || !v || typeof v !== "object") return undefined;
      for (const [k, x] of Object.entries(v)) if (re.test(k) && (typeof x === "string" || typeof x === "number")) return x;
      for (const x of Object.values(v)) {
        const found = deepFind(x, re, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    const portText = (v: unknown, out: Set<number>) => {
      for (const s of Array.isArray(v) ? v : [v]) {
        if (typeof s === "string") for (const m of s.matchAll(/:(\d+)->\d+\/(?:tcp|udp|sctp)/g)) out.add(Number(m[1]));
      }
    };
    const ports = (v: unknown, out: Set<number>, depth = 0) => {
      if (depth > 6 || !v || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v)) {
        if (/^(host-?port|hostport|public-?port|publicport)$/i.test(k)) {
          const n = Number(x);
          if (Number.isInteger(n) && n > 0) out.add(n);
        } else if (/ports?$/i.test(k) && (typeof x === "string" || (Array.isArray(x) && x.some((y) => typeof y === "string")))) {
          portText(x, out);
        } else ports(x, out, depth + 1);
      }
    };
    if (isObj(data)) {
      for (const k of ["containers", "items", "data", "results"]) {
        if (data[k] && typeof data[k] === "object") {
          data = data[k];
          break;
        }
      }
    }
    const entries: [string | undefined, Obj][] = Array.isArray(data)
      ? data.filter(isObj).map((e) => [undefined, e])
      : isObj(data)
        ? Object.entries(data).map(([k, v]) => [k, isObj(v) ? v : { value: v }])
        : [];
    const out: Box[] = [];
    for (const [key, e] of entries) {
      const names = pick(e, "Names");
      const name = String(pick(e, "key", "name", "container-name", "Name") ?? (Array.isArray(names) ? names[0] : undefined) ?? key ?? "").replace(/^\//, "");
      if (!name) continue;
      let state: unknown = pick(e, "state", "State");
      if (isObj(state)) state = pick(state, "Status", "status");
      if (state === undefined) state = deepFind(e, /^state$/i);
      const image = pick(e, "image", "Image");
      const found = new Set<number>();
      ports(e, found);
      out.push({ name, image: typeof image === "string" ? image : undefined, state: typeof state === "string" ? state.toLowerCase() : undefined, hostPorts: [...found] });
    }
    return out;
  }

  function render() {
    const list = cards(D.containers);
    const count = `${list.length} service${list.length > 1 ? "s" : ""}`;
    $("count").textContent = count;
    $("count-sec").textContent = `— ${count}`;
    $("grid").innerHTML =
      list
        .map((c) => {
          const links = c.links
            .map((l) => (/^https?:/.test(l.url) ? `<a href="${esc(l.url)}">${esc(l.label)} <i>→</i></a>` : `<code>${esc(l.url)}</code>`))
            .join("");
          const ports = c.ports.map((p) => `<span>${esc(p)}</span>`).join("");
          return `<article style="--c:${esc(c.color)}"><header><b class="badge">${esc(c.badge)}</b><div><div class="cat">// ${esc(c.category)}</div><h2>${esc(c.name)}</h2></div></header><p>${esc(c.summary)}</p><div class="links">${links}</div><div class="ports">${ports}</div></article>`;
        })
        .join("") || `<div class="empty">// aucun service installé pour l'instant</div>`;
  }

  const status = (text: string, error = false) => {
    const el = $("status");
    el.textContent = text;
    el.className = error ? "sub status error" : "sub status";
  };
  const showLogin = (show: boolean) => {
    $("login").hidden = !show;
    if (show) $<HTMLInputElement>("user").focus();
  };

  async function refresh() {
    const auth = store.get();
    if (!auth) return showLogin(true);
    const button = $<HTMLButtonElement>("refresh");
    button.disabled = true;
    status("// interrogation de l'APEX…");
    try {
      const res = await fetch("/apex/containers", { headers: { Authorization: auth, Accept: "application/json" }, cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        store.set(null);
        showLogin(true);
        return status("// identifiants refusés par l'APEX", true);
      }
      if (!res.ok) return status(`// l'APEX a répondu HTTP ${res.status}`, true);
      D.containers = parse(await res.json());
      render();
      showLogin(false);
      status(`// actualisé à ${new Date().toLocaleTimeString("fr-FR")} · liste lue sur l'APEX`);
    } catch {
      status("// APEX injoignable depuis le portail", true);
    } finally {
      button.disabled = false;
    }
  }

  $("refresh").addEventListener("click", () => void refresh());
  $("login").addEventListener("submit", (e) => {
    e.preventDefault();
    const user = $<HTMLInputElement>("user").value;
    const pass = $<HTMLInputElement>("pass").value;
    const bytes = new TextEncoder().encode(`${user}:${pass}`);
    store.set(`Basic ${btoa(String.fromCharCode(...bytes))}`);
    $<HTMLInputElement>("pass").value = "";
    void refresh();
  });
  render();
  status(`// généré le ${new Date(D.generated).toLocaleString("fr-FR")} · « actualiser » relit l'APEX`);
  if (store.get()) void refresh();
}

const STYLE = `
:root{--bg:#07090a;--card:#0d1113;--fg:#eef3f7;--soft:#b3bfc8;--dim:#6a7682;--line:#1a2024;--line-soft:#14181c;--line-strong:#2a333a;--primary:#6ce26c;--glow:rgba(108,226,108,.16);--amber:#f5b94a;--amber-dim:#c8932e;--red:#f47174}
@media (prefers-color-scheme:light){:root{--bg:#f7f7f5;--card:#fff;--fg:#0a0d10;--soft:#485058;--dim:#8a8d8a;--line:#e0e0db;--line-soft:#ebebe6;--line-strong:#c0c0b9;--primary:#2a8a2a;--glow:rgba(42,138,42,.1);--amber:#b07418;--amber-dim:#8a5a10;--red:#c0413f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:"IBM Plex Sans","IBM Plex Sans Variable",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
nav,.sub,.cat,h2,.links,.ports,footer,.sec,button,input,.badge{font-family:"JetBrains Mono","JetBrains Mono Variable","Cascadia Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}
nav{border-bottom:1px solid var(--line);font-size:13px}
nav>div{max-width:1024px;margin:0 auto;padding:12px 20px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;color:var(--dim)}
nav .right{display:flex;align-items:center;gap:14px}
.brand{color:var(--fg);font-weight:600}.brand .sl{color:var(--dim)}.brand b{color:var(--primary)}
.cur{display:inline-block;width:.6em;height:1.05em;background:var(--primary);vertical-align:-2px;margin-left:2px;animation:blink 1.1s steps(2) infinite}
@keyframes blink{50%{opacity:0}}
button{cursor:pointer;font-size:12.5px;color:var(--primary);background:var(--glow);border:1px solid color-mix(in srgb,var(--primary) 40%,transparent);border-radius:3px;padding:5px 11px;transition:border-color .15s,background .15s}
button:hover{border-color:var(--primary)}button:disabled{opacity:.55;cursor:progress}
main{max-width:1024px;margin:0 auto;padding:56px 20px 32px}
h1{margin:0 0 10px;font-size:clamp(30px,5vw,44px);font-weight:700;letter-spacing:-.02em}
.sub{margin:0;color:var(--soft);font-size:13px}.sub b{color:var(--primary);font-weight:500}
.status{margin-top:6px;color:var(--dim)}.status.error{color:var(--red)}
form{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 12px;margin-top:20px;padding:16px;border:1px solid var(--line);border-left:2px solid var(--amber);background:color-mix(in srgb,var(--card) 60%,transparent)}
form[hidden]{display:none}
form label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--amber-dim);font-family:"JetBrains Mono","Cascadia Mono",ui-monospace,Consolas,monospace}
input{font-size:13px;color:var(--fg);background:var(--bg);border:1px solid var(--line-strong);border-radius:3px;padding:6px 9px;width:190px;max-width:100%}
input:focus{outline:none;border-color:var(--primary)}
form small{flex-basis:100%;color:var(--dim);font-size:11.5px;font-family:"JetBrains Mono","Cascadia Mono",ui-monospace,Consolas,monospace}
.sec{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:44px 0 0;padding-bottom:14px;border-bottom:1px solid var(--line);font-size:13px;color:var(--dim)}
.sec span:first-child{color:var(--amber)}.sec strong{font-family:"IBM Plex Sans",system-ui,sans-serif;font-size:22px;color:var(--fg);letter-spacing:-.015em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));border-left:1px solid var(--line);border-top:1px solid var(--line)}
article{position:relative;background:color-mix(in srgb,var(--card) 40%,transparent);border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:22px 22px 20px;transition:background .15s}
article::before{content:"";position:absolute;inset:0 0 auto;height:2px;background:var(--c);transform:scaleX(0);transform-origin:left;transition:transform .2s}
article:hover{background:var(--card)}article:hover::before{transform:scaleX(1)}
.cat{color:var(--amber-dim);font-size:11px;letter-spacing:.05em;margin-bottom:3px}
header{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.badge{flex-shrink:0;display:grid;place-items:center;width:38px;height:38px;border-radius:4px;background:var(--c);color:#fff;font-size:13px;font-weight:700;letter-spacing:.02em;box-shadow:0 0 0 1px color-mix(in srgb,var(--c) 40%,transparent),0 0 18px color-mix(in srgb,var(--c) 25%,transparent)}
h2{margin:0;font-size:19px;font-weight:700;letter-spacing:-.01em}
p{margin:0 0 16px;color:var(--soft);font-size:14.5px;line-height:1.55}
.links{display:flex;flex-direction:column;align-items:flex-start;gap:8px;font-size:12.5px}
.links a{color:var(--primary);text-decoration:none;border-bottom:1px solid var(--line-strong);padding-bottom:1px;transition:border-color .15s}
.links a i{font-style:normal;display:inline-block;transition:transform .15s}.links a:hover{border-color:var(--primary)}.links a:hover i{transform:translateX(4px)}
.links code{color:var(--soft);background:var(--glow);border:1px solid var(--line-strong);border-radius:3px;padding:2px 7px;font-family:inherit}
.ports{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px;font-size:11px}
.ports span{color:var(--dim);border:1px solid var(--line-soft);border-radius:2px;padding:1px 6px}
.empty{padding:28px 22px;color:var(--dim);border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-family:"JetBrains Mono","Cascadia Mono",ui-monospace,Consolas,monospace;font-size:13px}
footer{border-top:1px solid var(--line);margin-top:56px;font-size:12px;color:var(--dim)}
footer div{max-width:1024px;margin:0 auto;padding:14px 20px;display:flex;flex-wrap:wrap;gap:8px 20px}
footer a{color:var(--soft);text-decoration:none;border-bottom:1px solid var(--line-strong)}footer a:hover{color:var(--primary);border-color:var(--primary)}
.dot{color:var(--primary)}
`;

function portalHtml(title: string, data: PortalData): string {
  const t = esc(title);
  const ip = esc(data.apexIp);
  // Same visual identity as opengtb.com: terminal look, JetBrains Mono + IBM Plex Sans, green/amber accents.
  // No web fonts: the APEX may have no Internet access, the stacks fall back to local fonts.
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title>
<style>${STYLE}</style></head><body>
<nav><div><span class="brand">apex<span class="sl">/</span><b>portail</b><span class="cur"></span></span><span class="right"><span>$ docker ps · <span id="count"></span></span><button id="refresh" type="button">↻ actualiser</button></span></div></nav>
<main>
<h1>${t}</h1>
<p class="sub">// conteneurs de l'automate <b>${ip}</b></p>
<p class="sub status" id="status"></p>
<form id="login" hidden autocomplete="on">
<label>utilisateur APEX<input id="user" name="username" autocomplete="username" required></label>
<label>mot de passe<input id="pass" name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">connexion</button>
<small>// lecture seule : la liste des conteneurs est relue sur l'APEX. Identifiants gardés dans cet onglet uniquement, jamais sur l'automate.</small>
</form>
<div class="sec"><span>§ 01</span><strong>Services</strong><span id="count-sec"></span></div>
<div class="grid" id="grid"></div>
</main>
<footer><div><span><span class="dot">●</span> ECLYPSE APEX ${ip}</span><a href="https://${ip}">ECLYPSE Facilities ↗</a><span>déployé avec open apexpress · opengtb</span></div></footer>
<script type="application/json" id="portal-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>(${portalApp.toString()})();</script>
</body></html>`;
}

/** nginx: the page, plus a GET-only proxy to the APEX container list (credentials come from the browser). */
function nginxConf(apexIp: string): string {
  return `server {
  listen 80;
  root /usr/share/nginx/html;
  location / {
    try_files $uri /index.html;
    add_header Cache-Control "no-store";
  }
  location = ${PROXY_PATH} {
    limit_except GET { deny all; }
    proxy_pass https://${apexIp}${API_BASE}/services/containerization/containers;
    proxy_ssl_verify off;
    proxy_hide_header WWW-Authenticate;
    proxy_connect_timeout 5s;
    proxy_read_timeout 20s;
  }
}`;
}

export function fillPortal(
  apexIp: string,
  portal: PlannedRecipe,
  recipes: PlannedRecipe[],
  values: Record<string, ParamValue>,
  existing: ContainerInfo[],
) {
  const data = portalData(apexIp, portal, recipes, existing);
  const c = portal.containers[0]!;
  c.options = container({
    image: String(values.image),
    entrypoint: ["sh", "-c"],
    cmd: [
      [
        writeFile("/usr/share/nginx/html/index.html", portalHtml(String(values.title || "ECLYPSE APEX"), data)),
        writeFile("/etc/nginx/conf.d/default.conf", nginxConf(apexIp)),
        "exec nginx -g 'daemon off;'",
      ].join(" && "),
    ],
    ports: [{ container: "80/tcp", host: Number(values.hostPort) }],
  });
  c.issues = lintContainer(c.name, c.options);
}
