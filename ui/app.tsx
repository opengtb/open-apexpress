import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, type ApexSnapshot, type Pack, type Plan, type Recipe, type SessionInfo } from "./api";
import { Alert, Button, Confirm, Icon, LangContext, Logo, Spinner, useT } from "./components";
import type { Lang } from "./i18n";
import { ApexView } from "./views/apex";
import { CatalogView } from "./views/catalog";
import { ConnectView } from "./views/connect";
import { InstallView } from "./views/install";
import { JournalView } from "./views/journal";
import { SettingsView, type Values } from "./views/settings";
import { ToolsView } from "./views/tools";
import "./styles.css";

type Tab = "install" | "apex" | "tools" | "journal";
type Step = "services" | "settings" | "install";
type Theme = "light" | "dark";

const stored = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

function Shell() {
  const [lang, setLang] = useState<Lang>(stored("apexpress-lang", navigator.language.startsWith("fr") ? "fr" : "en") as Lang);
  // Dark by default, like opengtb.com.
  const [theme, setTheme] = useState<Theme>(stored("apexpress-theme", "dark") as Theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = lang;
  }, [theme, lang]);
  return (
    <LangContext.Provider value={lang}>
      <App
        lang={lang}
        setLang={(l) => (setLang(l), store("apexpress-lang", l))}
        theme={theme}
        setTheme={(t) => (setTheme(t), store("apexpress-theme", t))}
      />
    </LangContext.Provider>
  );
}

