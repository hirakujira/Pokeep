# Pokékeep · Pokémon GO 錄影分析與清倉助手

繁體中文本機網頁：匯入評價／能力錄影，透過 OpenAI 辨識、核對來源，依團體戰、PvP 與收藏代表整理去留及培養路線。

## 啟動

需要 Node.js **24 LTS**（使用內建 SQLite）。

```sh
npm install
cp .env.example .env.local
# 在 .env.local 設定 OPENAI_API_KEY；不需要把 key 填進瀏覽器
npm run data:update
npm run dev
```

開啟 **http://127.0.0.1:3000**。未設定 API key 時，可以選擇「先抽幀，人工核對」，所有個體保持待確認。API 使用自己的 OpenAI 額度，與 ChatGPT 訂閱額度分開。

正式本機啟動：`npm run build` 後執行 `npm start`。兩種啟動方式都只監聽 `127.0.0.1`。`PORT=3001 npm start` 可切換埠號。

## 使用

1. 在遊戲開啟隊長評價，每隻停留 1～2 秒；另外錄下能力、招式及成本。
2. 同批匯入多段 MP4／MOV，每段最多 500 MB、10 分鐘，每批最多 20 段。
3. 等候抽幀與辨識，點選個體核對名稱、形態、IV、暗影／色違狀態及招式。疑似重複可合併，或確認為不同個體。欄位空白代表未知。
4. 勾選「我已核對」並儲存，重新計算收藏庫。資料仍不足的個體保持待確認。
5. 查看放生、收藏及培養建議；可鎖定保留、標記已放生／恢復，或從設定匯出完整 JSON 備份及 CSV。

新資料不會覆蓋人工修正；有衝突會重新要求核對。合併也保留欄位來源與既有修正。不同個體即使 CP 一樣，也不直接合併；跨影片必須物種、CP、HP、性別、身高、體重一致且候選唯一。遊戲沒有暴露穩定個體 ID，因此持續培養後 CP 改變的配對需人工確認。

## 判斷依據與界線

- **PvP**：PvPoke 三大開放聯盟環境排名，與各物種／合法進化分支的 4,096 組 IV 統計乘積排名分開顯示。等級上限 50，CP 上限 1,500／2,500；大師聯盟比較滿等能力。最佳夥伴加一級的 CP 另列，不混入 IV 排名。已超過目標等級的個體不建議進入該聯盟。
- **團體戰**：使用 Game Master **PvE** 招式資料，以等級 35、15 攻 IV 排物種基準；個體再套用自己的攻 IV。固定對方防禦 150、中性傷害、STAB 1.2 與暗影傷害 1.2，快招次數 `ceil(-特殊招式能量 / 快招能量)`，循環傷害除以耗時。同屬性快／特殊招式組合各取最佳，預設物種前十、每屬性保留六隻。這是簡化循環 DPS，**不是特定頭目的模擬、存活時間或實戰總傷害排名**。
- **培養**：比較等級 30／35 與 PvP 目標的星塵／糖果／XL 成本。等級需由 CP、HP、IV 唯一確定才顯示總成本；成本明示估算，遊戲活動折扣、特殊物種成本、限定招式與額外進化任務須核對遊戲。成本包含路線進化糖果；換招與開第二招另列，不宣稱已擁有學習器。
- **淨化**：IV 每項加二、上限十五，預估至少等級 25 的 CP；另檢查淨化後的 PvP 潛力與聯盟等級限制。暗影價值不以 IV 星數取代，也不因淨化能滿 IV 就推薦淨化。
- **清倉**：色違、服裝、形態、傳說／幻之、滿 IV、零 IV 各留代表。核對完整、未入選戰鬥名額或收藏代表的才列為可放生；未核對個體不擠掉已核對個體的戰鬥名額。只比較已匯入且仍持有的個體。
- 第一版以繁體中文直式 iPhone 錄影為主要版型，不分析極巨對戰、限時盃賽或交換最佳化。暱稱、短暫滑動、圖示遮擋及視窗會降低辨識可靠性，必須核對。

## 資料、隱私與檔案

