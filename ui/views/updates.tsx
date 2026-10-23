import { useState } from "preact/hooks";
import { api, ApiError, type ApexContainer, type Plan, type UpdateInfo } from "../api";
import { Alert, Button, Icon, Modal, useT } from "../components";
import type { L10n } from "../i18n";

export const withTag = (image: string, tag: string) => {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return `${colon > slash ? image.slice(0, colon) : image}:${tag}`;
};

/** Target image of an update: a newer tag of the same major, or the same tag rebuilt. */
export const updateTarget = (image: string, u?: UpdateInfo) => (u?.newer ? withTag(image, u.newer) : u?.rebuilt ? image : undefined);

/** Badge under the image of a container: what can be updated. */
export function UpdateBadge({ c, info, onOpen }: { c: ApexContainer; info?: UpdateInfo; onOpen: () => void }) {
  const { t, l } = useT();
  if (!info || !c.image) return null;
  const target = updateTarget(c.image, info);
  return (
    <div class="update-line">
      {target && (
        <button type="button" class={`update-chip ${info.updatable ? "" : "is-blocked"}`} title={info.updatable ? t("update.open") : l(info.reason!)} onClick={onOpen}>
          <Icon name="download" size={11} /> {info.newer ? info.newer : t("update.rebuilt")}
        </button>
      )}
      {info.major && (
        <span class="update-major" title={t("update.majorHelp")}>
          {t("update.major", { tag: info.major })}
        </span>
      )}
    </div>
  );
}

export function UpdateModal({
  c,
  info,
  onClose,
  onBackup,
  onDeployed,
}: {
  c: ApexContainer;
  info: UpdateInfo;
  onClose: () => void;
  onBackup: (volume: string) => void;
  onDeployed: (plan: Plan) => void;
}) {
  const { t, l } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<L10n | null>(null);
  const target = updateTarget(c.image!, info)!;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ plan: Plan }>("POST", `/api/containers/${encodeURIComponent(c.name)}/update`, { image: target });
      onDeployed(r.plan);
    } catch (e) {
      setError(e instanceof ApiError ? e.l10n : { fr: String(e), en: String(e) });
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("update.title", { name: c.name })}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          {info.updatable && (
            <Button variant="primary" icon="download" loading={busy} onClick={run}>
              {t("update.start")}
            </Button>
          )}
        </>
      }
    >
      <div class="update-from-to">
        <code>{c.image}</code>
        <Icon name="chevronRight" size={14} />
        <code class="update-to">{target}</code>
      </div>
      {!info.newer && info.rebuilt && <p class="muted small">{t("update.rebuiltHelp")}</p>}
      {info.updatable ? (
        <>
          <p class="muted small">{t("update.help")}</p>
          <Alert tone="info">{info.source === "pc" ? t("update.sourcePc") : t("update.sourceApex")}</Alert>
          {(c.volumes ?? []).length > 0 && (
            <div class="update-backup">
              <p class="small">{t("update.backup")}</p>
              <div class="volumes">
                {c.volumes!.map((v) => (
                  <button type="button" class="volume volume-action" onClick={() => onBackup(v)}>
                    <Icon name="download" size={12} /> {v}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        info.reason && <Alert tone="warning">{l(info.reason)}</Alert>
      )}
      {error && <Alert tone="error">{l(error)}</Alert>}
    </Modal>
  );
}
