# Pokéep · Pokémon GO iPhone 自動掃描與清倉助手

在 Mac 本機執行的網頁工具。它透過 [iPhone Use](https://github.com/zhongerxin/iPhone-use) 以 USB 操作 iPhone，自動掃描 Pokémon GO 的寶可夢盒子，用 OpenAI 辨識畫面，再依團體戰、PvP 與收藏價值給出保留或放生建議。沒有登入或公開部署，僅供私人本機使用。

## 需求

- macOS、Node.js **24 LTS**（使用內建 SQLite）
- OpenAI API key，或支援 Responses API 的相容伺服器
- iPhone Use 及其依賴：完整 Xcode、可簽名的 Apple 開發團隊、Python 3.9+、以 USB 連接的 iPhone

## 1. 安裝 iPhone Use

建議把 iPhone Use 放在 Pokéep 專案的同一層資料夾，Pokéep 不用設定就會找到：

```sh
cd <Pokéep 專案的上層資料夾>
git clone https://github.com/zhongerxin/iPhone-use.git
```

```text
上層資料夾/
├── Pokéep/       ← 本專案
└── iPhone-use/   ← iPhone Use 原始碼
```

接著完成 iPhone Use 的首次設定：USB 連接並信任 iPhone、開啟開發者模式、在 Xcode 用自己的 Apple 開發團隊簽名，並安裝、啟動手機端的 WDA。最簡單的做法是把 [iPhone Use README](https://github.com/zhongerxin/iPhone-use#用一段提示词让-codex-安装) 裡的安裝提示詞貼給 Codex（或 WorkBuddy、豆包工作），讓助手協助完成，直到 `pua_ready` 回報 `ready=true`；請告訴助手沿用上面 clone 的資料夾。也可以依該 README 的說明在 Xcode 手動處理。

首次設定完成後，Pokéep 會沿用同一份設定，需要時自行啟動 WDA。若 WDA 回報 `No Account for Team`，請確認 iPhone Use 設定的 Team ID 與 Xcode 目前登入帳號的團隊一致。

### 指定 iPhone Use 路徑

預設路徑是 Pokéep 專案旁的 `../iPhone-use`。若放在其他位置：

1. 啟動 Pokéep（見下一節），開啟「設定」頁。
2. 在「iPhone Use → 專案位置」填入 iPhone Use 原始碼資料夾的**絕對路徑**，例如 `/Users/<你的帳號>/Code/iPhone-use`。該資料夾內必須有 `server/iphone_use.py`。
3. 若要用的不是系統的 `python3`，在「Python 指令或執行檔」填入絕對路徑，例如 `/opt/homebrew/bin/python3`。
4. 按「儲存連線與解析設定」，再到「iPhone 掃描」頁按「檢查連線」。

## 2. 啟動 Pokéep

```sh
npm install
npm run data:update
npm run dev
```

開啟 **http://127.0.0.1:3000**，在「設定」頁填入 API key 與模型。使用 OpenAI 相容伺服器時，填入含 `/v1` 的完整網址；伺服器須支援 Responses API、圖片輸入與結構化 JSON 輸出。API 依用量計費，與 ChatGPT 訂閱額度分開。

正式使用可改用 `npm run build` 後執行 `npm start`。網頁只監聽 `127.0.0.1`，`PORT=3001 npm start` 可切換埠號。啟動指令會同時啟動 iPhone 背景服務；關閉網頁不會中斷掃描，重新開啟即可查看進度。

## 3. 使用流程

1. **掃描**：解鎖手機，在 Pokémon GO 開啟寶可夢盒子。到「iPhone 掃描」按「檢查連線」，選擇「目前搜尋結果」或「整個盒子」後開始。整盒掃描耗時且較耗 API 用量，第一次建議先掃目前搜尋結果。
2. **解析**：背景服務逐隻擷取能力、招式與評價畫面，以 Mac 的 Vision OCR 讀文字、本機像素量測 IV，只把必要的裁切圖送給 AI 校對。可隨時暫停，之後從檢查點續作。
3. **核對**：在「清倉結果」核對標示為待核對的個體，查看保留或放生的理由與證據截圖。
4. **放生**：勾選個體後按「放生勾選的 N 隻」。背景服務會先以搜尋確認目標的 CP 唯一才點擊；結果不明時整批暫停，不會自動重送。

要從頭掃描，按「清除未完成掃描並重來」，已完成的掃描與放生歷史會保留。

以下個體不會進入自動放生：鎖定、色違、服裝、傳說／幻之／究極異獸、滿 IV、零 IV、資料不完整或出現額外警告者。最愛個體只有在你勾選後才會先取消最愛再放生。

## 判斷依據

- **PvP**：PvPoke 超級、高級、大師聯盟排名，加上 4,096 組 IV 的能力乘積排名（等級上限 50）。
- **團體戰**：依 Game Master PvE 招式資料計算簡化循環 DPS，各屬性保留前幾名，數量可在設定調整。這不是特定頭目的戰鬥模擬。
- **培養成本**：估算升到等級 30／35 與 PvP 目標所需的星塵、糖果與 XL 糖果；活動折扣與特殊成本須自行核對遊戲。
- **招式學習器**：只列入選戰鬥名額、目前招式和建議不同的個體，依目前招式池估算一般學習器的成功率。團體戰依「DPS 提升幅度 ÷ 平均需要幾顆學習器」排序，PvP 依「環境排名 × 平均需要幾顆學習器」排序。社群日與活動限定招式須自行核對遊戲。
- **淨化**：估算淨化後的 IV、CP 與 PvP 潛力，不會只因淨化後可滿 IV 就推薦淨化。
- **收藏**：色違、服裝、形態（地區形態除外）、滿 IV、零 IV、極巨化各留代表；傳說／幻之／究極異獸全數保留；IV 合計至少 40/45 者按物種保留最高的一隻；可進化且未持有下一階者保留一隻。
- **可放生**：核對完整，且未入選戰鬥名額或收藏代表的個體。只比較本機已掃描且仍持有的個體。

目前以繁體中文、直式 iPhone 畫面為主，不分析極巨對戰、限時盃賽或交換。暱稱、圖示遮擋或畫面滑動會降低辨識可靠性。

## 資料與隱私

- 收藏、掃描、截圖、設定與 API key 都存在專案內、不納入版控的 `.data/`。API key 不會出現在匯出的備份中。
- 只把必要的裁切截圖送到你設定的 API（`store: false`），並裁掉狀態列與捕獲地點。其他畫面內容無法保證遮蔽，掃描前請避免露出不想傳送的資訊。
- 備份請用「設定」頁的匯出功能（JSON v2，上限 150 MB；也能還原 v1），不要在服務運行時直接複製 SQLite 檔。
- 「設定」頁可清除全部寶可夢資料；連線設定、清倉規則與遊戲資料會保留。

## 遊戲資料來源

在「設定」頁按「更新遊戲資料」，或執行 `npm run data:update`。全部來源檢查通過才會切換，失敗時保留舊版本。

- [PvPoke](https://github.com/pvpoke/pvpoke)：遊戲資料與排名，MIT 授權，見 `THIRD_PARTY_NOTICES.md`。
- [PokeMiners Game Master](https://github.com/PokeMiners/game_masters) 與 [繁體中文文字](https://github.com/PokeMiners/pogo_assets)：原始內容權利屬 Pokémon 與遊戲權利人。
- [PokéAPI Sprites](https://github.com/PokeAPI/sprites)：物種像素圖，首次顯示時下載並快取於 `.data/sprites/`。

## 開發

```sh
npm test
npm run typecheck
npm run build
```

測試使用模擬的 iPhone Use 與 AI 回應，不消耗 API 額度。舊手機截圖可用 `npm run max:recheck` 在本機回填極巨化狀態。本機 API 的寫入請求須同源，並帶 `x-pogo-local: 1` 標頭。