所有個體、工作、證據與快照位於忽略版控的 `.data/`，可用 `POGO_DATA_DIR` 指定其他絕對目錄。SQLite 使用 WAL；請優先透過頁面匯出備份，避免服務運行時只複製單一 SQLite 檔案。

- 影片在本機抽幀，僅送必要裁切截圖至 OpenAI Responses API（`store: false`）；不會上傳整段影片。
- 支援版型會裁掉狀態列與評價頁捕獲地點區；其他捲動位置／版型不能保證完全遮蔽，匯入前請避免露出不想傳送的資訊。辨識文字不保存捕獲地點、日期或玩家姓名。
- 完成、失敗或取消後清除上傳的影片副本；保留截圖、已完成辨識及快取。AI 失敗可利用截圖重試；若在完成抽幀前取消，須重新匯入原片。來源檔案本身不會改動。
- API key 僅放 `.env.local` 或後端環境，不會進入資料庫、備份或瀏覽器回應。
- JSON 備份包含個體、觀測、來源截圖、目前快照及偏好，上限 150 MB；還原略過既有 ID，不覆蓋既有人工修正。原片、API key、模型快取不在備份中。
- 前端字型使用系統字型，無需外部字型服務。此專案僅供私人本機使用，沒有登入或公開部署設定。

資料由設定頁「更新遊戲資料」或 `npm run data:update` 更新。全部來源通過檢查才切換快照，失敗保留舊版本。資料來源：

- [PvPoke](https://github.com/pvpoke/pvpoke) 遊戲資料與排名，MIT；保留授權於 `THIRD_PARTY_NOTICES.md`。
- [PokeMiners Game Master](https://github.com/PokeMiners/game_masters) 及 [繁體中文文字](https://github.com/PokeMiners/pogo_assets)，原始內容權利屬 Pokémon 與遊戲權利人。
- [OpenAI 視覺輸入](https://developers.openai.com/api/docs/guides/images-vision) 與 [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)。

## 驗證

```sh
npm test
npm run typecheck
npm run build
npm run video:inspect -- '/absolute/path/video.MP4'
npm run references:validate -- '/absolute/path/appraisal.MP4' '/absolute/path/details.MP4'
```

最後一個指令專供此次提供的兩段參考影片，檢查人工標註的 11 隻個體、評價條量測及 CP／HP／等級一致性，報告存入 `.data/reference-validation.json`。加上 `--import` 可將這批**人工整理、非 AI 辨識**的參考個體匯入收藏庫供核對，重跑不覆蓋既有紀錄。完整清單在 `tests/fixtures.ts`。

自動測試涵蓋 CP、IV 4,096 組排名、跨聯盟上限、進化限制、淨化、收藏代表、模糊配對、資料衝突、備份還原、串流上傳、抽幀／清理、缺 key、SDK 結構化回應、限流重試及取消。SDK 測試使用攔截的模擬 HTTP 回應，不消耗 API 額度；實際雲端辨識須另以有效 API key 驗證。

## 本機介面

所有寫入需同源與 `x-pogo-local: 1` 標頭。

| 介面                                          | 用途                             |
| --------------------------------------------- | -------------------------------- |
| `GET /api/state`、`GET /api/species`          | 工作、收藏、設定與名稱目錄       |
| `POST /api/jobs`                              | 建立批次                         |
| `PUT /api/jobs/:id/files?name=...`            | 以原始檔案內容串流上傳           |
| `POST /api/jobs/:id/start`                    | `{ "manual": false }` 啟動／重試 |
| `POST /api/jobs/:id/cancel`                   | 取消及清理                       |
| `PATCH /api/pokemon/:id`                      | 修正欄位、核對、鎖定與持有狀態   |
| `POST /api/merge`                             | 人工合併疑似重複                 |
| `POST /api/reevaluate`、`PATCH /api/settings` | 重新計算與偏好                   |
| `POST /api/data/update`                       | 驗證並切換遊戲快照               |
| `GET /api/export`、`POST /api/import`         | JSON 備份／還原                  |
| `GET /api/export?format=csv`                  | CSV 清單                         |
| `GET /api/frames/:job/:file.jpg`              | 本機證據截圖                     |
