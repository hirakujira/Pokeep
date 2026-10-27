import { useState } from "react";
import { Layers3, LockKeyhole } from "lucide-react";
import { categoryLabels, effective, type Cost, type Pokemon } from "@/lib/types";
import { icons } from "./constants";
import { number } from "./format";

export function CostLine({ cost }: { cost: Cost | null }) {
  return cost ? (
    <span className="cost">
      {number(cost.dust)} 星塵 · {cost.candy} 糖
      {cost.xl > 0 ? ` · ${cost.xl} XL` : ""}
      <small>估算</small>
    </span>
  ) : (
    <span className="muted">目前等級未確定，成本待核對</span>
  );
}
export function Status({ category }: { category: keyof typeof categoryLabels }) {
  const Icon = icons[category];
  return (
    <span className={`badge ${category}`}>
      <Icon size={13} />
      {categoryLabels[category]}
    </span>
  );
}
export function Logo() {
  return (
    <div className="logo">
      <span className="brand-symbol" aria-hidden="true">
        <i />
      </span>
      Pokéep
    </div>
  );
}

export function PokemonSprite({ pokemon }: { pokemon: Pokemon }) {
  const fields = effective(pokemon);
  const source = fields.speciesId
    ? `/api/sprites/${encodeURIComponent(fields.speciesId)}?shiny=${fields.shiny ? "1" : "0"}`
    : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return (
    <span
      className="pokemon-token pokemon-sprite"
      title="PokéAPI 像素圖；特殊服裝以來源截圖為準"
    >
      {source && failedSource !== source ? (
        <img
          src={source}
          alt={`${fields.name || fields.speciesId}的物種參考像素圖`}
          loading="lazy"
          decoding="async"
          onError={() => setFailedSource(source)}
        />
      ) : (
        <Layers3 size={23} aria-label="沒有可用的像素圖" />
      )}
      {pokemon.locked ? (
        <span className="pokemon-sprite-badge" title="已鎖定">
          <LockKeyhole size={10} />
        </span>
      ) : fields.shadow ? (
        <span className="pokemon-sprite-badge" title="暗影寶可夢">
          ◈
        </span>
      ) : null}
    </span>
  );
}
