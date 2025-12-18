# Threads 工具箱

語言：[English](README.md) | [中文](README.zh-TW.md)

強大可靠的 Apify Actor，用於爬取 Threads (threads.com) - Meta 的文字社群平台。擷取貼文、個人檔案、標籤和回覆。可匯出為 JSON/CSV/Excel。

## 重要：資料爬取限制

**Threads 資料爬取具有以下固有限制：**

- **資料量限制**：Threads 平台限制了可存取的資料量。實際結果會根據帳號活動、內容類型和其他因素而異
- **動態載入**：Threads 使用無限捲動載入內容，但在一定量後會停止載入
- **速率限制**：過於頻繁的請求可能會觸發平台保護機制
- **內容可用性**：無法存取私人帳號、已刪除的內容或地區限制的內容
- **登入牆**：Threads 可能偶爾顯示登入牆阻擋爬取

### 最佳實踐

1. **小批次測試**：從較小的限制開始進行初始測試，逐步增加以找到最佳設定
2. **實際期望**：了解實際結果可能少於請求的數量
3. **錯誤處理**：準備好處理部分失敗或不完整的結果
4. **執行間隔**：避免過於頻繁的爬取；建議至少間隔 5-10 分鐘
5. **資料驗證**：始終驗證爬取的資料是否完整和準確
6. **備用計劃**：對於關鍵資料，考慮多次爬取嘗試或使用不同參數

## 功能

- **個人檔案爬取**：抓取用戶資料，包括簡介、粉絲數、驗證狀態和近期貼文（無需登入）
- **單篇貼文擷取**：依 URL 抓取貼文詳情，包含回覆（無需登入）
- **搜尋貼文**：依關鍵字搜尋貼文，支援排序選項（⚠️ 需要登入 Cookie）
- **標籤搜尋**：依 hashtag 搜尋貼文（⚠️ 需要登入 Cookie）
- **批次模式**：一次處理多個關鍵字/用戶名/標籤/URL，支援並行控制
- **媒體擷取**：擷取貼文中的圖片和影片 URL
- **匯出格式**：JSON、CSV、Excel

## 輸入參數

### 共用參數

| 欄位 | 型別 | 必填 | 說明 | 預設 |
|------|------|------|------|------|
| `action` | string | 是 | 操作類型：`search`、`hashtag`、`profile` 或 `post` | - |
| `proxyConfiguration` | object | 否 | 代理設定，建議使用 Apify Proxy | Apify Proxy |

### 身份驗證（選用）

啟用 Cookie 注入以取得更多資料。當遇到登入牆時特別有用。

| 欄位 | 型別 | 必填 | 說明 | 預設 |
|------|------|------|------|------|
| `useCookies` | boolean | 否 | 啟用 Cookie/儲存注入 | `false` |
| `storageState` | object | 否 | Playwright `storageState.json` 內容 | - |

**如何取得 storageState：**

1. 在瀏覽器中登入 Threads
2. 使用 Playwright 匯出儲存狀態：
   ```javascript
   // 使用 Playwright 登入後
   await context.storageState({ path: 'storageState.json' });
   ```
3. 將 JSON 內容複製到 `storageState` 欄位

**注意**：若啟用 `useCookies` 但 `storageState` 為空，Actor 會退回無驗證模式並記錄警告。僅注入 Threads 網域的 cookies 和 localStorage；不支援 sessionStorage。

### 速率限制保護（選用）

設定速率限制保護以避免被 Threads 封鎖。

| 欄位 | 型別 | 必填 | 說明 | 預設 |
|------|------|------|------|------|
| `rateLimitConfig.requestDelay` | integer | 否 | 請求間隔（毫秒） | `1000` |
| `rateLimitConfig.maxRetries` | integer | 否 | 被限制時最大重試次數 | `3` |
| `rateLimitConfig.backoffDelay` | integer | 否 | 初始退避延遲（毫秒） | `5000` |
| `rateLimitConfig.backoffMultiplier` | number | 否 | 退避乘數 | `2` |

