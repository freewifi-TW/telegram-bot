# MachineChubbyBot

給 Telegram 話題型（Forum）群組用的管理 bot，功能：

| 功能 | 說明 |
| --- | --- |
| 👋 歡迎詞 | 新成員加入時自動發送，內容、發送話題皆可由管理員設定 |
| 🏷 身分組 | 管理員建立身分組，成員透過面板按鈕自行加入／退出 |
| 📣 一鍵 tag | `/tag 身分組 訊息` 一次通知整組的人 |
| 🔗 連結修正 | x.com、pixiv、Bluesky、Instagram、TikTok、Reddit 連結自動轉成能正常預覽的版本 |
| 🔍 以圖搜圖 | 回覆圖片 `/source`，查 SauceNAO（Twitter、e621）與 e621 IQDB |

技術：Node.js 20、TypeScript、[grammY](https://grammy.dev/)。資料存在單一 JSON 檔，不需要資料庫。

## 1. 建立 bot

1. 在 Telegram 找 [@BotFather](https://t.me/BotFather)，輸入 `/newbot` 建立 bot，記下 token。
2. 輸入 `/setprivacy` → 選你的 bot → **Disable**。這樣 bot 才看得到群組裡的一般訊息（連結修正需要）。
3. 建立 bot 後把它加進群組，並設為**管理員**。建議開啟以下權限：
   - 刪除訊息（連結修正的 `replace` 模式會用到）
   - 其餘可全部關閉

> bot 必須是管理員才會收到「成員加入」的 `chat_member` 事件，歡迎詞才會可靠。

## 2. 本機執行

```bash
npm install
cp .env.example .env     # Windows 可直接複製檔案後改名
# 編輯 .env，至少填入 BOT_TOKEN
npm run dev              # 開發模式，改檔案會自動重啟
```

正式執行：

```bash
npm run build
npm start
```

### 環境變數

| 變數 | 必填 | 說明 |
| --- | --- | --- |
| `BOT_TOKEN` | ✅ | BotFather 給的 token |
| `OWNER_IDS` | | 你的 user id，逗號分隔。填了之後不管群組權限都視為管理員 |
| `DATA_FILE` | | 資料檔路徑，預設 `./data/bot.json` |
| `SAUCENAO_API_KEY` | | 到 <https://saucenao.com/user.php?page=search-api> 免費申請，沒填也能用但額度很低 |
| `SAUCENAO_MIN_SIMILARITY` | | 低於此相似度的結果不顯示，預設 60 |
| `E621_USER_AGENT` | | e621 要求格式 `專案名/版本 (by 你的e621帳號)`，沒填會被拒絕 |
| `E621_LOGIN` / `E621_API_KEY` | | 選填，用帳號查詢可以提高額度 |

## 3. 指令一覽

### 所有人

| 指令 | 說明 |
| --- | --- |
| `/roles` | 叫出身分組面板，按按鈕加入或退出 |
| `/my_roles` | 看自己有哪些身分組 |
| `/role_list` | 所有身分組與人數 |
| `/role_members 名稱` | 列出某身分組的成員（不會通知） |
| `/tag 名稱 [訊息]` | 通知整個身分組，每組 30 秒內只能 tag 一次（管理員不限） |
| `/source` | 回覆一張圖片、貼圖或影片使用，也可以在傳圖時把 `/source` 當說明文字。影片會用 Telegram 的縮圖搜尋。別名 `/sauce` |
| `/help` | 使用說明 |

### 管理員

| 指令 | 說明 |
| --- | --- |
| `/role_add 名稱 [說明]` | 新增身分組，名稱不可有空白 |
| `/role_del 名稱` | 刪除身分組 |
| `/welcome` | 查看歡迎詞設定 |
| `/setwelcome 文字` | 設定歡迎詞，也可以回覆一則訊息套用它的內容 |
| `/welcome_topic` | 在想發歡迎詞的話題裡執行，之後歡迎詞就發在那裡 |
| `/welcome_on` / `/welcome_off` | 開關歡迎詞 |
| `/welcome_test` | 用自己測試歡迎詞 |
| `/fixup reply\|replace\|off` | 連結修正模式 |

歡迎詞可用變數：`{mention}`（會通知新成員）、`{name}`、`{username}`、`{group}`，並支援 HTML 標籤如 `<b>粗體</b>`。

連結修正支援的網站：

| 原始 | 轉成 |
| --- | --- |
| x.com、twitter.com 推文 | fixupx.com |
| pixiv.net 作品 | phixiv.net |
| bsky.app 貼文 | fxbsky.app |
| instagram.com 貼文、Reel | ddinstagram.com |
| tiktok.com 影片（含 vm. / vt. 短網址） | vxtiktok.com |
| reddit.com 貼文 | rxddit.com |

要增減網站，改 `src/features/fixup.ts` 的 `RULES` 表即可。

連結修正模式：

- `reply`（預設）：回覆一則修正後的連結，原訊息保留。
- `replace`：刪除原訊息，由 bot 以「**作者名**：內容」重發。只對純文字訊息生效，附圖訊息仍用回覆模式。原訊息的粗體等格式會遺失。
- `off`：關閉。

## 4. 部署

### Docker

```bash
docker build -t machinechubbybot .
docker run -d --name machinechubbybot --restart unless-stopped \
  --env-file .env -v machinechubbybot-data:/app/data machinechubbybot
```

### Railway / Fly.io / Render

這些平台都能直接吃這個 Dockerfile。要注意兩件事：

1. 在平台的環境變數設定裡填入 `.env` 的內容。
2. 掛一個 volume 到 `/app/data`，不然重新部署後身分組資料會消失。

bot 使用 long polling，不需要公開網址或 webhook。

## 5. 資料檔

所有設定與身分組都在 `data/bot.json`，結構很單純，可以直接用編輯器查看或備份。bot 會先寫暫存檔再改名，不會因為中途當機留下半截檔案。

## 已知限制

- Telegram 對單則訊息能通知的人數有限制，`/tag` 會每 5 人分一則訊息發送。
- 沒有 username、也從未按過面板按鈕的成員，bot 無法可靠地通知他們。
- e621 IQDB 要求每秒最多一次查詢，短時間連續搜圖可能被拒絕。
