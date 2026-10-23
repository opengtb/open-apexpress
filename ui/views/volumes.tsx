import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError, backupDownloadUrl, uploadArchive } from "../api";
import { Alert, Button, Field, Modal, Spinner, useT } from "../components";
import type { Key, L10n } from "../i18n";

type Step = "stop" | "pull" | "archive" | "restart" | "ready";
interface BackupStatus {
  id: string;
  volume: string;
  file: string;
  state: "running" | "ready" | "error" | "done";
  step: Step;
  stopped: string[];
  size?: number;
  error?: L10n;
}

const toL10n = (e: unknown): L10n => (e instanceof ApiError ? e.l10n : { fr: String(e), en: String(e) });

export const formatSize = (bytes: number, lang: string) => {
  const unit = lang === "fr" ? ["o", "Ko", "Mo", "Go"] : ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < unit.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${unit[i]}`;
};

/** Containers that use a volume and will be stopped during the operation. */
function useVolumeUsers(volume: string) {
  const [users, setUsers] = useState<string[] | null>(null);
  useEffect(() => {
    setUsers(null);
    if (!volume) return;
    const timer = setTimeout(() => {
      api<{ users: string[] }>("GET", `/api/volumes/${encodeURIComponent(volume)}/users`)
        .then((r) => setUsers(r.users))
        .catch(() => setUsers([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [volume]);
  return users;
}

export function BackupModal({ volume, onClose }: { volume: string; onClose: () => void }) {
  const { t, l, lang } = useT();
  const users = useVolumeUsers(volume);
  const [stop, setStop] = useState(true);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState<L10n | null>(null);
  const [starting, setStarting] = useState(false);
  const downloaded = useRef(false);

  useEffect(() => {
    if (!status || status.state !== "running") return;
    const timer = setTimeout(async () => {
      try {
        setStatus(await api<BackupStatus>("GET", `/api/backups/${status.id}`));
      } catch (e) {
        setError(toL10n(e));
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (status?.state === "ready" && !downloaded.current) {
      downloaded.current = true;
      const a = document.createElement("a");
      a.href = backupDownloadUrl(status.id);
      a.download = status.file;
      document.body.append(a);
      a.click();
      a.remove();
    }
  }, [status?.state]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>("POST", `/api/volumes/${encodeURIComponent(volume)}/backup`, { stop: stop && !!users?.length });
      setStatus({ id, volume, file: "", state: "running", step: "stop", stopped: [] });
    } catch (e) {
      setError(toL10n(e));
    } finally {
      setStarting(false);
    }
  };

  const running = status?.state === "running";
  const finished = status?.state === "ready" || status?.state === "done";
  return (
    <Modal
      title={t("backup.title", { name: volume })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{finished ? t("common.close") : t("common.cancel")}</Button>
          {!status && (
            <Button variant="primary" icon="download" loading={starting} disabled={users === null} onClick={start}>
              {t("backup.start")}
            </Button>
          )}
        </>
      }
    >
      <p class="muted small">{t("backup.help")}</p>
      {!status && users && users.length > 0 && (
        <label class="inline-check mt">
          <input type="checkbox" checked={stop} onChange={(e) => setStop(e.currentTarget.checked)} />
          <span>{t("backup.stop", { names: users.join(", ") })}</span>
        </label>
      )}
      {running && (
        <div class="transfer-step mt">
          <Spinner size={14} /> {t(`backup.step.${status.step}` as Key)}
        </div>
      )}
      {finished && (
        <Alert tone="success">
          {t("backup.ready", { file: status.file, size: status.size ? formatSize(status.size, lang) : "?" })}
        </Alert>
      )}
      {status?.state === "error" && status.error && <Alert tone="error">{l(status.error)}</Alert>}
      {status && status.stopped.length > 0 && status.state !== "running" && <p class="muted small">{t("backup.restarted", { names: status.stopped.join(", ") })}</p>}
      {error && <Alert tone="error">{l(error)}</Alert>}
    </Modal>
  );
}

export function RestoreModal({ volumes, initial, onClose, onDone }: { volumes: string[]; initial?: string; onClose: () => void; onDone: () => void }) {
  const { t, l, lang } = useT();
  const [volume, setVolume] = useState(initial ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<L10n | null>(null);
  const [done, setDone] = useState<string[] | null>(null);
  const users = useVolumeUsers(volume.trim());
  const validName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume.trim());

  const pick = (f: File | null) => {
    setFile(f);
    // z2m-data-2026-10-15-1432.tar.gz -> z2m-data
    const guess = f?.name.match(/^(.+?)-\d{4}-\d{2}-\d{2}-\d{4}\.t(ar\.)?gz$/)?.[1];
    if (guess && !volume) setVolume(guess);
  };

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await uploadArchive(volume.trim(), file!);
      setDone(r.restarted);
      onDone();
    } catch (e) {
      setError(toL10n(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("restore.title")}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {done ? t("common.close") : t("common.cancel")}
          </Button>
          {!done && (
            <Button variant="danger" icon="upload" loading={busy} disabled={!file || !validName} onClick={restore}>
              {t("restore.start")}
            </Button>
          )}
        </>
      }
    >
      {done ? (
        <Alert tone="success">{done.length ? t("restore.doneRestarted", { name: volume, names: done.join(", ") }) : t("restore.done", { name: volume })}</Alert>
      ) : (
        <>
          <p class="muted small">{t("restore.help")}</p>
          <Field label={t("restore.file")}>
            <input type="file" accept=".gz,.tgz,application/gzip" disabled={busy} onChange={(e) => pick(e.currentTarget.files?.[0] ?? null)} />
          </Field>
          {file && <p class="muted small">{formatSize(file.size, lang)}</p>}
          <Field label={t("restore.volume")} help={t("restore.volumeHelp")}>
            <input list="restore-volumes" value={volume} disabled={busy} spellcheck={false} onInput={(e) => setVolume(e.currentTarget.value)} />
            <datalist id="restore-volumes">
              {volumes.map((v) => (
                <option value={v} />
              ))}
            </datalist>
          </Field>
          {volume && validName && (
            <Alert tone="warning">
              {volumes.includes(volume.trim()) ? t("restore.replace", { name: volume.trim() }) : t("restore.create", { name: volume.trim() })}
              {users && users.length > 0 && ` ${t("restore.stop", { names: users.join(", ") })}`}
            </Alert>
          )}
          {busy && (
            <div class="transfer-step">
              <Spinner size={14} /> {t("restore.busy")}
            </div>
          )}
        </>
      )}
      {error && <Alert tone="error">{l(error)}</Alert>}
    </Modal>
  );
}