**範例：**

```json
{
    "action": "search",
    "keyword": "AI",
    "rateLimitConfig": {
        "requestDelay": 2000,
        "maxRetries": 5,
        "backoffDelay": 10000
    }
}
```

**運作方式：**
- 當 Threads 返回速率限制錯誤時，Actor 會自動暫停並重試
- 使用指數退避：預設設定下，首次重試等待 5 秒，第二次 10 秒，第三次 20 秒
- 被限制時會記錄警告，幫助您監控和調整設定

### 個人檔案 (Profile)

抓取用戶資料和近期貼文。

```json
{
    "action": "profile",
    "username": "zuck",
    "maxItems": 20
}
```

| 欄位 | 型別 | 必填 | 說明 | 預設 |
|------|------|------|------|------|
| `username` | string | 是 | 用戶名稱（不含 @） | - |
| `includePosts` | boolean | 否 | 同時抓取個人頁面的近期貼文 | `true` |
| `maxItems` | integer | 否 | 從個人頁抓取貼文的上限 | `20` |

### 單篇貼文 (Post)

依 URL 抓取貼文詳情，包含回覆。

```json
{
    "action": "post",
    "postUrl": "https://www.threads.com/@zuck/post/ABC123xyz",
    "maxItems": 50
}
```

| 欄位 | 型別 | 必填 | 說明 | 預設 |
|------|------|------|------|------|
| `postUrl` | string | 是 | Threads 貼文完整 URL | - |
| `maxItems` | integer | 否 | 抓取回覆的上限 | `50` |

### 搜尋貼文 (Search)（⚠️ 需要登入）

> **重要**：自 2024 年 12 月起，Threads 需要登入才能存取搜尋結果。您必須提供包含有效登入 Cookie 的 `storageState` 才能使用此功能。

依關鍵字在 Threads 搜尋貼文。

```json
{
    "action": "search",
    "keyword": "人工智慧",
    "filter": "recent",
    "maxItems": 50,
    "useCookies": true,
    "storageState": { "...您匯出的 storageState..." }
}
```

| 欄位 | 型別 | 必填 | 說明 | 預設 |
|------|------|------|------|------|
| `keyword` | string | 是 | 搜尋關鍵字 | - |
| `filter` | string | 否 | 排序方式：`recent`（最新）或 `top`（熱門） | `recent` |
| `maxItems` | integer | 否 | 最大抓取數量（1-1000） | `50` |
| `useCookies` | boolean | 是* | 搜尋功能必須為 `true` | `false` |
| `storageState` | object | 是* | 包含登入 Cookie 的 Playwright storageState | - |

### 標籤搜尋 (Hashtag)（⚠️ 需要登入）

> **重要**：自 2024 年 12 月起，Threads 需要登入才能存取標籤搜尋結果。您必須提供包含有效登入 Cookie 的 `storageState` 才能使用此功能。

依 hashtag 搜尋貼文。

```json
{
    "action": "hashtag",
    "tag": "AI",
    "filter": "recent",
    "maxItems": 50,
    "useCookies": true,
    "storageState": { "...您匯出的 storageState..." }
}
```

| 欄位 | 型別 | 必填 | 說明 | 預設 |
|------|------|------|------|------|
| `tag` | string | 是 | 標籤（可含 #） | - |
| `filter` | string | 否 | 排序方式：`recent` 或 `top` | `recent` |
| `maxItems` | integer | 否 | 最大抓取數量（1-1000） | `50` |
| `useCookies` | boolean | 是* | 標籤搜尋功能必須為 `true` | `false` |
| `storageState` | object | 是* | 包含登入 Cookie 的 Playwright storageState | - |

### 批次模式 (Batch)

一次處理多個輸入。`concurrency` 控制並行任務數量。

