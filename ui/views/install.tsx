import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, deployEvents, reportUrl, type Plan, type Recipe } from "../api";
import { Alert, Badge, Button, Confirm, Icon, Secret, Spinner, Troubleshooting, useT } from "../components";
import type { Key, L10n } from "../i18n";

type Status = "running" | "ok" | "warning" | "error" | "skipped";
interface StepEvent {
  type: "step";
  container: string;
  phase: string;
  status: Status;
  message?: L10n;
}
interface DoneEvent {
  type: "done";
  ok: boolean;
  cancelled: boolean;
  counts: Record<"ok" | "warning" | "error" | "skipped", number>;
  seconds: number;
}
type AnyEvent = StepEvent | DoneEvent | { type: "start"; total: number } | { type: "log"; level: string; message: L10n };

const PHASES = ["remove", "pull", "create", "start", "wait", "check", "cleanup"] as const;

function StatusIcon({ status }: { status?: Status }) {
  if (status === "running") return <Spinner size={14} />;
  if (status === "ok") return <Icon name="check" size={14} class="ok" />;
  if (status === "warning") return <Icon name="alert" size={14} class="warn" />;
  if (status === "error") return <Icon name="x" size={14} class="err" />;
  if (status === "skipped") return <Icon name="chevronRight" size={14} class="muted" />;
  return <span class="dot" />;
}