function App({ lang, setLang, theme, setTheme }: { lang: Lang; setLang: (l: Lang) => void; theme: Theme; setTheme: (t: Theme) => void }) {
  const { t, l } = useT();
  const [meta, setMeta] = useState<{ version: string; recipes: Recipe[]; packs: Pack[] } | null>(null);
  const [fatal, setFatal] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [snapshot, setSnapshot] = useState<ApexSnapshot>({ containers: [], images: [], volumes: [] });
  const [tab, setTab] = useState<Tab>("install");
  const [step, setStep] = useState<Step>("services");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [values, setValues] = useState<Values>({});
  const [onExisting, setOnExisting] = useState<"keep" | "replace">("keep");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [quit, setQuit] = useState(false);

  useEffect(() => {
    api("GET", "/api/meta")
      .then(async (m) => {
        setMeta(m);
        if (m.session) {
          setSession(m.session);
          setSnapshot(await api("GET", "/api/apex"));
        }
      })
      .catch(() => setFatal(true));
  }, []);

  const refreshSnapshot = () => api<ApexSnapshot>("GET", "/api/apex").then((s) => setSnapshot((prev) => ({ ...prev, ...s }))).catch(() => undefined);

  const startInstall = (p: Plan) => {
    setPlan(p);
    setStep("install");
    setTab("install");
  };

  if (quit) {
    return (
      <div class="center-screen">
        <Logo size={56} />
        <h2>Open Apexpress</h2>
        <p class="muted">{lang === "fr" ? "Application fermée. Vous pouvez fermer cet onglet." : "Application closed. You can close this tab."}</p>
      </div>
    );
  }
  if (fatal) {
    return (
      <div class="center-screen">
        <Alert tone="error">{t("common.offline")}</Alert>
      </div>
    );
  }
  if (!meta) {
    return (
      <div class="center-screen">
        <Spinner size={28} />
      </div>
    );
  }

  const installed = new Set(snapshot.containers.map((c) => c.name));
  const tabs: { id: Tab; icon: string }[] = [
    { id: "install", icon: "layers" },
    { id: "apex", icon: "box" },
    { id: "tools", icon: "tool" },
    { id: "journal", icon: "activity" },
  ];

  return (
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">
            open<span class="sl">/</span>
            <b>apexpress</b>
            <span class="cur" />
          </span>
          <span class="ver">v{meta.version}</span>
        </div>
        {session && (
          <nav class="tabs">
            {tabs.map((x) => (
              <button
                type="button"
                class={`tab ${tab === x.id ? "active" : ""}`}
                onClick={() => {
                  setTab(x.id);
                  if (x.id === "apex") refreshSnapshot();
                }}
              >
                <Icon name={x.icon} /> <span>{t(`tab.${x.id}`)}</span>
              </button>
            ))}
          </nav>
        )}
        <div class="top-actions">
          {session && (
            <span class={`conn ${session.demo ? "demo" : ""}`} title={`${t("top.connectedTo")} ${session.host}`}>
              <span class="conn-dot" />
              {session.demo ? `APEX ${t("top.demo")}` : session.host}
            </span>
          )}
          <div class="lang">
            {(["fr", "en"] as const).map((x) => (
              <button type="button" class={lang === x ? "active" : ""} onClick={() => setLang(x)}>
                {x.toUpperCase()}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" icon={theme === "dark" ? "sun" : "moon"} title={t("top.theme")} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} />
          {session && (
            <Button
              variant="ghost"
              size="sm"
              icon="plug"
              title={t("top.disconnect")}
              onClick={async () => {
                await api("POST", "/api/disconnect").catch(() => undefined);
                setSession(null);
                setStep("services");
                setPlan(null);
              }}
            />
          )}
          <Button variant="ghost" size="sm" icon="power" title={t("top.quit")} onClick={() => setConfirmQuit(true)} />
        </div>
      </header>

      <main class="main">
        {!session ? (
          <ConnectView
            onConnected={(s, snap) => {
              setSession(s);
              setSnapshot(snap);
              setTab("install");
              setStep("services");
            }}
          />
        ) : tab === "install" ? (
          <>
            <ol class="stepper">
              {(["services", "settings", "install"] as const).map((s, i) => {
                const idx = ["services", "settings", "install"].indexOf(step);
                return (
                  <li class={`${step === s ? "active" : ""} ${i < idx ? "done" : ""}`}>
                    <span class="step-num">{i < idx ? <Icon name="check" size={13} /> : String(i + 1).padStart(2, "0")}</span>
                    {t(`steps.${s}`)}
                  </li>
                );
              })}
            </ol>
            {step === "services" && (
              <CatalogView recipes={meta.recipes} packs={meta.packs} selected={selected} setSelected={setSelected} installed={installed} onNext={() => setStep("settings")} />
            )}
            {step === "settings" && (
              <SettingsView
                installed={installed}
                recipes={meta.recipes}
                selected={selected}
                values={values}
                setValues={setValues}
                onExisting={onExisting}
                setOnExisting={setOnExisting}
                onBack={() => setStep("services")}
                onDeployed={startInstall}
              />
            )}
            {step === "install" && plan && (
              <InstallView
                recipes={meta.recipes}
                key={plan.containers.map((c) => c.name).join()}
                plan={plan}
                onFinished={refreshSnapshot}
                onBack={() => setStep("settings")}
                onAgain={() => {
                  setSelected(new Set());
                  setValues({});
                  setPlan(null);
                  setStep("services");
                }}
              />
            )}
          </>
        ) : tab === "apex" ? (
          <ApexView session={session} snapshot={snapshot} setSnapshot={setSnapshot} onDeployed={startInstall} />
        ) : tab === "tools" ? (
          <ToolsView onDeployed={startInstall} />
        ) : (
          <JournalView />
        )}
      </main>

      <footer class="footer">
        <div class="footer-inner">
          <span>
            <span class="ok-dot">●</span> open apexpress v{meta.version}
          </span>
          <span>
            {lang === "fr" ? "un outil" : "a tool by"}{" "}
            <a href="https://opengtb.com" target="_blank" rel="noreferrer">
              opengtb
            </a>
          </span>
          <span>{lang === "fr" ? "non affilié à Distech Controls" : "not affiliated with Distech Controls"}</span>
        </div>
      </footer>

      {confirmQuit && (
        <Confirm
          message={t("top.quitConfirm")}
          onCancel={() => setConfirmQuit(false)}
          onConfirm={async () => {
            setConfirmQuit(false);
            await api("POST", "/api/quit").catch(() => undefined);
            setQuit(true);
          }}
        />
      )}
    </div>
  );
}

render(<Shell />, document.getElementById("root")!);