```json
{
    "action": "search",
    "keywords": ["vibe coding", "機器學習"],
    "usernames": ["zuck", "openai"],
    "tags": ["AI", "科技"],
    "postUrls": ["https://www.threads.com/@user/post/ABC123"],
    "maxItems": 20,
    "filter": "recent",
    "concurrency": 2
}
```

| 欄位 | 型別 | 說明 | 預設 |
|------|------|------|------|
| `keywords` | array | 多個搜尋關鍵字 | `[]` |
| `usernames` | array | 多個用戶名稱 | `[]` |
| `tags` | array | 多個標籤 | `[]` |
| `postUrls` | array | 多個貼文 URL | `[]` |
| `concurrency` | integer | 並行任務上限 | `2` |

## 輸出格式

### 貼文輸出

每則貼文儲存為單獨的記錄：

```json
{
    "id": "ABC123xyz",
    "url": "https://www.threads.com/@johndoe/post/ABC123xyz",
    "author": {
        "username": "johndoe",
        "displayName": "John Doe",
        "profileUrl": "https://www.threads.com/@johndoe",
        "avatarUrl": "https://...",
        "isVerified": false
    },
    "content": "這是關於 AI 和科技的貼文內容...",
    "timestamp": "2025-12-04T10:14:34.000Z",
    "stats": {
        "likes": 142,
        "replies": 23,
        "reposts": 8,
        "shares": 5
    },
    "images": ["https://..."],
    "videos": ["https://..."],
    "links": ["https://example.com"],
    "quotedPost": null,
    "source": "search",
    "parentId": null
}
```

| 欄位 | 型別 | 說明 |
|------|------|------|
| `id` | string | 貼文唯一識別碼 |
| `url` | string | 貼文連結 |
| `author.username` | string | 作者用戶名稱 |
| `author.displayName` | string | 作者顯示名稱 |
| `author.profileUrl` | string | 作者個人檔案連結 |
| `author.avatarUrl` | string | 作者頭像 URL |
| `author.isVerified` | boolean | 作者是否已驗證 |
| `content` | string | 貼文文字內容 |
| `timestamp` | string | ISO 8601 時間戳 |
| `stats.likes` | integer | 按讚數 |
| `stats.replies` | integer | 回覆數 |
| `stats.reposts` | integer | 轉發數 |
| `stats.shares` | integer | 分享數 |
| `images` | array | 圖片 URL 陣列 |
| `videos` | array | 影片 URL 陣列 |
| `links` | array | 外部連結（非 Threads） |
| `quotedPost` | object | 引用貼文資訊（如有） |
| `source` | string | 來源標記：`search`、`hashtag`、`reply`、`profile_posts` |
| `parentId` | string | 若為回覆，對應的主貼 ID |

### 個人檔案輸出

```json
{
    "username": "zuck",
    "displayName": "Mark Zuckerberg",
    "profileUrl": "https://www.threads.com/@zuck",
    "avatarUrl": "https://...",
    "bio": "Building the future...",
    "isVerified": true,
    "followersCount": 5417000,
    "location": "California, USA",
    "joinedDate": "July 2023",
    "partial": false,
    "missingFields": [],
    "type": "profile",
    "source": "profile"
}
```

| 欄位 | 型別 | 說明 |
|------|------|------|
| `username` | string | 用戶名稱 |
| `displayName` | string | 顯示名稱 |
| `profileUrl` | string | 個人檔案連結 |
| `avatarUrl` | string | 頭像 URL |
| `bio` | string | 個人簡介 |
| `isVerified` | boolean | 是否已驗證 |
| `followersCount` | integer | 粉絲數 |
| `location` | string \| null | 用戶所在地（來自「關於此個人檔案」） |
| `joinedDate` | string \| null | 帳號建立月份/年份（如 "July 2023"） |
| `partial` | boolean | 若缺少非必填欄位為 true |
| `missingFields` | array | 缺少的非必填欄位名稱 |

