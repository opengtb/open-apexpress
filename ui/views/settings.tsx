import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, type Param, type ParamValue, type Plan, type PlannedContainer, type Recipe } from "../api";
import { Alert, Badge, Button, Confirm, CopyButton, Field, Icon, Modal, PasswordInput, RamGauge, RecipeLogo, Spinner, Troubleshooting, useT } from "../components";
import type { Key, L10n } from "../i18n";
import { STATUS_TONE } from "./catalog";

export type Values = Record<string, Record<string, ParamValue>>;

function ParamInput({ rid, p, value, onChange, generated }: { rid: string; p: Param; value: ParamValue | undefined; onChange: (v: ParamValue) => void; generated: boolean }) {
  const { t, l } = useT();
  const id = `p-${rid}-${p.id}`;
  const v = value ?? p.default ?? "";
  let input;
  switch (p.type) {
    case "boolean":
      return (
        <label class="switch-field">
          <input type="checkbox" checked={v === true} onChange={(e) => onChange(e.currentTarget.checked)} />
          <span class="switch" />
          <span>
            <b>{l(p.label)}</b>
            {p.help && <small class="help">{l(p.help)}</small>}
          </span>
        </label>
      );
    case "select":
      input = (
        <select id={id} value={String(v)} onChange={(e) => onChange(e.currentTarget.value)}>
          {p.options!.map((o) => (
            <option value={o.value}>{l(o.label)}</option>
          ))}
        </select>
      );
      break;
    case "password":
      input = <PasswordInput id={id} value={String(v)} onInput={onChange} placeholder={p.placeholder} />;
      break;
    case "textarea":
      input = <textarea id={id} rows={3} value={String(v)} placeholder={p.placeholder} onInput={(e) => onChange(e.currentTarget.value)} />;
      break;
    case "number":
      input = <input id={id} type="number" value={String(v)} placeholder={p.placeholder} onInput={(e) => onChange(e.currentTarget.value === "" ? "" : Number(e.currentTarget.value))} />;
      break;
    default:
      input = <input id={id} value={String(v)} placeholder={p.placeholder} onInput={(e) => onChange(e.currentTarget.value)} />;
  }
  return (
    <Field
      label={
        <>
          {l(p.label)}
          {generated && (
            <span class="gen" title={t("settings.generated")}>
              <Icon name="zap" size={12} /> {t("settings.generated")}
            </span>
          )}
        </>
      }
      help={p.help && l(p.help)}
      htmlFor={id}
      required={p.required}
    >
      {input}
    </Field>
  );
}

/** Zigbee2MQTT: checks the network coordinator from this PC and detects its adapter type. */
function ZigbeeProbe({ values, setValue, running }: { values: Record<string, ParamValue>; setValue: (pid: string, v: ParamValue) => void; running: boolean }) {
  const { t, l } = useT();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detected?: string; message: L10n } | null>(null);
  const host = String(values.coordinatorHost ?? "").trim();
  const adapter = String(values.adapter ?? "ember");
  const run = async () => {
    setConfirm(false);
    setBusy(true);
    setResult(null);
    try {
      setResult(await api("POST", "/api/tools/zigbee-probe", { host, port: Number(values.coordinatorPort ?? 6638) }));
    } catch (e) {
      setResult({ ok: false, message: e instanceof ApiError ? e.l10n : { fr: String(e), en: String(e) } });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="probe">
      <div class="probe-row">
        <Button icon="zap" loading={busy} disabled={!host} title={host ? undefined : t("probe.missing")} onClick={() => (running ? setConfirm(true) : run())}>
          {t("probe.button")}
        </Button>
        <span class="muted small">{t("probe.note")}</span>
      </div>
      {result && (
        <Alert tone={result.ok ? "success" : "error"}>
          {l(result.message)}
          {result.detected && result.detected !== adapter && (
            <div class="mt">
              <Button size="sm" variant="primary" onClick={() => setValue("adapter", result.detected!)}>
                {t("probe.use", { adapter: result.detected })}
              </Button>
            </div>
          )}
        </Alert>
      )}
      {confirm && <Confirm message={t("probe.confirm")} onCancel={() => setConfirm(false)} onConfirm={run} />}
    </div>
  );
}

