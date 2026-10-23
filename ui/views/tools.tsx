import { useEffect, useState } from "preact/hooks";
import { api, ApiError, type Issue, type Plan } from "../api";
import { Alert, Button, Field, Icon, useT } from "../components";
import type { L10n } from "../i18n";

const TEMPLATE = `{
  "Image": "nginx:alpine",
  "ExposedPorts": { "80/tcp": {} },
  "HostConfig": {
    "CpusetCpus": "0",
    "RestartPolicy": { "Name": "unless-stopped", "MaximumRetryCount": 0 },
    "PortBindings": { "80/tcp": [{ "HostPort": "50060" }] },
    "Mounts": [
      { "Target": "/usr/share/nginx/html", "Source": "web-data", "Type": "volume", "ReadOnly": false, "Consistency": "default" }
    ]
  }
}`;

function ArmTest() {
  const { t, l } = useT();
  const [image, setImage] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ compatible: boolean | null; state: string; error?: L10n } | null>(null);
  const [error, setError] = useState<L10n | null>(null);
  const run = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      setResult(await api("POST", "/api/tools/arm64", { image }));
    } catch (err) {
      setError(err instanceof ApiError ? err.l10n : { fr: String(err), en: String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="card tool" onSubmit={run}>
      <h3>
        <Icon name="cpu" /> {t("tools.arm.title")}
      </h3>
      <p class="muted small">{t("tools.arm.help")}</p>
      <div class="input-row">
        <input value={image} placeholder="influxdb:2.7" required onInput={(e) => setImage(e.currentTarget.value)} />
        <Button type="submit" variant="primary" loading={busy} icon="play">
          {t("tools.arm.run")}
        </Button>
      </div>
      {error && <Alert tone="error">{l(error)}</Alert>}
      {result &&
        (result.error ? (
          <Alert tone="error">{l(result.error)}</Alert>
        ) : result.compatible === true ? (
          <Alert tone="success">{t("tools.arm.ok")}</Alert>
        ) : result.compatible === false ? (
          <Alert tone="error">{t("tools.arm.ko")}</Alert>
        ) : (
          <Alert tone="warning">{t("tools.arm.unknown", { state: result.state })}</Alert>
        ))}
    </form>
  );
}

function CustomContainer({ onDeployed }: { onDeployed: (plan: Plan) => void }) {
  const { t, l } = useT();
  const [name, setName] = useState("web");
  const [json, setJson] = useState(TEMPLATE);
  const [replace, setReplace] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [error, setError] = useState<L10n | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(async () => {
      let options;
      try {
        options = JSON.parse(json);
        setParseError(null);
      } catch (e) {
        setParseError((e as Error).message);
        setIssues([]);
        return;
      }
      try {
        setIssues((await api<{ issues: Issue[] }>("POST", "/api/tools/lint", { name, options })).issues);
      } catch {
        /* ignore */
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [name, json]);

  const deploy = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ plan: Plan }>("POST", "/api/tools/custom", { name, options: JSON.parse(json), replace });
      onDeployed(r.plan);
    } catch (e) {
      setError(e instanceof ApiError ? e.l10n : { fr: String(e), en: String(e) });
    } finally {
      setBusy(false);
    }
  };
  const hasError = !!parseError || issues.some((i) => i.level === "error");

  return (
    <div class="card tool">
      <h3>
        <Icon name="code" /> {t("tools.custom.title")}
      </h3>
      <p class="muted small">{t("tools.custom.help")}</p>
      <Field label={t("tools.custom.name")}>
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </Field>
      <Field label={t("tools.custom.json")}>
        <textarea class="code-input" rows={14} spellcheck={false} value={json} onInput={(e) => setJson(e.currentTarget.value)} />
      </Field>
      {parseError && <Alert tone="error">{t("tools.custom.invalidJson", { msg: parseError })}</Alert>}
      {issues.map((i) => (
        <Alert tone={i.level === "error" ? "error" : "warning"}>{l(i.message)}</Alert>
      ))}
      {!parseError && issues.length === 0 && <Alert tone="success">OPA ✓</Alert>}
      {error && <Alert tone="error">{l(error)}</Alert>}
      <div class="input-row">
        <label class="inline-check">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.currentTarget.checked)} /> {t("tools.custom.replace")}
        </label>
        <div class="spacer" />
        <Button variant="primary" icon="zap" disabled={hasError} loading={busy} onClick={deploy}>
          {t("tools.custom.deploy")}
        </Button>
      </div>
    </div>
  );
}

export function ToolsView({ onDeployed }: { onDeployed: (plan: Plan) => void }) {
  const { t } = useT();
  return (
    <div class="tools">
      <div class="tools-main">
        <ArmTest />
        <CustomContainer onDeployed={onDeployed} />
      </div>
      <aside class="card rules">
        <h3>
          <Icon name="lock" /> {t("tools.rules.title")}
        </h3>
        <ol>
          {([1, 2, 3, 4, 5, 6, 7] as const).map((n) => (
            <li>{t(`tools.rules.${n}`)}</li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
