import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  Film,
  LoaderCircle,
  LockKeyhole,
  X,
} from "lucide-react";
import { effective, fieldLabels, type Fields, type Pokemon } from "@/lib/types";
import { localizeMoveText, moveName } from "@/lib/move-names";
import { localizeSpeciesName, speciesCostume } from "@/lib/species-names";
import { costumeSpeciesKey, knownCostumes } from "@/lib/costumes";
import { DrawerAnalysis } from "./drawer-analysis";
import {
  displayPokemonName,
  reviewPromptsFor,
  sourceTime,
  speciesLabel,
} from "./format";
import {
  allGenders,
  dexEntries,
  formChoice,
  keptFormKey,
  lacksEvolutionButton,
  maxLimits,
  maxStatuses,
  restrictedChoice,
  shadowFields,
  shadowState,
  shadowStates,
  speciesLimits,
  speciesWithShadow,
  unknownForm,
  withFixedValues,
  type FormOption,
  type MaxStatus,
  type ShadowState,
} from "./species-options";
import type { Catalog } from "./types";
import { Status } from "./ui";

const genderLabels: Record<string, string> = {
  "": "未知",
  male: "雄性",
  female: "雌性",
  genderless: "無性別",
};
const shadowLabels: Record<string, string> = {
  "": "未確認",
  none: "一般",
  shadow: "暗影",
  purified: "暗影 - 已淨化",
};
const shadowKeys: (keyof Fields)[] = ["shadow", "purified"];
const maxLabels: Record<string, string> = {
  "": "未能確認",
  none: "一般個體",
  dynamax: "極巨化",
  gigantamax: "超極巨化",
};