function RecipeForm({
  recipe,
  values,
  setValue,
  autoAdded,
  generated,
  installed,
}: {
  recipe: Recipe;
  values: Record<string, ParamValue>;
  setValue: (pid: string, v: ParamValue) => void;
  autoAdded: boolean;
  generated: Set<string>;
  installed: Set<string>;
}) {
  const { t, l } = useT();
  const [open, setOpen] = useState(false);
  const basic = recipe.params.filter((p) => !p.advanced);
  const advanced = recipe.params.filter((p) => p.advanced);
  return (
    <section class="card recipe-form">
      <header>
        <RecipeLogo badge={recipe.badge} color={recipe.color} size={34} />
        <div>
          <h3>{recipe.name}</h3>
          <p class="muted small">{l(recipe.summary)}</p>
        </div>
        <div class="spacer" />
        {autoAdded && <Badge tone="info">{t("settings.autoAdded")}</Badge>}
        <Badge tone={STATUS_TONE[recipe.status]} title={t(`status.${recipe.status}.help` as Key)}>
          {t(`status.${recipe.status}` as Key)}
        </Badge>
      </header>
      {basic.length > 0 && (
        <div class="form-grid">
          {basic.map((p) => (
            <ParamInput rid={recipe.id} p={p} value={values[p.id]} onChange={(v) => setValue(p.id, v)} generated={generated.has(p.id)} />
          ))}
        </div>
      )}
      {advanced.length > 0 && (
        <>
          <button type="button" class="link-btn" onClick={() => setOpen(!open)}>
            <Icon name={open ? "chevronDown" : "chevronRight"} size={14} /> {t("settings.advanced")} ({advanced.length})
          </button>
          {open && (
            <div class="form-grid">
              {advanced.map((p) => (
                <ParamInput rid={recipe.id} p={p} value={values[p.id]} onChange={(v) => setValue(p.id, v)} generated={generated.has(p.id)} />
              ))}
            </div>
          )}
        </>
      )}
      {recipe.id === "zigbee2mqtt" && (
        <ZigbeeProbe values={values} setValue={setValue} running={installed.has(String(values.name ?? recipe.params.find((p) => p.id === "name")?.default ?? ""))} />
      )}
      <Troubleshooting items={recipe.troubleshooting} />
    </section>
  );
}

function JsonModal({ c, onClose }: { c: PlannedContainer; onClose: () => void }) {
  const { t, l } = useT();
  const text = JSON.stringify(c.options, null, 2);
  return (
    <Modal title={c.name} onClose={onClose} wide footer={<CopyButton text={text} label size="md" />}>
      {c.description && <p class="muted">{l(c.description)}</p>}
      {c.issues.map((i) => (
        <Alert tone={i.level === "error" ? "error" : "warning"}>{l(i.message)}</Alert>
      ))}
      <pre class="code">{text}</pre>
      <p class="muted small">{t("settings.copyJson")} → Facilities → Container Create Options</p>
    </Modal>
  );
}

export function PlanPanel({ plan, loading, error }: { plan: Plan | null; loading: boolean; error: L10n | null }) {
  const { t, l } = useT();
  const [json, setJson] = useState<PlannedContainer | null>(null);
  if (error) return <Alert tone="error">{l(error)}</Alert>;
  if (!plan) return <p class="muted">{loading ? t("common.loading") : t("settings.planEmpty")}</p>;
  const general = plan.issues.filter((i) => !i.container);
  return (
    <div class="plan">
      {general.map((i) => (
        <Alert tone={i.level === "error" ? "error" : "warning"}>{l(i.message)}</Alert>
      ))}
      <ol class="plan-list">
        {plan.containers.map((c, idx) => {
          const errors = c.issues.filter((i) => i.level === "error");
          const warnings = c.issues.filter((i) => i.level === "warning");
          return (
            <li class={errors.length ? "has-error" : ""}>
              <span class="plan-idx">{idx + 1}</span>
              <div class="plan-main">
                <div class="plan-name">
                  <b>{c.name}</b>
                  <Badge tone={c.action === "keep" ? "neutral" : c.action === "replace" ? "warning" : "success"}>{t(`action.${c.action}` as Key)}</Badge>
                  {c.oneShot && <Badge tone="neutral">{t("settings.oneShot")}</Badge>}
                </div>
                <code class="plan-image">{c.options.Image}</code>
                {[...errors, ...warnings].map((i) => (
                  <p class={`plan-issue ${i.level}`}>
                    <Icon name="alert" size={13} /> {l(i.message)}
                  </p>
                ))}
              </div>
              <Button size="sm" variant="ghost" icon="code" onClick={() => setJson(c)} title={t("settings.viewJson")} />
            </li>
          );
        })}
      </ol>
      {json && <JsonModal c={json} onClose={() => setJson(null)} />}
    </div>
  );
}

