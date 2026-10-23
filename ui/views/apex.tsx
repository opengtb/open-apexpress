import { useEffect, useState } from "preact/hooks";
import { api, ApiError, type ApexSnapshot, type Plan, type SessionInfo, type UpdateInfo } from "../api";
import { Alert, Badge, Button, Confirm, Icon, Spinner, useT } from "../components";
import type { L10n } from "../i18n";
import { UpdateBadge, UpdateModal, updateTarget } from "./updates";
import { BackupModal, RestoreModal } from "./volumes";

/** Short tag of a non-web port, from the English label of the recipe link. */
const portKind = (label: string) => (/websocket/i.test(label) ? "ws" : /mqtt/i.test(label) ? "mqtt" : /udp|gateway/i.test(label) ? "udp" : "tcp");

const STATE_TONE: Record<string, string> = { running: "success", exited: "neutral", created: "info", restarting: "warning", paused: "neutral", dead: "error" };

export function ApexView({
  session,
  snapshot,
  setSnapshot,
  onDeployed,
}: {
  session: SessionInfo;
  snapshot: ApexSnapshot;
  setSnapshot: (s: ApexSnapshot) => void;
  onDeployed: (plan: Plan) => void;
}) {
  const { t, l } = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<L10n | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "container" | "volume"; name: string } | null>(null);
  const [backup, setBackup] = useState<string | null>(null);
  const [restore, setRestore] = useState(false);
  const [updates, setUpdates] = useState<Record<string, UpdateInfo> | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState<string | null>(null);

  const checkUpdates = async (fresh = false) => {
    setChecking(true);
    try {
      setUpdates(await api("GET", `/api/updates${fresh ? "?fresh=1" : ""}`));
    } catch {
      setUpdates({});
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    checkUpdates();
  }, []);
  const available = Object.entries(updates ?? {}).filter(([name, u]) => {
    const c = snapshot.containers.find((x) => x.name === name);
    return !!c?.image && !!updateTarget(c.image, u);
  }).length;
  const updated = snapshot.containers.find((c) => c.name === updating);

  const run = async (key: string, fn: () => Promise<ApexSnapshot>) => {
    setBusy(key);
    setError(null);
    try {
      setSnapshot({ ...snapshot, ...(await fn()) });
    } catch (e) {
      setError(e instanceof ApiError ? e.l10n : { fr: String(e), en: String(e) });
    } finally {
      setBusy(null);
    }
  };
  const action = (name: string, a: string) => run(`${name}:${a}`, () => api("POST", `/api/containers/${encodeURIComponent(name)}/${a}`));
  const refresh = () => run("refresh", () => api("GET", "/api/apex"));
  const platform = snapshot.platform ?? {};
  const platformInfo = ["name", "model", "firmware-version", "version", "serial-number"].map((k) => platform[k]).filter((v) => typeof v === "string");

  return (
    <div class="apex">
      <div class="page-head">
        <div>
          <h2>{t("apex.title")}</h2>
          <p class="muted">
            {session.demo ? "APEX demo" : session.host}
            {platformInfo.length > 0 && ` · ${platformInfo.join(" · ")}`} · {t("apex.images", { n: snapshot.images.length })}
          </p>
        </div>
        <div class="head-actions">
          <Button icon="download" loading={checking} onClick={() => checkUpdates(true)}>
            {t("update.check")}
          </Button>
          <Button icon="restart" loading={busy === "refresh"} onClick={refresh}>
            {t("apex.refresh")}
          </Button>
        </div>
      </div>
      {checking && !updates && (
        <p class="muted small update-status">
          <Spinner size={12} /> {t("update.checking")}
        </p>
      )}
      {updates && !checking && (
        <div class="update-status muted small">
          <b>{available ? t("update.available", { n: available }) : t("update.none")}</b>
          <span>
            <Icon name="info" size={12} /> {t("update.pcNote")}
          </span>
        </div>
      )}
      {error && <Alert tone="error">{l(error)}</Alert>}

      <section class="card table-card">
        {snapshot.containers.length === 0 ? (
          <p class="muted empty">{t("apex.empty")}</p>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>{t("apex.name")}</th>
                <th>{t("apex.image")}</th>
                <th>{t("apex.state")}</th>
                <th>{t("apex.ports")}</th>
                <th class="right">{t("apex.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.containers.map((c) => (
                <tr>
                  <td>
                    <b>{c.name}</b>
                    {(c.links ?? []).map((lnk) =>
                      session.demo ? (
                        <span class="container-link">{l(lnk.label)}</span>
                      ) : (
                        <a class="container-link" href={lnk.url} target="_blank" rel="noreferrer">
                          {l(lnk.label)} <Icon name="external" size={11} />
                        </a>
                      ),
                    )}
                  </td>
                  <td>
                    <code>{c.image ?? "?"}</code>
                    <UpdateBadge c={c} info={updates?.[c.name]} onOpen={() => setUpdating(c.name)} />
                  </td>
                  <td>
                    <Badge tone={STATE_TONE[c.state ?? ""] ?? "neutral"} title={c.status}>
                      {c.state ?? "?"}
                    </Badge>
                  </td>
                  <td>
                    <div class="ports">
                    {c.hostPorts.map((p) =>
                      c.otherPorts?.[p] ? (
                        <span class="port port-other" title={l(c.otherPorts[p]!)}>
                          {p} <small>{portKind(c.otherPorts[p]!.en)}</small>
                        </span>
                      ) : session.demo ? (
                        <span class="port">{p}</span>
                      ) : (
                        <a class="port" href={`http://${session.apexIp}:${p}`} target="_blank" rel="noreferrer">
                          {p} <Icon name="external" size={11} />
                        </a>
                      ),
                    )}
                    </div>
                  </td>
                  <td class="right nowrap">
                    {c.state === "running" ? (
                      <>
                        <Button size="sm" variant="ghost" icon="restart" title={t("apex.restart")} loading={busy === `${c.name}:restart`} onClick={() => action(c.name, "restart")} />
                        <Button size="sm" variant="ghost" icon="stop" title={t("apex.stop")} loading={busy === `${c.name}:stop`} onClick={() => action(c.name, "stop")} />
                      </>
                    ) : (
                      <Button size="sm" variant="ghost" icon="play" title={t("apex.start")} loading={busy === `${c.name}:start`} onClick={() => action(c.name, "start")} />
                    )}
                    <Button size="sm" variant="ghost" icon="trash" class="danger-hover" title={t("apex.delete")} loading={busy === `${c.name}:delete`} onClick={() => setConfirm({ kind: "container", name: c.name })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section class="card">
        <div class="section-head">
          <h3 class="section-title">{t("apex.volumes")}</h3>
          <Button size="sm" icon="upload" onClick={() => setRestore(true)}>
            {t("apex.restore")}
          </Button>
        </div>
        <p class="muted small">{t("apex.volumesHelp")}</p>
        <div class="volumes">
          {snapshot.volumes.map((v) => (
            <span class="volume">
              <Icon name="box" size={13} /> {v}
              <button type="button" class="volume-backup" title={t("apex.backup")} aria-label={t("apex.backup")} onClick={() => setBackup(v)}>
                <Icon name="download" size={12} />
              </button>
              <button type="button" class="volume-delete" title={t("apex.volumeDelete")} aria-label={t("apex.volumeDelete")} onClick={() => setConfirm({ kind: "volume", name: v })}>
                <Icon name="trash" size={12} />
              </button>
            </span>
          ))}
          {snapshot.volumes.length === 0 && <span class="muted">—</span>}
        </div>
      </section>

      {updated && !backup && updates?.[updated.name] && (
        <UpdateModal c={updated} info={updates[updated.name]!} onClose={() => setUpdating(null)} onBackup={setBackup} onDeployed={onDeployed} />
      )}
      {backup && <BackupModal volume={backup} onClose={() => setBackup(null)} />}
      {restore && <RestoreModal volumes={snapshot.volumes} onClose={() => setRestore(false)} onDone={refresh} />}
      {confirm?.kind === "container" && (
        <Confirm
          danger
          message={t("apex.deleteConfirm", { name: confirm.name })}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const name = confirm.name;
            setConfirm(null);
            action(name, "delete");
          }}
        />
      )}
      {confirm?.kind === "volume" && (
        <Confirm
          danger
          typeToConfirm={confirm.name}
          message={t("apex.volumeConfirm", { name: confirm.name })}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const name = confirm.name;
            setConfirm(null);
            run(`volume:${name}`, () => api("POST", `/api/volumes/${encodeURIComponent(name)}/delete`));
          }}
        />
      )}
    </div>
  );
}
