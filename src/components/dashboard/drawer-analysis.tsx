import { ArrowUpRight, Check, Database, Info, Sparkles, Swords } from "lucide-react";
import type { Pokemon } from "@/lib/types";
import { localizeMoveText, moveName } from "@/lib/move-names";
import { localizeSpeciesName } from "@/lib/species-names";
import { typeName } from "@/lib/type-names";
import { date, evolutionCandySummary, number } from "./format";
import { MoveTrainingSection } from "./move-training";
import { CostLine, Status } from "./ui";

export function DrawerAnalysis({
  analysis: a,
  moveNames,
}: {
  analysis: Pokemon["analysis"];
  moveNames: Record<string, string>;
}) {
  const candySummary = evolutionCandySummary(a?.evolutionCandy);
  return (
    <div className="analysis-content">
      <div className={`decision-card ${a?.category || "review"}`}>
        <Status category={a?.category || "review"} />
        <h3>
          {a?.category === "transfer"
            ? "建議放生"
            : a?.category === "invest"
              ? "建議保留培養"
              : a?.category === "collect"
                ? "建議保留收藏"
                : a?.category === "evolve"
                  ? "建議進化（進化型未登錄）"
                  : "資料不足，請先核對"}
        </h3>
        {a?.reasons.map((r, i) => (
          <p key={i}>
            <Check size={14} />
            {localizeSpeciesName(localizeMoveText(r, moveNames))}
          </p>
        ))}
      </div>
      {a?.category === "evolve" && a.evolutionCandy && (
        <section className="analysis-section">
          <h3>進化糖果</h3>
          {candySummary && (
            <p className={`candy-readiness ${candySummary.tone}`}>{candySummary.label}</p>
          )}
          {a.evolutionCandy.options.map((option) => (
            <p key={option.speciesId}>
              {localizeSpeciesName(option.name, option.speciesId)}：需要 {option.required} 糖果
              {a.evolutionCandy?.available === null
                ? "；持有量未知"
                : a.evolutionCandy!.available >= option.required
                  ? "；糖果足夠"
                  : `；還差 ${option.required - a.evolutionCandy!.available} 糖果`}
              {option.condition ? `；其他條件：${option.condition}` : ""}
            </p>
          ))}
          <p className="caption">糖果足夠只表示數量達標；進化道具與其他條件仍須在遊戲中確認。</p>
        </section>
      )}
      {a?.actions.length ? (
        <section className="analysis-section">
          <h3>
            <ArrowUpRight size={17} />
            培養步驟
          </h3>
          {a.actions.map((action, i) => (
            <p className="action-item" key={i}>
              <span>{i + 1}</span>
              {localizeSpeciesName(localizeMoveText(action, moveNames))}
            </p>
          ))}
        </section>
      ) : null}
      {a?.moveTraining?.length ? (
        <MoveTrainingSection advice={a.moveTraining} moveNames={moveNames} />
      ) : null}
      {!!a?.leagues.length && (
        <section className="analysis-section">
          <h3>
            <Swords size={17} />
            PvP 聯盟價值
          </h3>
          <p className="caption">
            環境排名與個體 IV 排名分開比較；4,096 組合、等級上限 50。
          </p>
          {a.leagues.map((l) => (
            <div
              className={`league-card ${!l.eligible ? "ineligible" : ""}`}
              key={`${l.speciesId}/${l.league}`}
            >
              <div>
                <strong>{localizeSpeciesName(l.name, l.speciesId)}</strong>
                <span className="subtle-tag">
                  {l.league === 1500
                    ? "超級聯盟"
                    : l.league === 2500
                      ? "高級聯盟"
                      : "大師聯盟"}
                </span>
              </div>
              <div className="league-metrics">
                <span>
                  環境排名
                  <strong>
                    {l.metaRank ? `#${l.metaRank}` : "未列入"}
                  </strong>
                </span>
                <span>
                  個體 IV
                  <strong>
                    #{l.ivRank}
                    <small> / 4096</small>
                  </strong>
                </span>
                <span>
                  目標等級<strong>{l.level}</strong>
                </span>
                <span>
                  目標 CP<strong>{l.cp}</strong>
                </span>
              </div>
              <CostLine cost={l.cost} />
              {!l.eligible && (
                <p className="warning-text">
                  目前等級已超過此目標，或無法推算目前等級，不能直接用於此聯盟。
                </p>
              )}
              {l.level > 40 && (
                <p className="warning-text">
                  需要 XL 糖，列為長期目標。
                </p>
              )}
              <p className="caption">
                招式：
                {l.moves
                  .map(
                    (m) =>
                      moveName(m, moveNames),
                  )
                  .join("／") || "資料不足"}
                {l.elite.length
                  ? ` · 限定招式 ${l.elite.map((m) => moveName(m, moveNames)).join("、")}`
                  : ""}
              </p>
              <details>
                <summary>最佳夥伴加成另列</summary>
                <p className="caption">
                  同一個體目標等級再加一級後 CP {l.buddyCp}
                  ，可能超過聯盟上限，未納入 IV 排名。
                </p>
              </details>
            </div>
          ))}
        </section>
      )}
      {!!a?.raids.length && (
        <section className="analysis-section">
          <h3>
            <Swords size={17} />
            團體戰培養比較
          </h3>
          <p className="caption">
            固定防禦 150、中性傷害、同等級比較的簡化循環
            DPS；不是指定頭目排名。
          </p>
          {[...a.raids]
            .sort((x, y) => x.rank - y.rank)
            .map((r) => (
              <div
                className="raid-card"
                key={`${r.speciesId}/${r.type}`}
              >
                <div>
                  <strong>{localizeSpeciesName(r.name, r.speciesId)}</strong>
                  <span className="subtle-tag">
                    {typeName(r.type)} · 物種 #{r.rank}
                  </span>
                </div>
                <p>
                  Lv.35 基準 DPS <b>{r.dps.toFixed(2)}</b> ·{" "}
                  {moveName(r.fast, moveNames)}{" "}
                  /{" "}
                  {moveName(r.charge, moveNames)}
                </p>
                {r.targets.map((t) => (
                  <div className="raid-target" key={t.level}>
                    <strong>
                      Lv.{t.level}
                      <small>
                        CP {t.cp} · DPS {t.dps.toFixed(2)}
                      </small>
                    </strong>
                    <CostLine cost={t.cost} />
                  </div>
                ))}
                {r.condition && (
                  <p className="warning-text">{r.condition}</p>
                )}
                {r.elite.length > 0 && (
                  <p className="warning-text">
                    包含限定招式：{r.elite.map((m) => moveName(m, moveNames)).join("、")}
                    ；請確認厲害招式學習器或活動條件。
                  </p>
                )}
              </div>
            ))}
        </section>
      )}
      {a?.purification && (
        <section className="analysis-section">
          <h3>
            <Sparkles size={17} />
            淨化比較
          </h3>
          <div className="purification-card">
            <strong>淨化後 IV {a.purification.iv.join(" / ")}</strong>
            <span>預估 CP {a.purification.cp ?? "待確認"}</span>
            <p>{a.purification.verdict}</p>
            {a.purification.cost && (
              <p className="caption">
                淨化成本：{number(a.purification.cost.dust)} 星塵／
                {a.purification.cost.candy} 糖果。
              </p>
            )}
          </div>
        </section>
      )}
      {a?.warnings.length ? (
        <div className="analysis-warnings">
          <h3>
            <Info size={16} />
            計算限制與待補資訊
          </h3>
          <ul>
            {a.warnings.map((w) => (
              <li key={w}>{localizeSpeciesName(localizeMoveText(w, moveNames))}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="analysis-provenance">
        <Database size={14} />
        快照 {a?.snapshot || "尚無資料"} ·{" "}
        {a ? date(a.evaluatedAt) : "尚未評估"}
        <p>
          比較範圍：已掃描且仍持有的寶可夢。
          {a?.comparedWith.length
            ? `與 ${a.comparedWith.length} 隻相關個體比較。`
            : ""}
        </p>
      </div>
    </div>
  );
}