**注意**：`location` 和 `joinedDate` 需要登入才能取得。啟用 `useCookies` 並提供 `storageState` 來存取這些欄位。未登入時，這些欄位將為 `null`。請參閱[身份驗證](#身份驗證選用)設定說明。

注意：個人頁面的近期貼文會以獨立的 Dataset 項目輸出，包含 `source: "profile_posts"` 和 `profile: <username>`。

## 資料品質

- **貼文**：缺少必要資料（內容、作者或有效時間戳）的項目會被過濾，不寫入 Dataset
- **個人檔案**：缺少非必填欄位（如簡介/頭像/粉絲數）時仍保留記錄，但標記 `partial: true` 和 `missingFields`
- **回覆和個人頁貼文**：使用相同驗證邏輯，無效項目會被跳過

## 使用案例

- **社群媒體監控**：追蹤品牌提及和對話
- **網紅發現**：透過粉絲指標尋找內容創作者
- **競爭對手研究**：監控競爭對手的活動和互動
- **內容分析**：分析趨勢話題和標籤
- **潛在客戶開發**：發現您領域中的個人檔案
- **市場研究**：了解受眾情緒

## 效能與限制

**貼文限制**：

- 用戶貼文：僅可存取最近的貼文，數量因帳號而異
- 關鍵字搜尋：受 Threads 搜尋結果限制
- 個人檔案搜尋：受搜尋結果限制

**注意**：Threads 動態載入內容，可能會限制透過捲動取得的資料量。實際結果可能少於請求的限制。

## 常見問題

**問：為什麼取得的結果少於 maxItems 限制？**
答：Threads 限制了透過其介面可取得的內容量。實際可用的貼文數量會根據多種因素而異，包括帳號活動、內容類型等。

**問：可以爬取私人帳號嗎？**
答：不行。此 Actor 僅爬取公開可用的資料。私人帳號、已刪除的內容和地區限制的內容無法存取。

**問：為什麼有些貼文的文字被截斷？**
答：Threads 在動態消息中顯示截斷的內容。可使用貼文 URL 透過 HTTP 請求工具取得完整內容。

**問：支援包含點的用戶名稱嗎？**
答：是的。像 @user.name 這樣的用戶名稱完全支援。

**問：如何處理速率限制？**
答：使用 Apify Proxy（建議）、降低並行度，並在執行之間增加間隔。如果遇到持續問題，請等待 10-15 分鐘後再重試。

**問：如果 Threads 顯示登入牆會怎樣？**
答：Actor 會記錄錯誤並跳過該請求。考慮使用不同的代理設定或降低請求頻率。

**問：可以取得互動指標嗎？**
答：可以。Actor 會擷取每則貼文的按讚、回覆、轉發和分享數，幫助您分析內容表現。

## 替代方案：官方 Threads API

**重要提示**：此 Actor 在不登入的情況下運作，這意味著可存取的資料量受 Threads 公開介面的限制。

**如果您需要爬取自己帳號的資料**，請考慮使用[官方 Threads API](https://developers.facebook.com/docs/threads)：

- 更可靠和穩定
- 更高的速率限制
- 存取完整的貼文歷史
- 不會被封鎖的風險
- Meta 的官方支援

Threads API 是存取您自己帳號資料或需要大規模、生產級資料擷取的建議方法。

## 支援

有問題或疑問？

- 查看 [Apify 文件](https://docs.apify.com)
- 在資料集中查看所有欄位以取得完整資料
- 透過 Issues 標籤回報問題
- 透過 Apify 平台聯繫支援

## 授權

本專案採用 Apache License 2.0 授權 - 詳情請見 [LICENSE](LICENSE) 文件。

## 免責聲明

此工具僅供教育和研究目的。請負責任地使用，並遵守 Threads 的服務條款。開發者對此工具的任何濫用或違反平台政策的行為不承擔責任。

---

**關鍵字**：Threads 爬蟲、Threads API、Meta Threads、社群媒體爬蟲、Instagram Threads、Threads 貼文、Threads 資料擷取、社群媒體監控、Threads 自動化、網紅發現、粉絲數爬蟲
