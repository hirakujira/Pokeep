import type { IphoneMcp } from "../iphone-mcp";
import { inspectPhoneImage, type PhonePage, type Target } from "../iphone-vision";

export type PhoneObservation = {
  app: string;
  observation_id: string;
  image?: {
    path: string;
    width: number;
    height: number;
    pixel_to_point: number[];
  };
  viewport: { width: number; height: number };
};

const pageCache = new Map<string, PhonePage>();
export async function inspectObservation(
  observation: PhoneObservation,
  target: Target | null = null,
  redactLocation = false,
) {
  if (!observation.image?.path) throw new Error("手機沒有回傳截圖");
  const key = `${observation.observation_id}:${observation.image.path}:${target || "page"}:${redactLocation}`;
  const cached = pageCache.get(key);
  if (cached) return cached;
  const page = await inspectPhoneImage(
    observation.image.path,
    target,
    redactLocation,
  );
  if (pageCache.size >= 64) pageCache.delete(pageCache.keys().next().value!);
  pageCache.set(key, page);
  return page;
}

type Setup = {
  ok?: boolean;
  error?: string;
  configured?: boolean;
  service?: { ready?: boolean; reachable?: boolean };
  jobs?: {
    id: string;
    action?: string;
    state?: string;
    error?: string;
    next_steps?: string[];
  }[];
  job_id?: string;
};

async function waitForService(phone: IphoneMcp, status: Setup) {
  const latestBuild = [...(status.jobs || [])]
    .reverse()
    .find((row) => row.action === "build");
  if (latestBuild?.state === "failed")
    throw new Error(
      `WDA 建置失敗：${latestBuild.error || "請檢查 Xcode 簽名"} ${latestBuild.next_steps?.join("；") || "請在 Xcode Settings → Accounts 登入開發團隊後重新建置。"}`,
    );
  const job = status.jobs?.find(
    (row) =>
      ["queued", "running"].includes(row.state || "") &&
      ["start", "recover"].includes(row.action || ""),
  );
  let result: Setup;
  if (job)
    result = await phone.call<Setup>(
      "setup",
      { action: "status", job_id: job.id, wait_seconds: 20 },
      45000,
    );
  else if (status.service?.reachable === false)
    result = await phone.call<Setup>("setup", { action: "start" }, 45000);
  else
    throw new Error("WDA 狀態不明，請在 iPhone Use 檢查連線；未重複啟動服務");
  if (result.ok === false) throw new Error(result.error || "WDA 啟動失敗");
  const jobId = result.job_id || job?.id;
  for (let check = 0; !result.service?.ready && jobId && check < 2; check++) {
    result = await phone.call<Setup>(
      "setup",
      { action: "status", job_id: jobId, wait_seconds: 20 },
      45000,
    );
    if (result.ok === false) throw new Error(result.error || "WDA 啟動失敗");
  }
  if (!result.service?.ready)
    throw new Error(
      "WDA 仍在啟動或等待裝置信任；請稍後檢查連線，不會重複啟動",
    );
}

export async function ensureReady(phone: IphoneMcp) {
  const status = await phone.call<Setup>("setup", { action: "status" });
  if (status.ok === false)
    throw new Error(status.error || "iPhone Use 設定檢查失敗");
  if (!status.configured)
    throw new Error(
      "iPhone Use 尚未設定。請先連接並信任 iPhone，在 Xcode 設定 Apple 開發團隊，完成 WDA 首次安裝。詳見 iPhone Use setup 指引。",
    );
  if (!status.service?.ready) await waitForService(phone, status);
  const ready = await phone.call<{
    ready?: boolean;
    observation?: PhoneObservation;
    state?: string;
  }>("ready", { recover: true, screenshot: false });
  if (!ready.ready || !ready.observation)
    throw new Error(
      `iPhone 尚未 READY：${ready.state || "請解鎖並確認 USB 連接"}`,
    );
  return ready.observation;
}

export async function observe(phone: IphoneMcp): Promise<PhoneObservation> {
  const result = await phone.call<PhoneObservation>("observe", {
    mode: "screenshot",
  });
  if (
    !result.image?.path ||
    !result.image.width ||
    !result.image.height ||
    !result.image.pixel_to_point
  )
    throw new Error("手機截圖缺少尺寸或座標比例");
  return result;
}

export async function classify(
  observation: PhoneObservation,
  target: Target | null = null,
  redactLocation = false,
) {
  const page = await inspectObservation(observation, target, redactLocation);
  if (
    page.confidence < 0.8 ||
    page.hasUnexpectedOverlay ||
    page.page === "loading" ||
    page.page === "other"
  )
    throw new Error(`無法可靠辨識遊戲畫面：${page.title || page.page}，已暫停`);
  return page;
}

export async function identifyGame(phone: IphoneMcp, first: PhoneObservation) {
  const apps = await phone.call<{
    candidates?: {
      bundle_id: string;
      installed_verified: boolean;
      name: string;
    }[];
  }>("apps", { query: "Pokémon GO", source: "installed", limit: 10 });
  const match = apps.candidates?.find(
    (row) => row.installed_verified && /Pok[eé]mon GO/i.test(row.name),
  );
  if (!match)
    throw new Error("裝置未證實安裝 Pokémon GO，或無法讀取已安裝 App 清單");
  if (first.app === match.bundle_id)
    return first.image ? first : observe(phone);
  await phone.call("launch_app", { bundle_id: match.bundle_id, verify: true });
  return observe(phone);
}
