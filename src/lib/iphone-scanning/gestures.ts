import type { IphoneMcp } from "../iphone-mcp";
import { phoneVisionBottom, type PhonePage, type Target } from "../iphone-vision";
import {
  classify,
  inspectObservation,
  observe,
  type PhoneObservation,
} from "./phone";

type Point = { x: number; y: number };
// Calibrated on the supported portrait Pokémon GO layout. These only navigate
// read-only scanning; transfer actions continue to use verified targets.
export const scanPoint = {
  menu: { x: 0.865, y: 0.94 },
  appraise: { x: 0.69, y: 0.775 },
  appraisalDialog: { x: 0.5, y: 0.94 },
} as const;

export async function tapScan(
  phone: IphoneMcp,
  observation: PhoneObservation,
  point: Point,
) {
  if (!observation.image) throw new Error("沒有可用於點擊的手機截圖");
  const image = observation.image;
  const result = await phone.call<{ observation?: PhoneObservation }>("tap", {
    x: point.x * image.width * image.pixel_to_point[0],
    y: point.y * image.height * image.pixel_to_point[1],
    observation_id: observation.observation_id,
    observe: "screenshot",
  });
  return result.observation?.image?.pixel_to_point?.length === 2
    ? result.observation
    : observe(phone);
}

export async function swipeScan(
  phone: IphoneMcp,
  observation: PhoneObservation,
  direction: "up" | "left",
) {
  const result = await phone.call<{ observation?: PhoneObservation }>("swipe", {
    direction,
    observation_id: observation.observation_id,
    verify: false,
    observe: "screenshot",
  });
  return result.observation?.image?.pixel_to_point?.length === 2
    ? result.observation
    : observe(phone);
}

export async function tapInitialTarget(
  phone: IphoneMcp,
  observation: PhoneObservation,
  target: Target,
) {
  const page = await classify(observation, target);
  if (
    page.page !== "collection" ||
    !page.targetClear ||
    !page.target
  )
    throw new Error(`盒子畫面找不到 ${target}，已暫停`);
  return tapScan(phone, observation, {
    x: page.target.x,
    y: 0.055 + page.target.y * (phoneVisionBottom(target) - 0.055),
  });
}

export async function tapTarget(
  phone: IphoneMcp,
  observation: PhoneObservation,
  target: Target,
  expected: PhonePage["page"][],
  redactLocation = false,
) {
  const page = await classify(observation, target, redactLocation);
  if (
    !expected.includes(page.page) ||
    !page.targetClear ||
    !page.target ||
    !observation.image
  )
    throw new Error(`畫面沒有唯一且可點的 ${target}，已暫停`);
  const image = observation.image;
  const x = page.target.x * image.width * image.pixel_to_point[0];
  const y =
    (0.055 + page.target.y * (phoneVisionBottom(target) - 0.055)) *
    image.height *
    image.pixel_to_point[1];
  await phone.call("tap", { x, y, observation_id: observation.observation_id });
  const nextPages: Partial<Record<Target, PhonePage["page"][]>> = {
    first_pokemon: ["detail"],
    menu: ["menu"],
    appraise: ["appraisal"],
    advance_appraisal: ["appraisal", "detail"],
    close_appraisal: ["detail"],
    unfavorite: ["detail"],
    clear_search: ["collection"],
    clear_filters: ["collection"],
    back_to_collection: ["collection"],
    transfer: ["transfer_dialog", "warning"],
    confirm_transfer: ["collection"],
  };
  let next = await observe(phone);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!next.image?.path) return next;
    const state = await inspectObservation(next);
    if (nextPages[target]?.includes(state.page) && state.confidence >= 0.8)
      return next;
    if (
      state.page !== "loading" &&
      !(state.page === "other" && /空白|過渡|載入/.test(state.title))
    )
      return next;
    next = await observe(phone);
  }
  return next;
}
