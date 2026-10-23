import { createContext, type ComponentChildren, type JSX } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { translate, type Key, type L10n, type Lang } from "./i18n";

// --- Language -----------------------------------------------------------------

export const LangContext = createContext<Lang>("fr");

export function useT() {
  const lang = useContext(LangContext);
  const t = (key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars);
  const l = (text: L10n | undefined) => (text ? text[lang] : "");
  return { t, l, lang };
}

// --- Icons (Feather-style, inline so the app works offline) -------------------

const PATHS: Record<string, string> = {
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  play: "M5 3l14 9-14 9V3z",
  stop: "M6 6h12v12H6z",
  restart: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15",
  trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3",
  copy: "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M17.9 17.9A10.1 10.1 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M1 1l22 22",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  power: "M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.4-4.4",
  chevronRight: "M9 18l6-6-6-6",
  chevronLeft: "M15 18l-6-6 6-6",
  chevronDown: "M6 9l6 6 6-6",
  box: "M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7zM3.3 7 12 12l8.7-5M12 22V12",
  cpu: "M18 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3",
  plug: "M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z",
  tool: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  layers: "M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  zap: "M13 2 3 14h9l-1 8 10-12h-9l1-8z",
  lock: "M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  globe: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
  code: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
};

export function Icon({ name, size = 16, class: cls = "" }: { name: keyof typeof PATHS | string; size?: number; class?: string }) {
  return (
    <svg class={`icon ${cls}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <span class="spinner" style={{ width: `${size}px`, height: `${size}px` }} aria-label="…" />;
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect x="1" y="1" width="62" height="62" rx="12" fill="#07090a" stroke="#1f2a24" stroke-width="2" />
      <path d="M5 29h10M8 37h8" stroke="#2a8a2a" stroke-width="4" stroke-linecap="round" />
      <path d="M17 49 32 14l15 35" fill="none" stroke="#6ce26c" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round" />
      {/* the OpenGTB pulse as the crossbar of the A */}
      <path d="M21 38h6l2.5-5 4 9 2-4h7" fill="none" stroke="#b6ff4a" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

// --- Basic building blocks ------------------------------------------------------

type ButtonProps = Omit<JSX.IntrinsicElements["button"], "size" | "type" | "icon"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: string;
  loading?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
};

export function Button({ variant = "secondary", size = "md", icon, loading, children, class: cls, disabled, ...rest }: ButtonProps) {
  return (
    <button class={`btn btn-${variant} btn-${size} ${cls ?? ""}`} disabled={disabled || loading} type={rest.type ?? "button"} {...rest}>
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} size={size === "sm" ? 14 : 16} /> : null}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Badge({ tone = "neutral", children, title }: { tone?: string; children: ComponentChildren; title?: string }) {
  return (
    <span class={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function RecipeLogo({ badge, color, size = 40 }: { badge: string; color: string; size?: number }) {
  return (
    <span class="recipe-logo" style={{ background: color, width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.36)}px`, borderRadius: `${Math.max(2, Math.round(size * 0.1))}px` }}>
      {badge}
    </span>
  );
}

export function Alert({ tone = "info", children, icon }: { tone?: "info" | "warning" | "error" | "success"; children: ComponentChildren; icon?: string }) {
  const def = { info: "info", warning: "alert", error: "alert", success: "check" }[tone];
  return (
    <div class={`alert alert-${tone}`} role={tone === "error" ? "alert" : undefined}>
      <Icon name={icon ?? def} size={18} />
      <div>{children}</div>
    </div>
  );
}

export function Field({ label, help, children, htmlFor, required }: { label: ComponentChildren; help?: ComponentChildren; children: ComponentChildren; htmlFor?: string; required?: boolean }) {
  return (
    <div class="field">
      <label for={htmlFor}>
        {label}
        {required && <span class="req">*</span>}
      </label>
      {children}
      {help && <p class="help">{help}</p>}
    </div>
  );
}

