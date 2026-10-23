import { useState } from "preact/hooks";
import { api, ApiError, type ApexSnapshot, type SessionInfo } from "../api";
import { Alert, Button, Field, Icon, PasswordInput, useT } from "../components";
import type { L10n } from "../i18n";

const load = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

export function ConnectView({ onConnected }: { onConnected: (s: SessionInfo, snap: ApexSnapshot) => void }) {
  const { t, l } = useT();
  const [host, setHost] = useState(load("apexpress-host"));
  const [username, setUsername] = useState(load("apexpress-user") || "admin");
  const [password, setPassword] = useState("");
  const [apexIp, setApexIp] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<"connect" | "demo" | null>(null);
  const [error, setError] = useState<L10n | null>(null);

  const connect = async (e: Event) => {
    e.preventDefault();
    setBusy("connect");
    setError(null);
    try {
      const r = await api("POST", "/api/connect", { host, username, password, apexIp: apexIp || undefined });
      save("apexpress-host", host);
      save("apexpress-user", username);
      onConnected(r.session, r);
    } catch (err) {
      setError(err instanceof ApiError ? err.l10n : { fr: String(err), en: String(err) });
    } finally {
      setBusy(null);
    }
  };

  const demo = async () => {
    setBusy("demo");
    setError(null);
    try {
      const r = await api("POST", "/api/demo");
      onConnected(r.session, r);
    } catch (err) {
      setError(err instanceof ApiError ? err.l10n : { fr: String(err), en: String(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div class="connect">
      <section class="connect-hero">
        <span class="kicker">
          // open apexpress · <b>opengtb</b>
        </span>
        <h1>{t("tagline")}</h1>
        <ul class="why">
          {(["connect.why1", "connect.why2", "connect.why3"] as const).map((key, i) => (
            <li>
              <span class="why-num">{String(i + 1).padStart(2, "0")}</span>
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
        <p class="muted small">{t("connect.requirements")}</p>
      </section>

      <form class="card connect-card" onSubmit={connect}>
        <span class="prompt">
          $ open-apexpress <b>connect</b>
        </span>
        <h2>{t("connect.title")}</h2>
        <p class="muted">{t("connect.subtitle")}</p>
        <Field label={t("connect.host")} help={t("connect.hostHelp")} htmlFor="host" required>
          <input id="host" value={host} placeholder="192.168.1.2" autoFocus required onInput={(e) => setHost(e.currentTarget.value)} />
        </Field>
        <div class="row">
          <Field label={t("connect.user")} htmlFor="user" required>
            <input id="user" value={username} autoComplete="username" required onInput={(e) => setUsername(e.currentTarget.value)} />
          </Field>
          <Field label={t("connect.password")} htmlFor="password">
            <PasswordInput id="password" value={password} onInput={setPassword} autoComplete="current-password" />
          </Field>
        </div>
        <button type="button" class="link-btn" onClick={() => setAdvanced(!advanced)}>
          <Icon name={advanced ? "chevronDown" : "chevronRight"} size={14} /> {t("connect.advanced")}
        </button>
        {advanced && (
          <Field label={t("connect.apexIp")} help={t("connect.apexIpHelp")} htmlFor="apexIp">
            <input id="apexIp" value={apexIp} placeholder={host.replace(/:\d+$/, "") || "192.168.1.2"} onInput={(e) => setApexIp(e.currentTarget.value)} />
          </Field>
        )}
        {error && <Alert tone="error">{l(error)}</Alert>}
        <Button type="submit" variant="primary" size="lg" icon="plug" loading={busy === "connect"} disabled={!!busy} class="w-full">
          {t("connect.submit")}
        </Button>
        <div class="divider">
          <span>{t("connect.or")}</span>
        </div>
        <Button variant="ghost" icon="play" loading={busy === "demo"} disabled={!!busy} onClick={demo} class="w-full">
          {t("connect.demo")}
        </Button>
      </form>
    </div>
  );
}