export function SettingsView({
  recipes,
  selected,
  values,
  setValues,
  onExisting,
  setOnExisting,
  onBack,
  onDeployed,
  installed,
}: {
  installed: Set<string>;
  recipes: Recipe[];
  selected: Set<string>;
  values: Values;
  setValues: (v: Values) => void;
  onExisting: "keep" | "replace";
  setOnExisting: (v: "keep" | "replace") => void;
  onBack: () => void;
  onDeployed: (plan: Plan) => void;
}) {
  const { t, l, lang } = useT();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<L10n | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [generated, setGenerated] = useState<Record<string, Set<string>>>({});
  const seq = useRef(0);
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const selection = () => Object.fromEntries([...selected].map((id) => [id, values[id] ?? {}]));

  // Recompute the plan (debounced) whenever the selection or a value changes.
  useEffect(() => {
    const n = ++seq.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const p = await api<Plan>("POST", "/api/plan", { selection: selection(), onExisting });
        if (n !== seq.current) return;
        setError(null);
        setPlan(p);
        // Keep generated secrets and dependency defaults stable from now on.
        const next: Values = { ...valuesRef.current };
        const gen: Record<string, Set<string>> = { ...generated };
        let changed = false;
        for (const r of p.recipes) {
          const recipe = recipes.find((x) => x.id === r.id)!;
          const cur = { ...(next[r.id] ?? {}) };
          for (const param of recipe.params) {
            if (param.generate && (cur[param.id] === undefined || cur[param.id] === "")) {
              cur[param.id] = r.values[param.id]!;
              gen[r.id] = new Set([...(gen[r.id] ?? []), param.id]);
              changed = true;
            }
          }
          next[r.id] = cur;
        }
        if (changed) {
          setGenerated(gen);
          setValues(next);
        }
      } catch (e) {
        if (n === seq.current) setError(e instanceof ApiError ? e.l10n : { fr: String(e), en: String(e) });
      } finally {
        if (n === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [JSON.stringify(selection()), onExisting]);

  const deploy = async () => {
    setDeploying(true);
    setError(null);
    try {
      const r = await api<{ plan: Plan }>("POST", "/api/deploy", { selection: selection(), onExisting });
      onDeployed(r.plan);
    } catch (e) {
      if (e instanceof ApiError && e.data?.plan) setPlan(e.data.plan);
      setError(e instanceof ApiError ? e.l10n : { fr: String(e), en: String(e) });
    } finally {
      setDeploying(false);
    }
  };

  const ordered = plan ? plan.recipes.map((r) => ({ id: r.id, autoAdded: r.autoAdded })) : [...selected].map((id) => ({ id, autoAdded: false }));
  const errors = plan?.issues.filter((i) => i.level === "error").length ?? 0;
  const warnings = plan?.issues.filter((i) => i.level === "warning").length ?? 0;

  return (
    <div class="settings">
      <div class="settings-forms">
        <Button variant="ghost" icon="chevronLeft" onClick={onBack}>
          {t("settings.back")}
        </Button>
        {ordered.map(({ id, autoAdded }) => {
          const recipe = recipes.find((r) => r.id === id);
          if (!recipe) return null;
          return (
            <RecipeForm
              installed={installed}
              recipe={recipe}
              autoAdded={autoAdded}
              values={values[id] ?? {}}
              generated={generated[id] ?? new Set()}
              setValue={(pid, v) => setValues({ ...values, [id]: { ...(values[id] ?? {}), [pid]: v } })}
            />
          );
        })}
      </div>

      <aside class="settings-side">
        <div class="card sticky">
          <div class="side-head">
            <h3>{t("settings.plan")}</h3>
            {loading && <Spinner />}
          </div>
          <div class="segmented" title={t("settings.replaceHelp")}>
            <span class="muted small">{t("settings.existing")}</span>
            <div>
              <button type="button" class={onExisting === "keep" ? "active" : ""} onClick={() => setOnExisting("keep")}>
                {t("settings.keep")}
              </button>
              <button type="button" class={onExisting === "replace" ? "active" : ""} onClick={() => setOnExisting("replace")}>
                {t("settings.replace")}
              </button>
            </div>
          </div>
          {plan && <RamGauge used={plan.ramMb} label={t("catalog.ram")} help={t("catalog.ramHelp")} />}
          <PlanPanel plan={plan} loading={loading} error={null} />
          {error && <Alert tone="error">{l(error)}</Alert>}
          <div class="plan-summary">
            {plan && (
              <>
                <span>{t("settings.containers", { n: plan.containers.length })}</span>
                {errors > 0 ? (
                  <Badge tone="error">{t("settings.errors", { n: errors })}</Badge>
                ) : warnings > 0 ? (
                  <Badge tone="warning">{t("settings.warnings", { n: warnings })}</Badge>
                ) : (
                  <Badge tone="success">{t("settings.ready")}</Badge>
                )}
              </>
            )}
          </div>
          <Button variant="primary" size="lg" icon="zap" class="w-full" disabled={!plan?.ok || loading} loading={deploying} onClick={deploy}>
            {t("settings.deploy")}
          </Button>
          <p class="muted small center">{lang === "fr" ? "Rien n'est envoyé à l'APEX avant ce clic." : "Nothing is sent to the APEX before this click."}</p>
        </div>
      </aside>
    </div>
  );
}