export function PokemonDrawer({
  pokemon: p,
  records,
  catalog,
  error,
  onClose,
  onSave,
  onMerge,
  busy,
}: {
  pokemon: Pokemon;
  records: Pokemon[];
  catalog: Catalog;
  error: string;
  onClose: () => void;
  onSave: (data: unknown, announce?: boolean) => Promise<Pokemon | null>;
  onMerge: (id: string) => Promise<void>;
  busy: boolean;
}) {
  const [section, setSection] = useState("review"),
    [fields, setFields] = useState<Fields>(effective(p)),
    [speciesQuery, setSpeciesQuery] = useState(""),
    [dexChoice, setDexChoice] = useState<number | null>(null),
    [source, setSource] = useState(0),
    [verified, setVerified] = useState(p.verified),
    [evolutionSilhouette, setEvolutionSilhouette] = useState<boolean | "unavailable" | "unknown-branch" | null>(
      p.evolutionSilhouette,
    ),
    [maxStatus, setMaxStatus] = useState<Pokemon["maxStatus"]>(p.maxStatus),
    [dismiss, setDismiss] = useState(false),
    [saveReviewReasons, setSaveReviewReasons] = useState<string[] | null>(null),
    [proofError, setProofError] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null),
    panelRef = useRef<HTMLElement>(null),
    scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setFields(effective(p));
    setSpeciesQuery("");
    setDexChoice(null);
    setVerified(p.verified);
    setEvolutionSilhouette(p.evolutionSilhouette);
    setMaxStatus(p.maxStatus);
    setDismiss(false);
  }, [p.id, p.updatedAt, p.verified, p.locked, p.owned]);
  useEffect(() => {
    setProofError(false);
  }, [source]);
  useEffect(() => {
    const old = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const elements = Array.from(
          panelRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]',
          ) || [],
        );
        const first = elements[0],
          last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", key);
      old?.focus();
    };
  }, [onClose]);
  const a = p.analysis,
    activeSource = p.sources[Math.min(source, p.sources.length - 1)],
    moveNames = Object.fromEntries(catalog.moves.map((move) => [move.id, move.name]));
  const entries = useMemo(() => dexEntries(catalog.species, catalog.visualForms), [catalog]),
    speciesById = useMemo(() => new Map(catalog.species.map((s) => [s.id, s])), [catalog]),
    costumeNames = useMemo(() => knownCostumes(records), [records]);
  const reviewPrompts = reviewPromptsFor(p);
  const shown = withFixedValues(fields, speciesById);
  // A final evolution shows as such without storing anything; a stored
  // button state other than "unavailable" stays editable so the conflict can be fixed.
  const noEvolutionButton = lacksEvolutionButton(fields.speciesId, speciesById) &&
    (evolutionSilhouette === null || evolutionSilhouette === "unavailable");
  const maxShadow = ["shadow", "purified"].includes(shadowState(shown) ?? ""),
    maxChoice = restrictedChoice(
      maxStatuses, maxLimits(fields.speciesId, speciesById, shadowState(shown)), maxStatus ?? null,
    );
  const changes = Object.fromEntries(
    (Object.keys(shown) as (keyof Fields)[])
      .filter((key) => shown[key] !== effective(p)[key])
      .map((key) => [key, shown[key]]),
  );
  const set = (key: keyof Fields, value: Fields[keyof Fields]) => {
    setFields((f) => ({ ...f, [key]: value }));
    setVerified(false);
  };
  // keys lists every field one editor covers; the shadow editor also sets purified.
  const overridden = (keys: (keyof Fields)[]) => keys.some((k) => Object.hasOwn(p.overrides, k));
  const heading = (key: keyof Fields, keys = [key]) => (
    <span>
      {fieldLabels[key]}
      {overridden(keys) && <small>已修正</small>}
    </span>
  );
  const note = (key: keyof Fields, keys = [key]) => {
    const sources = p.sources.filter((s) => keys.some((k) => s.fields.includes(k))).length;
    return (
      <small>
        {sources ? `${sources} 張畫面可核對` : overridden(keys) ? "人工補充" : "來源未顯示"}
      </small>
    );
  };
  const entry = (() => {
    const dex = catalog.species.find((s) => s.id === fields.speciesId)?.dex ?? dexChoice;
    return dex === null
      ? entries.find((e) => e.name === fields.name)
      : entries.find((e) => e.dex === dex);
  })();
  const applyForm = (option: FormOption) => {
    setFields((f) => {
      const speciesId = option.speciesId && speciesWithShadow(option.speciesId, f.shadow, speciesById);
      // A costume that only came from the old costume-only ID does not carry over.
      const costume = f.costume === speciesCostume(f.speciesId) ? speciesCostume(speciesId) : f.costume;
      return { ...f, speciesId, form: option.form, costume };
    });
    setVerified(false);
  };
  const chooseDex = (dex: number | null) => {
    const next = entries.find((e) => e.dex === dex);
    setDexChoice(next?.dex ?? null);
    if (!next) {
      set("speciesId", null);
      return;
    }
    const kept = formChoice(next, null, fields.form).selected;
    // Unrecognised form text described the previous Pokémon, not this one.
    const option = kept.key === keptFormKey ? { ...kept, form: null } : kept;
    setFields((f) => ({ ...f, name: f.name || next.name }));
    applyForm(option);
  };
  const editor = (key: keyof Fields) => {
    const bool = ["shiny", "favorite"].includes(key),
      text = ["name", "costume"].includes(key),
      moves = ["fastMove", "chargeMove", "chargeMove2"].includes(key);
    if (key === "speciesId") {
      const query = speciesQuery.trim().replace(/^#/, "").toLocaleLowerCase();
      const matches = entries.filter((e) =>
        !query || String(e.dex).includes(query) ||
        e.name.toLocaleLowerCase().includes(query) ||
        e.options.some((o) =>
          o.label.toLocaleLowerCase().includes(query) || o.matches.some((m) => m.includes(query))));
      const options = entry && !matches.includes(entry) ? [entry, ...matches] : matches;
      return (
        <div className="edit-field" key={key}>
          {heading(key)}
          <input
            aria-label="搜尋寶可夢"
            value={speciesQuery}
            placeholder="搜尋中文名稱、圖鑑編號、形態或英文 ID"
            onChange={(e) => setSpeciesQuery(e.target.value)}
          />
          <select
            aria-label="全國圖鑑"
            value={entry?.dex ?? ""}
            onChange={(e) => chooseDex(Number(e.target.value) || null)}
          >
            <option value="">選擇寶可夢</option>
            {options.map((e) => (
              <option key={e.dex} value={e.dex}>{`#${e.dex} ${e.name}`}</option>
            ))}
          </select>
          <small>{query ? `找到 ${matches.length} 種寶可夢` : `${entries.length} 種寶可夢`}</small>
        </div>
      );
    }
    if (key === "form") {
      const choice = entry && formChoice(entry, fields.speciesId, fields.form);
      return (
        <label className="edit-field" key={key}>
          {heading(key)}
          <select
            value={choice?.selected.key ?? ""}
            disabled={!choice || choice.options.length < 2}
            onChange={(e) => {
              const option = choice?.options.find((o) => o.key === e.target.value);
              if (option) applyForm(option);
            }}
          >
            {choice
              ? choice.options.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))
              : <option value="">{unknownForm}</option>}
          </select>
          {note(key)}
        </label>
      );
    }
    if (key === "gender" || key === "shadow") {
      const limits = speciesLimits(fields.speciesId, speciesById);
      const choice: { options: (string | null)[]; value: string | null; fixed: boolean } =
        key === "gender"
          ? restrictedChoice(allGenders, limits.gender, fields.gender)
          : restrictedChoice(shadowStates, limits.shadow, shadowState(fields));
      // "無暗影形態" is only for species known to have no shadow form.
      const noShadowForm = limits.shadow !== undefined && !limits.shadow.includes("shadow");
      const labels = key === "gender"
          ? genderLabels
          : { ...shadowLabels, none: noShadowForm ? "無暗影形態" : shadowLabels.none },
        keys = key === "gender" ? [key] : shadowKeys;
      return (
        <label className="edit-field" key={key}>
          {heading(key, keys)}
          <select
            value={choice.value ?? ""}
            disabled={choice.fixed}
            onChange={(e) => {
              const value = e.target.value || null;
              if (key === "gender") return set(key, value as Fields["gender"]);
              const next = shadowFields(value as ShadowState | null);
              setFields((f) => ({
                ...f,
                ...next,
                speciesId: f.speciesId && speciesWithShadow(f.speciesId, next.shadow, speciesById),
              }));
              setVerified(false);
            }}
          >
            {choice.options.map((option) => (
              <option key={option ?? ""} value={option ?? ""}>
                {labels[option ?? ""]}
              </option>
            ))}
          </select>
          {note(key, keys)}
        </label>
      );
    }
    return (
      <label className="edit-field" key={key}>
        {heading(key)}
        {bool ? (
          <select
            value={fields[key] === null ? "" : String(fields[key])}
            onChange={(e) => set(key, e.target.value === "" ? null : e.target.value === "true")}
          >
            <option value="">未知</option>
            <option value="true">是</option>
            <option value="false">否</option>
          </select>
        ) : moves ? (
          <>
            <input
              list="move-options"
              value={fields[key] ? moveName(String(fields[key]), moveNames) : ""}
              placeholder="未顯示／未知"
              onChange={(e) => set(key, e.target.value || null)}
            />
          </>
        ) : (
          <input
            type={text ? "text" : "number"}
            list={key === "costume" ? "costume-options" : undefined}
            step={["height", "weight"].includes(key) ? "0.01" : "1"}
            min={0}
            max={key.startsWith("iv") ? 15 : undefined}
            value={String(fields[key] ?? "")}
            placeholder="未知"
            onChange={(e) =>
              set(
                key,
                e.target.value === ""
                  ? null
                  : text
                    ? e.target.value
                    : Number(e.target.value),
              )
            }
          />
        )}
        {note(key)}
      </label>
    );
  };
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={panelRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
      >
        <div className="drawer-heading">
          <div>
            <h2 id="drawer-title">
              {displayPokemonName(fields.name || "待辨識個體", fields.costume, fields.speciesId)}
              <Status category={a?.category || "review"} />
            </h2>
            <p>
              {speciesLabel(catalog, fields.speciesId, fields.name)} · {p.sources.length}{" "}
              張來源畫面
            </p>
          </div>
          <button
            ref={closeButton}
            className="icon-button"
            aria-label="關閉個體詳情"
            onClick={onClose}
          >
            <X size={21} />
          </button>
        </div>
        <div className="drawer-tabs">
          {[
            { id: "review", label: "辨識核對" },
            { id: "analysis", label: "分析建議" },
            { id: "sources", label: "來源證據" },
          ].map((t) => (
            <button
              className={section === t.id ? "active" : ""}
              key={t.id}
              onClick={() => setSection(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div ref={scrollRef} className="drawer-scroll">
          {error && (
            <div className="alert error" role="alert">
              <CircleHelp size={16} />
              <span>{error}</span>
            </div>
          )}
          {section === "review" && saveReviewReasons && (
            <div className="alert error review-save-error" role="alert">
              <CircleHelp size={16} />
              <div>
                <strong>已儲存，但仍無法判定。請確認：</strong>
                <ul>
                  {saveReviewReasons.map((reason, i) => (
                    <li key={i}>{localizeSpeciesName(localizeMoveText(reason, moveNames))}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {section === "review" && (
            <>
              {!saveReviewReasons && reviewPrompts.length > 0 && (
                <details className="review-issues" open>
                  <summary>
                    <CircleHelp size={15} />
                    請對照來源畫面確認（{reviewPrompts.length}）
                  </summary>
                  <ul>
                    {reviewPrompts.map((reason, i) => (
                      <li key={i}>{localizeSpeciesName(localizeMoveText(reason, moveNames))}</li>
                    ))}
                  </ul>
                </details>
              )}
              {p.candidates.length > 0 && (
                <div className="candidate-box">
                  <h3>疑似同一隻寶可夢</h3>
                  <p>核對來源後再合併；如果確定是不同個體，請勾選下方選項。</p>
                  {p.candidates.map((candidate) => {
                    const peer = records.find((r) => r.id === candidate);
                    if (!peer) return null;
                    const f = effective(peer);
                    return (
                      <div key={candidate}>
                        <span>
                          {f.name || "未辨識"} · CP {f.cp ?? "?"} ·{" "}
                          {peer.sources.length} 張來源
                        </span>
                        <button
                          className="button small secondary"
                          disabled={busy}
                          onClick={() => void onMerge(candidate)}
                        >
                          合併至此個體
                        </button>
                      </div>
                    );
                  })}
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={dismiss}
                      onChange={(e) => setDismiss(e.target.checked)}
                    />
                    我確認這些是不同個體，解除疑似配對
                  </label>
                </div>
              )}
              <div className="review-layout">
                <div className="review-proof">
                  {activeSource && !proofError ? (
                    <img
                      src={`/api/frames/${activeSource.frame}`}
                      alt={`iPhone 掃描 ${sourceTime(activeSource)} 來源截圖`}
                      onError={() => setProofError(true)}
                    />
                  ) : (
                    <div className="missing-proof">
                      <Film size={28} />
                      來源截圖不存在
                    </div>
                  )}
                  {activeSource && (
                    <div>
                      <strong>{sourceTime(activeSource)}</strong>
                      <small>iPhone 掃描</small>
                      <button
                        className="text-button"
                        onClick={() => setSection("sources")}
                      >
                        查看所有來源
                        <ArrowRight size={13} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="edit-fields">
                  <h3>基本資訊</h3>
                  {(
                    [
                      "name",
                      "speciesId",
                      "form",
                      "cp",
                      "hp",
                      "gender",
                      "height",
                      "weight",
                    ] as (keyof Fields)[]
                  ).map(editor)}
                  <h3>收藏與個體能力</h3>
                  {(
                    [
                      "shadow",
                      "shiny",
                      "costume",
                      "favorite",
                      "ivAtk",
                      "ivDef",
                      "ivSta",
                    ] as (keyof Fields)[]
                  ).map(editor)}
                  <h3>目前招式</h3>
                  {(
                    [
                      "fastMove",
                      "chargeMove",
                      "chargeMove2",
                    ] as (keyof Fields)[]
                  ).map(editor)}
                  <label className="edit-field">
                    <span>進化按鈕狀態</span>
                    <select
                      value={
                        noEvolutionButton
                          ? "unavailable"
                          : evolutionSilhouette === null
                            ? ""
                            : String(evolutionSilhouette)
                      }
                      disabled={noEvolutionButton}
                      onChange={(event) =>
                        setEvolutionSilhouette(
                          event.target.value === ""
                            ? null
                            : event.target.value === "unavailable"
                              ? "unavailable"
                              : event.target.value === "unknown-branch"
                                ? "unknown-branch"
                                : event.target.value === "true",
                        )
                      }
                    >
                      <option value="">未能確認</option>
                      <option value="true">未登錄剪影</option>
                      <option value="false">已登錄彩色圖示</option>
                      <option value="unknown-branch">進化結果不明（例如問號）</option>
                      <option value="unavailable">
                        {noEvolutionButton ? "無法進化" : "無法進化（沒有進化按鈕）"}
                      </option>
                    </select>
                    <small>從招式頁判定；問號代表有進化按鈕，但無法確定結果。特殊造型等個體可能沒有進化按鈕。</small>
                  </label>
                  <label className="edit-field">
                    <span>極巨化狀態</span>
                    <select
                      value={maxChoice.value ?? ""}
                      disabled={maxChoice.fixed}
                      onChange={(event) => setMaxStatus(
                        event.target.value === "" ? null : event.target.value as MaxStatus,
                      )}
                    >
                      {maxChoice.options.map((value) => (
                        <option key={value ?? ""} value={value ?? ""}>
                          {value === "none" && maxChoice.fixed
                            ? maxShadow ? "一般個體（暗影或淨化個體無法極巨化）" : "一般個體（此物種未開放極巨化）"
                            : maxLabels[value ?? ""]}
                        </option>
                      ))}
                    </select>
                    <small>依能力頁上的極巨化徽章判定；可在此人工修正。</small>
                  </label>
                  <details className="cost-edit">
                    <summary>
                      資源與畫面顯示成本
                      <ChevronDown size={14} />
                    </summary>
                    <div className="edit-fields">
                      {(
                        [
                          "candy",
                          "xlCandy",
                          "stardust",
                          "powerUpDust",
                          "powerUpCandy",
                        ] as (keyof Fields)[]
                      ).map(editor)}
                    </div>
                  </details>
                  <datalist id="costume-options">
                    {(fields.speciesId ? costumeNames.get(costumeSpeciesKey(fields.speciesId))?.names ?? [] : [])
                      .map((name) => <option key={name} value={name} />)}
                  </datalist>
                  <datalist id="move-options">
                    {catalog.moves.map((m) => (
                      <option key={m.id} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </datalist>
                </div>
              </div>
            </>
          )}
          {section === "analysis" && (
            <DrawerAnalysis analysis={a} moveNames={moveNames} />
          )}
          {section === "sources" && (
            <div className="sources-view">
              <p>點選截圖可回到「辨識核對」對照欄位。</p>
              <div className="source-grid">
                {p.sources.map((s, i) => (
                  <button
                    className={source === i ? "selected" : ""}
                    key={`${s.observationId}-${i}`}
                    onClick={() => {
                      setSource(i);
                      setSection("review");
                    }}
                  >
                    <img
                      src={`/api/frames/${s.frame}`}
                      alt={`iPhone 掃描 ${sourceTime(s)} 來源畫面`}
                      loading="lazy"
                    />
                    <strong>{sourceTime(s)}</strong>
                    <small>iPhone 掃描</small>
                    <span>{s.fields.length} 個可見欄位</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="drawer-footer">
          <div>
            <button
              className={`button small ${p.locked ? "locked-button" : "secondary"}`}
              disabled={busy}
              onClick={() => void onSave({ locked: !p.locked })}
            >
              <LockKeyhole size={14} />
              {p.locked ? "已鎖定保留" : "鎖定保留"}
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void onSave({ owned: !p.owned })}
            >
              {p.owned ? "標記已放生" : "恢復為持有"}
            </button>
          </div>
          {section === "review" ? (
            <div className="drawer-save-controls">
              <label className="drawer-verify">
                <input
                  type="checkbox"
                  checked={verified}
                  disabled={busy}
                  onChange={(e) => setVerified(e.target.checked)}
                />
                我已核對來源畫面與上述資料
              </label>
              <button
                className="button primary"
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    const updated = await onSave({
                      fields: changes,
                      verified,
                      evolutionSilhouette,
                      maxStatus: maxChoice.value,
                      dismissCandidates: dismiss,
                    }, false);
                    if (!updated) return;
                    if (updated.analysis && updated.analysis.category !== "review") {
                      onClose();
                      return;
                    }
                    const missing = reviewPromptsFor(updated);
                    setSaveReviewReasons(missing.length ? missing : [
                      "資料仍無法可靠分類，請確認物種、CP、HP、IV 與特殊狀態",
                    ]);
                    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                  })();
                }}
              >
                {busy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Check size={15} />
                )}
                儲存並重新評估
              </button>
            </div>
          ) : (
            <button
              className="button secondary"
              onClick={() => setSection("review")}
            >
              <ArrowLeft size={14} />
              回到核對
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
