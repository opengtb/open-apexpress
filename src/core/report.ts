import { hostPorts } from "../apex/opa";
import type { Lang } from "../recipes/types";
import { VERSION } from "../version";
import type { Plan } from "./planner";
import type { RunEvent } from "./runner";

const T = {
  fr: {
    title: "Rapport de déploiement Open Apexpress",
    confidential: "Document confidentiel : il contient des mots de passe. Rangez-le en lieu sûr.",
    demo: "Déploiement sur l'APEX de démonstration (simulé).",
    apex: "APEX",
    date: "Date",
    result: "Résultat",
    services: "Services",
    links: "Accès",
    credentials: "Identifiants",
    notes: "À savoir",
    containers: "Conteneurs",
    name: "Nom",
    image: "Image",
    ports: "Ports APEX",
    status: "Statut",
    json: "Options de création (pour Facilities → Conteneurs → Container Create Options)",
    st: { ok: "✅ OK", warning: "⚠️ À vérifier", error: "❌ Erreur", skipped: "⏭️ Conservé / ignoré", pending: "—" },
  },
  en: {
    title: "Open Apexpress deployment report",
    confidential: "Confidential document: it contains passwords. Keep it somewhere safe.",
    demo: "Deployment on the demo APEX (simulated).",
    apex: "APEX",
    date: "Date",
    result: "Result",
    services: "Services",
    links: "Access",
    credentials: "Credentials",
    notes: "Good to know",
    containers: "Containers",
    name: "Name",
    image: "Image",
    ports: "APEX ports",
    status: "Status",
    json: "Create options (for Facilities → Containers → Container Create Options)",
    st: { ok: "✅ OK", warning: "⚠️ Check", error: "❌ Error", skipped: "⏭️ Kept / skipped", pending: "—" },
  },
};

export function renderReport(plan: Plan, events: RunEvent[], lang: Lang, demo: boolean): string {
  const t = T[lang];
  const final = new Map<string, { status: string; message?: string }>();
  for (const e of events) {
    if (e.type === "step" && e.phase === "done") final.set(e.container, { status: e.status, message: e.message?.[lang] });
  }
  const done = events.find((e) => e.type === "done") as Extract<RunEvent, { type: "done" }> | undefined;
  const out: string[] = [
    `# ${t.title}`,
    "",
    `> ${t.confidential}`,
    "",
    `- **${t.apex}** : ${plan.apexIp}`,
    `- **${t.date}** : ${new Date().toLocaleString(lang === "fr" ? "fr-FR" : "en-GB")}`,
    `- **Open Apexpress** : v${VERSION}`,
  ];
  if (done) out.push(`- **${t.result}** : ${Object.entries(done.counts).map(([k, v]) => `${t.st[k as keyof typeof t.st]} ${v}`).join(" · ")}`);
  if (demo) out.push("", `> ${t.demo}`);

  out.push("", `## ${t.services}`);
  for (const r of plan.recipes) {
    out.push("", `### ${r.name}`);
    if (r.links.length) {
      out.push("", `**${t.links}**`, "");
      for (const l of r.links) out.push(`- ${l.label[lang]} : ${l.url}`);
    }
    if (r.credentials.length) {
      out.push("", `**${t.credentials}**`, "");
      for (const c of r.credentials) out.push(`- ${c.label[lang]} : \`${c.value}\``);
    }
    if (r.notes.length) {
      out.push("", `**${t.notes}**`, "");
      for (const n of r.notes) out.push(`- ${n[lang]}`);
    }
  }

  out.push("", `## ${t.containers}`, "", `| ${t.name} | ${t.image} | ${t.ports} | ${t.status} |`, "|---|---|---|---|");
  for (const c of plan.containers) {
    const f = final.get(c.name);
    const status = f ? t.st[f.status as keyof typeof t.st] ?? f.status : t.st.pending;
    const ports = hostPorts(c.options).map((p) => `${p.port} → ${p.containerPort}`).join(", ") || "—";
    out.push(`| ${c.name} | \`${c.options.Image}\` | ${ports} | ${status}${f?.message ? ` ${f.message.replace(/\|/g, "/")}` : ""} |`);
  }

  out.push("", `## ${t.json}`);
  for (const c of plan.containers) {
    out.push("", `### ${c.name}`, "", "```json", JSON.stringify(c.options, null, 2), "```");
  }
  return out.join("\n") + "\n";
}
