import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { Badge, Button, CopyButton, useT } from "../components";

interface Exchange {
  method: string;
  path: string;
  status: number | "error";
  ms: number;
  request?: unknown;
  response?: string;
}

export function JournalView() {
  const { t } = useT();
  const [items, setItems] = useState<Exchange[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const load = () => api<Exchange[]>("GET", "/api/journal").then(setItems).catch(() => undefined);
  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);
  const text = items.map((e) => `${e.method} ${e.path} → ${e.status} (${e.ms} ms)\n${e.request ? `> ${JSON.stringify(e.request)}\n` : ""}< ${e.response ?? ""}`).join("\n\n");
  return (
    <div class="journal">
      <div class="page-head">
        <div>
          <h2>{t("journal.title")}</h2>
          <p class="muted">{t("journal.help")}</p>
        </div>
        <div class="row-actions">
          <Button icon="restart" onClick={load} />
          <CopyButton text={text} label size="md" />
        </div>
      </div>
      <section class="card table-card">
        {items.length === 0 ? (
          <p class="muted empty">{t("journal.empty")}</p>
        ) : (
          <ul class="exchanges">
            {[...items].reverse().map((e, i) => (
              <li>
                <button type="button" class="exchange" onClick={() => setOpen(open === i ? null : i)}>
                  <Badge tone={e.status === "error" || (typeof e.status === "number" && e.status >= 400) ? "error" : "success"}>{String(e.status)}</Badge>
                  <b>{e.method}</b>
                  <code>{e.path}</code>
                  <span class="muted small">{e.ms} ms</span>
                </button>
                {open === i && (
                  <div class="exchange-body">
                    {e.request !== undefined && <pre class="code">{JSON.stringify(e.request, null, 2)}</pre>}
                    <pre class="code">{e.response || "∅"}</pre>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