export function PasswordInput({ value, onInput, id, placeholder, autoComplete }: { value: string; onInput: (v: string) => void; id?: string; placeholder?: string; autoComplete?: string }) {
  const [visible, setVisible] = useState(false);
  const { t } = useT();
  return (
    <div class="input-group">
      <input id={id} type={(visible ? "text" : "password") as "text"} value={value} placeholder={placeholder} autoComplete={autoComplete ?? "off"} onInput={(e) => onInput(e.currentTarget.value)} />
      <button type="button" class="input-addon" onClick={() => setVisible(!visible)} title={visible ? t("common.hide") : t("common.show")}>
        <Icon name={visible ? "eyeOff" : "eye"} />
      </button>
    </div>
  );
}

export function CopyButton({ text, label, size = "sm" }: { text: string; label?: boolean; size?: "sm" | "md" }) {
  const [copied, setCopied] = useState(false);
  const { t } = useT();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button size={size} variant="ghost" icon={copied ? "check" : "copy"} onClick={copy} title={t("common.copy")}>
      {label ? (copied ? t("common.copied") : t("common.copy")) : null}
    </Button>
  );
}

export function Secret({ value }: { value: string }) {
  const [visible, setVisible] = useState(false);
  const { t } = useT();
  return (
    <span class="secret">
      <code>{visible ? value : "•".repeat(Math.min(value.length, 14))}</code>
      <Button size="sm" variant="ghost" icon={visible ? "eyeOff" : "eye"} onClick={() => setVisible(!visible)} title={visible ? t("common.hide") : t("common.show")} />
      <CopyButton text={value} />
    </span>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: ComponentChildren; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren; wide?: boolean }) {
  const { t } = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true">
        <header>
          <h3>{title}</h3>
          <Button variant="ghost" size="sm" icon="x" onClick={onClose} title={t("common.close")} />
        </header>
        <div class="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/** Confirmation dialog, optionally requiring the user to type a word. */
export function Confirm({ message, onConfirm, onCancel, typeToConfirm, danger }: { message: string; onConfirm: () => void; onCancel: () => void; typeToConfirm?: string; danger?: boolean }) {
  const { t } = useT();
  const [typed, setTyped] = useState("");
  const ok = !typeToConfirm || typed === typeToConfirm;
  return (
    <Modal
      title={t("common.confirm")}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant={danger ? "danger" : "primary"} disabled={!ok} onClick={onConfirm}>
            {t("common.confirm")}
          </Button>
        </>
      }
    >
      <p>{message}</p>
      {typeToConfirm && <input class="mt" value={typed} onInput={(e) => setTyped(e.currentTarget.value)} placeholder={typeToConfirm} autoFocus />}
    </Modal>
  );
}

/** Field-tested tips of a recipe, folded by default. */
export function Troubleshooting({ items, open }: { items?: L10n[]; open?: boolean }) {
  const { t, l } = useT();
  if (!items?.length) return null;
  return (
    <details class="help-box" open={open}>
      <summary>
        <Icon name="info" size={14} /> {t("help.title")} ({items.length})
      </summary>
      <ol>
        {items.map((item) => (
          <li>{l(item)}</li>
        ))}
      </ol>
    </details>
  );
}

export function RamGauge({ used, total = 1800, label, help }: { used: number; total?: number; label: string; help?: string }) {
  const { lang } = useT();
  const unit = lang === "fr" ? "Mo" : "MB";
  const pct = Math.min(100, Math.round((used / total) * 100));
  const tone = pct > 75 ? "error" : pct > 50 ? "warning" : "ok";
  return (
    <div class="ram" title={help}>
      <div class="ram-head">
        <span>{label}</span>
        <b>
          ~{used} {unit} / {total} {unit}
        </b>
      </div>
      <div class="ram-bar">
        <div class={`ram-fill ram-${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
