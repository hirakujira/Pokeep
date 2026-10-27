import {
  ArrowUpRight,
  CircleHelp,
  ClipboardCheck,
  FolderHeart,
  Settings2,
  Smartphone,
  Swords,
  Trash2,
} from "lucide-react";
import { defaultSettings } from "@/lib/types";
import type { Scan, TransferBatch } from "@/lib/iphone-types";
import type { State, Tab } from "./types";

export const empty: State = {
  pokemon: [],
  settings: defaultSettings,
  snapshot: null,
  apiConfigured: false,
  model: "gpt-4.1-mini",
  runtime: {
    apiConfigured: false,
    model: "gpt-4.1-mini",
    baseUrl: "",
    analysisConcurrency: 6,
    shinyReviewConcurrency: 6,
    iphoneUseRoot: "/Users/Hiraku/Develop/utils/iPhone-use",
    iphoneUsePython: "python3",
  },
};
export const tabs = [
  { id: "iphone" as Tab, label: "iPhone 掃描", icon: Smartphone },
  { id: "results" as Tab, label: "清倉結果", icon: ClipboardCheck },
  { id: "settings" as Tab, label: "設定", icon: Settings2 },
];
export const scanStatusLabels: Record<Scan["status"], string> = {
  queued: "排隊中",
  running: "進行中",
  paused: "已暫停",
  completed: "已完成",
  stopped: "已停止",
  failed: "失敗",
};
export const entryStatusLabels: Record<TransferBatch["entries"][number]["status"], string> = {
  pending: "等待中",
  searching: "搜尋中",
  unfavoriting: "取消最愛中",
  prepared: "準備放生",
  sent: "已送出",
  submitted: "已點擊放生（未核對遊戲結果）",
  confirmed: "已放生",
  skipped: "已跳過",
  uncertain: "結果不確定",
};
export const icons = {
  transfer: Trash2,
  collect: FolderHeart,
  invest: Swords,
  evolve: ArrowUpRight,
  review: CircleHelp,
};