export function InstallView({ plan, recipes, onAgain, onBack, onFinished }: { plan: Plan; recipes: Recipe[]; onAgain: () => void; onBack: () => void; onFinished: () => void }) {
  const { t, l, lang } = useT();
  const [events, setEvents] = useState<AnyEvent[]>([]);
  const [ended, setEnded] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [now, setNow] = useState(Date.now());
  const started = useRef(Date.now());
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = deployEvents(
      (e) => setEvents((prev) => [...prev, e]),
      () => {
        setEnded(true);
        onFinished();
      },
    );
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      close();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events.length]);

  const state = useMemo(() => {
    const byContainer = new Map<string, { phases: Record<string, Status>; final?: Status; message?: L10n; current?: string }>();
    for (const c of plan.containers) byContainer.set(c.name, { phases: {} });
    for (const e of events) {
      if (e.type !== "step") continue;
      const s = byContainer.get(e.container) ?? { phases: {} };
      if (e.phase === "done") {
        s.final = e.status;
        s.message = e.message;
      } else {
        s.phases[e.phase] = e.status;
        s.current = e.phase;
        if (e.message) s.message = e.message;
      }
      byContainer.set(e.container, s);
    }
    return byContainer;
  }, [events]);

  const done = events.find((e) => e.type === "done") as DoneEvent | undefined;
  const troubled = new Set([...state].filter(([, s]) => s.final === "warning" || s.final === "error").map(([name]) => name));
  const finishedCount = [...state.values()].filter((s) => s.final).length;
  const pct = Math.round((finishedCount / Math.max(1, plan.containers.length)) * 100);
  const pulling = [...state.values()].some((s) => s.phases.pull === "running");
  const title = !done
    ? t("install.title")
    : done.cancelled
      ? t("install.titleCancelled")
      : done.ok
        ? t("install.titleDone")
        : t("install.titleFailed");

  const logLines = events.flatMap((e) => {
    if (e.type === "step" && e.message) return [{ level: e.status === "error" ? "error" : e.status === "warning" ? "warning" : "info", text: `${e.container} · ${l(e.message)}` }];
    if (e.type === "log" && e.message[lang]) return [{ level: e.level, text: l(e.message) }];
    return [];
  });

  return (
    <div class="install">
      <section class={`card install-head ${done ? (done.ok ? "is-ok" : "is-error") : ""}`}>
        <div class="install-title">
          {!done ? <Spinner size={22} /> : <Icon name={done.ok ? "check" : done.cancelled ? "stop" : "alert"} size={24} />}
          <div>
            <h2>{title}</h2>
            <p class="muted">
              {done
                ? `${t("install.summary", done.counts)} · ${t("install.elapsed", { s: done.seconds })}`
                : `${finishedCount} / ${plan.containers.length} · ${Math.round((now - started.current) / 1000)} s`}
            </p>
          </div>
          <div class="spacer" />
          {!done && !ended && (
            <Button variant="ghost" icon="stop" onClick={() => setConfirmCancel(true)}>
              {t("install.cancel")}
            </Button>
          )}
        </div>
        <div class="progress">
          <div class="progress-fill" style={{ width: `${done ? 100 : pct}%` }} />
        </div>
        {pulling && !done && <p class="muted small">{t("install.pullHint")}</p>}
      </section>

      <section class="card">
        <ul class="steps-list">
          {plan.containers.map((c) => {
            const s = state.get(c.name)!;
            const phases = PHASES.filter((p) => s.phases[p] || (p === "pull" && c.action !== "keep") || p === "create" || p === "start" || (p === "check" && !c.oneShot) || (p === "wait" && c.oneShot));
            return (
              <li class={`step-row ${s.final ?? (s.current ? "running" : "pending")}`}>
                <div class="step-name">
                  <StatusIcon status={s.final ?? (s.current ? "running" : undefined)} />
                  <b>{c.name}</b>
                  <code>{c.options.Image}</code>
                </div>
                <div class="step-phases">
                  {c.action === "keep" ? (
                    <Badge tone="neutral">{t("action.keep")}</Badge>
                  ) : (
                    phases.map((p) => (
                      <span class={`phase phase-${s.phases[p] ?? "todo"}`}>
                        {s.phases[p] === "running" ? <Spinner size={10} /> : null}
                        {t(`install.phase.${p}` as Key)}
                      </span>
                    ))
                  )}
                </div>
                {s.message && (s.final === "error" || s.final === "warning") && <p class={`step-msg ${s.final}`}>{l(s.message)}</p>}
              </li>
            );
          })}
        </ul>
      </section>

      {done && (
        <>
          <section>
            <h3 class="section-title">{t("install.services")}</h3>
            <div class="services">
              {plan.recipes.map((r) => (
                <div class="card service">
                  <h4>{r.name}</h4>
                  {r.links.map((lnk) =>
                    lnk.url.startsWith("http") ? (
                      <a class="service-link" href={lnk.url} target="_blank" rel="noreferrer">
                        <Icon name="external" size={14} /> {l(lnk.label)} <span class="muted">{lnk.url}</span>
                      </a>
                    ) : (
                      <div class="service-link">
                        <Icon name="globe" size={14} /> {l(lnk.label)} <code>{lnk.url}</code>
                      </div>
                    ),
                  )}
                  {r.credentials.length > 0 && (
                    <div class="creds">
                      {r.credentials.map((c) => (
                        <div class="cred">
                          <span>{l(c.label)}</span>
                          <Secret value={c.value} />
                        </div>
                      ))}
                    </div>
                  )}
                  {r.notes.length > 0 && (
                    <ul class="notes">
                      {r.notes.map((n) => (
                        <li>{l(n)}</li>
                      ))}
                    </ul>
                  )}
                  <Troubleshooting items={recipes.find((x) => x.id === r.id)?.troubleshooting} open={r.containers.some((c) => troubled.has(c.name))} />
                </div>
              ))}
            </div>
          </section>
          <section class="card actions-row">
            <div>
              <b>{t("install.report")}</b>
              <p class="muted small">{t("install.reportHelp")}</p>
            </div>
            <div class="spacer" />
            <a class="btn btn-secondary btn-md" href={reportUrl(lang)} download>
              <Icon name="download" /> <span>{t("install.report")}</span>
            </a>
            {!done.ok && (
              <Button icon="sliders" onClick={onBack}>
                {t("install.retry")}
              </Button>
            )}
            <Button variant="primary" icon="layers" onClick={onAgain}>
              {t("install.again")}
            </Button>
          </section>
        </>
      )}

      <section class="card">
        <h3 class="section-title">{t("install.log")}</h3>
        <div class="log" ref={logRef}>
          {logLines.map((line) => (
            <div class={`log-line ${line.level}`}>{line.text}</div>
          ))}
        </div>
      </section>

      {confirmCancel && (
        <Confirm
          message={t("install.cancelConfirm")}
          danger
          onCancel={() => setConfirmCancel(false)}
          onConfirm={() => {
            setConfirmCancel(false);
            api("POST", "/api/deploy/cancel").catch(() => undefined);
          }}
        />
      )}
      {done && !done.ok && !done.cancelled && <Alert tone="warning">{lang === "fr" ? "Consultez l'onglet Journal pour le détail des échanges avec l'APEX." : "See the Log tab for the details of the exchanges with the APEX."}</Alert>}
    </div>
  );
}
