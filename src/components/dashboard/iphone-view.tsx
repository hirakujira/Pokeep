import { ArrowUpRight, Trash2 } from "lucide-react";
import { scanStatusLabels } from "./constants";
import { duration } from "./format";
import type { PhoneState, PhoneStatus } from "./types";
import type { ScanActions } from "./use-scan-actions";

export function IphoneView({
  phoneState,
  phoneStatus,
  apiConfigured,
  busy,
  actions,
}: {
  phoneState: PhoneState | null;
  phoneStatus: PhoneStatus;
  apiConfigured: boolean;
  busy: string;
  actions: ScanActions;
}) {
  return (
    <div className="iphone-workspace">
      <section className="panel iphone-panel">
        <div className="panel-heading">
          <div>
            <h2>手機連線</h2>
            <p>用 USB 連接並解鎖 iPhone，在 Pokémon GO 打開寶可夢盒子。</p>
          </div>
          <span className={`status-pill ${phoneStatus.tone}`}>
            {phoneStatus.label}
          </span>
        </div>
        <p className="iphone-status">
          {phoneState?.worker
            ? phoneState.worker.message
            : "背景服務未啟動，請用 npm run dev 或 npm start 啟動。"}
        </p>
        <small className="muted">
          {phoneState?.worker?.version
            ? `iPhone Use ${phoneState.worker.version}`
            : "首次使用需先完成 iPhone Use 的裝置信任、開發者模式與 WDA 簽名。"}
        </small>
        <div className="iphone-actions">
          <button
            className="button secondary"
            disabled={!phoneState?.worker || !!busy}
            onClick={actions.preparePhone}
          >
            檢查連線
          </button>
          <a
            className="text-link"
            href="https://github.com/zhongerxin/iPhone-use#先在自己的-iphone-上安装并启动-wda"
            target="_blank"
            rel="noreferrer"
          >
            首次設定指引
            <ArrowUpRight size={14} />
          </a>
        </div>
      </section>
      <section className="panel iphone-panel">
        <div className="panel-heading">
          <div>
            <h2>掃描</h2>
            <p>先截圖所有寶可夢，再統一辨識與分析。掃描不會放生任何寶可夢。</p>
          </div>
        </div>
        <div className="segmented" role="radiogroup" aria-label="掃描範圍">
          <label>
            <input
              type="radio"
              name="scan-scope"
              checked={actions.scanScope === "results"}
              onChange={() => actions.setScanScope("results")}
            />
            目前搜尋結果
          </label>
          <label>
            <input
              type="radio"
              name="scan-scope"
              checked={actions.scanScope === "all"}
              onChange={() => actions.setScanScope("all")}
            />
            整個寶可夢盒子
          </label>
        </div>
        <button
          className="button primary"
          disabled={
            !phoneState?.worker ||
            !apiConfigured ||
            !!busy ||
            ["queued", "running"].includes(
              phoneState?.scan?.status || "",
            ) ||
            ["approved", "running"].includes(
              phoneState?.batch?.status || "",
            )
          }
          onClick={actions.startScan}
        >
          開始掃描
        </button>
        {!apiConfigured && (
          <p className="job-error">
            請先到「設定」頁填入 API key。
          </p>
        )}
      </section>
      {phoneState?.scan && (
        <ScanProgressPanel scan={phoneState.scan} busy={busy} actions={actions} />
      )}
    </div>
  );
}

function ScanProgressPanel({
  scan,
  busy,
  actions,
}: {
  scan: NonNullable<PhoneState["scan"]>;
  busy: string;
  actions: ScanActions;
}) {
  return (
    <section className="panel iphone-panel">
      <div className="panel-heading">
        <div>
          <h2>掃描進度</h2>
          <p>{scan.stage}</p>
        </div>
        <span className="subtle-tag">{scanStatusLabels[scan.status]}</span>
      </div>
      <div className="iphone-metrics">
        <strong>{scan.scanned} 隻已截圖</strong>
        <span>{scan.analyzed} 隻已解析</span>
        <span>
          {scan.expected === null
            ? "總數待確認"
            : `預計 ${scan.expected} 隻`}
        </span>
        <span>{scan.review} 隻待人工核對</span>
        {scan.timing && (
          <>
            <span>平均每隻（{scan.timing.phase === "capture" ? "截圖" : "解析"}）：{duration(scan.timing.averageMs)}</span>
            <span>已用時間（含暫停）：{duration(scan.timing.elapsedMs)}</span>
            <span>預計剩餘（{scan.timing.phase === "capture" ? "截圖" : "解析"}）：{
              scan.status === "paused" ? "暫停中" :
              scan.status === "completed" ? "已完成" :
              scan.status === "stopped" ? "已停止" :
              scan.timing.phase === "capture" && scan.expected === null
                ? "總數未知"
                : duration(scan.timing.remainingMs)
            }</span>
          </>
        )}
        <span>{scan.apiUsage.navigationRequests} 次畫面判斷</span>
        <span>{scan.apiUsage.dataRequests} 次資料辨識</span>
      </div>
      {scan.timing && (
        <p className="caption">剩餘時間依近期每隻速度估算，截圖與解析分階段計算；長時間暫停不列入平均。</p>
      )}
      <p className="muted">
        範圍：
        {scan.scope === "all"
          ? "整個盒子"
          : "目前搜尋結果"}{" "}
        · 排序：{scan.sort || "未讀取"}
      </p>
      {scan.error && (
        <p className="job-error">{scan.error}</p>
      )}
      {scan.phase === "analysis" && (
        <p className="caption">
          {scan.scanned} 隻截圖已保存，還有{" "}
          {Math.max(0, scan.scanned - scan.analyzed)}
          {" "}隻待解析；解析完成後會自動標為完成，不需操作手機。
        </p>
      )}
      {scan.currentFrame && (
        <img
          className="iphone-frame"
          src={`/api/frames/${scan.currentFrame}`}
          alt="目前掃描個體的來源畫面"
        />
      )}
      <div className="iphone-actions">
        {["queued", "running"].includes(scan.status) && (
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => actions.pauseScan(scan)}
          >
            暫停
          </button>
        )}
        {(scan.status === "paused" ||
          (scan.status === "stopped" && scan.phase === "analysis")) && (
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => actions.resumeScan(scan)}
          >
            {scan.phase === "analysis" ? "繼續解析" : "繼續截圖"}
          </button>
        )}
        {scan.status === "paused" &&
          scan.phase !== "analysis" &&
          scan.expected === null &&
          scan.scanned > 0 && (
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={() => actions.finishCapture(scan)}
            >
              確認已到列表終點並開始解析
            </button>
          )}
        {["queued", "running", "paused"].includes(
          scan.status,
        ) && (
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => actions.stopScan(scan)}
          >
            停止
          </button>
        )}
        {["paused", "stopped", "failed"].includes(
          scan.status,
        ) && (
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={() => actions.discardScans(scan)}
          >
            <Trash2 size={15} />
            清除未完成掃描並重來
          </button>
        )}
      </div>
      {["paused", "stopped", "failed"].includes(
        scan.status,
      ) && (
        <p className="muted">
          清除後請在遊戲返回寶可夢盒子列表，再按上方「開始掃描」。
        </p>
      )}
    </section>
  );
}
