import { useMemo, useState } from "preact/hooks";
import type { Pack, Recipe } from "../api";
import { Badge, Button, Icon, RamGauge, RecipeLogo, useT } from "../components";
import type { Key } from "../i18n";

const CATEGORIES = ["all", "messaging", "iot", "automation", "data", "remote", "tools"] as const;
export const STATUS_TONE = { validated: "success", experimental: "warning" } as const;

/** Recipes pulled in by the selection through `requires`. */
export function dependencies(recipes: Recipe[], selected: Set<string>): Map<string, string[]> {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const required = new Map<string, string[]>();
  const visit = (id: string, from: string) => {
    for (const dep of byId.get(id)?.requires ?? []) {
      if (!selected.has(dep)) required.set(dep, [...new Set([...(required.get(dep) ?? []), from])]);
      visit(dep, from);
    }
  };
  for (const id of selected) visit(id, byId.get(id)?.name ?? id);
  return required;
}

export function CatalogView({
  recipes,
  packs,
  selected,
  setSelected,
  installed,
  onNext,
}: {
  recipes: Recipe[];
  packs: Pack[];
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  installed: Set<string>;
  onNext: () => void;
}) {
  const { t, l, lang } = useT();
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("all");
  const [query, setQuery] = useState("");
  const required = useMemo(() => dependencies(recipes, selected), [recipes, selected]);

  const visible = recipes.filter(
    (r) =>
      (category === "all" || r.category === category) &&
      (!query || `${r.name} ${l(r.summary)} ${l(r.description)}`.toLowerCase().includes(query.toLowerCase())),
  );
  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };
  const applyPack = (p: Pack) => {
    const allIn = p.recipes.every((id) => selected.has(id) || required.has(id));
    const next = new Set(selected);
    p.recipes.forEach((id) => (allIn ? next.delete(id) : next.add(id)));
    setSelected(next);
  };
  const ram = recipes.filter((r) => selected.has(r.id) || required.has(r.id)).reduce((s, r) => s + r.ramMb, 0);
  const count = new Set([...selected, ...required.keys()]).size;

  return (
    <div class="catalog">
      <section>
        <h3 class="section-title">{t("catalog.packs")}</h3>
        <div class="packs">
          {packs.map((p) => {
            const active = p.recipes.every((id) => selected.has(id) || required.has(id));
            return (
              <button class={`pack ${active ? "active" : ""}`} onClick={() => applyPack(p)} type="button">
                <div class="pack-logos">
                  {p.recipes.map((id) => {
                    const r = recipes.find((x) => x.id === id)!;
                    return <RecipeLogo badge={r.badge} color={r.color} size={26} />;
                  })}
                </div>
                <b>{l(p.name)}</b>
                <span>{l(p.description)}</span>
                {active && <Icon name="check" class="pack-check" size={18} />}
              </button>
            );
          })}
        </div>
      </section>

      <div class="toolbar">
        <div class="chips" role="tablist">
          {CATEGORIES.map((c) => (
            <button type="button" class={`chip ${category === c ? "active" : ""}`} onClick={() => setCategory(c)}>
              {t(`cat.${c}` as Key)}
            </button>
          ))}
        </div>
        <div class="search">
          <Icon name="search" />
          <input value={query} placeholder={t("catalog.search")} onInput={(e) => setQuery(e.currentTarget.value)} />
        </div>
      </div>

      <div class="recipes">
        {visible.map((r) => {
          const isSel = selected.has(r.id);
          const isReq = required.has(r.id);
          const port = r.params.find((p) => p.id === "hostPort")?.default;
          return (
            <div
              class={`recipe ${isSel ? "selected" : ""} ${isReq ? "required" : ""}`}
              onClick={() => toggle(r.id)}
              role="checkbox"
              aria-checked={isSel || isReq}
              tabIndex={0}
              onKeyDown={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), toggle(r.id))}
            >
              <div class="recipe-head">
                <RecipeLogo badge={r.badge} color={r.color} />
                <div class="recipe-title">
                  <b>{r.name}</b>
                  <Badge tone={STATUS_TONE[r.status]} title={t(`status.${r.status}.help` as Key)}>
                    {t(`status.${r.status}` as Key)}
                  </Badge>
                </div>
                <span class={`check ${isSel || isReq ? "on" : ""}`}>{(isSel || isReq) && <Icon name="check" size={14} />}</span>
              </div>
              <p class="recipe-summary">{l(r.summary)}</p>
              <p class="recipe-desc">{l(r.description)}</p>
              <div class="recipe-meta">
                <span>
                  <Icon name="cpu" size={13} /> ~{r.ramMb} {lang === "fr" ? "Mo" : "MB"}
                </span>
                {port && (
                  <span>
                    <Icon name="globe" size={13} /> {t("catalog.port")} {String(port)}
                  </span>
                )}
                {installed.has(r.params.find((p) => p.id === "name")?.default as string) && <Badge tone="success">{t("catalog.installed")}</Badge>}
                {isReq && !isSel && <Badge tone="info">{`${t("catalog.required")} ${required.get(r.id)!.join(", ")}`}</Badge>}
              </div>
            </div>
          );
        })}
      </div>

      <div class="sticky-bar">
        <div class="sticky-info">
          <b>{count ? t("catalog.selected", { n: count }) : t("catalog.none")}</b>
          <RamGauge used={ram} label={t("catalog.ram")} help={t("catalog.ramHelp")} />
        </div>
        <Button variant="primary" size="lg" disabled={!count} onClick={onNext}>
          {t("catalog.next")}
          <Icon name="chevronRight" />
        </Button>
      </div>
    </div>
  );
}
