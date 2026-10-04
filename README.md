# Rate of Dissolving Table Salt (水溫對食鹽溶解速率的影響)
## S1 Integrated Science • 公開課探究平台與三層式 AI 代理安全架構

![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white)
![TailwindCSS](https://img.shields.io/badge/TailwindCSS-38B2AC?style=flat&logo=tailwind-css&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white)
![Gemini AI](https://img.shields.io/badge/Google_Gemini-4285F4?style=flat&logo=google&logoColor=white)
![MQTT](https://img.shields.io/badge/MQTT-660066?style=flat&logo=eclipse-mosquitto&logoColor=white)

專為中一級（Grade 7 / S1）科學科探究實驗「實驗 1.2：水溫對食鹽溶解速率的影響」設計之互動探究教學平台，支援 iPad/平板電腦最佳化響應式排版、全班 8 組跨裝置即時數據同步、粒子碰撞動態圖解、高階思維提問（HOTQ）以及三層式 AI 安全代理架構。

---

## 🌟 核心功能與最新安全性更新 (Security & Architecture Overhaul)

### 1. 班別選擇更新 (Class Selection)
- 班別選擇正式更新為五個班別：
  - **1CL**（預設）、**1CW**、**1LF**、**1LH**、**1LL**
- 學生及教師剛進入系統時，可透過啟動引導視窗（Startup Modal）一鍵選取所屬班別與組別（Group 1 - 8）。

---

### 2. 原始碼密碼漏洞防禦 (Salted SHA-256 Authentication)
- **問題解決**：徹底移除前端原始碼中任何明文密碼字串（消除 `teacherwater` 與 `teacheradmin` 明文漏洞）。
- **加密防護機制**：
  - 採用 **加鹽雜湊（Salted SHA-256）** 演算法配合唯一安全鹽值（`AUTH_SALT`）。
  - 前端使用瀏覽器原生 **Web Crypto API** (`crypto.subtle.digest`) 進行即時運算比對。
  - 後端伺服器提供 `/api/auth/verify` 端點，簽發安全性工作階段權杖（Session Token）。
  - 檢視網頁原始碼只會看到高強度十六進位雜湊值，無法逆向破解密碼。

---

### 3. 實驗數據模式切換權限與即時同步 (Single-Authority Mode Control)
- **權限嚴格控管**：
  - 「👥 4人一組 (全組1個數據)」與「👥👥 拆分2人小組 (2組數據：小組A & B)」之切換按鈕**僅在教師指揮中心（Teacher Command Center）顯示**。
  - 學生端介面切換按鈕已被完全移除，替換為具安全鎖定圖示之專屬狀態標籤（Read-Only Mode Badge），防範學生於客戶端任意切換。
- **全班跨裝置實時聯動**：
  - 老師於後台切換模式時，即時透過 MQTT 雲端頻道與 BroadcastChannel 廣播至所有學生 iPad。
  - 學生介面即時彈出浮動提示訊息（Toast Notification）並無縫切換輸入欄位，自動計算組內平均值。

---

### 4. 三層式 AI Gateway 與 Token 預算防護架構 (Three-Tier AI Security Architecture)

```
[前端 Presentation Layer (學生 iPad / 老師端)]
     │ (僅做指令輸入與呈現，不持有 API Key，不可竄改配額)
     ▼ HTTP POST /api/chat
[後端伺服器核心 AI Gateway (server.js)]
     ├── 1. 預請求速率限制攔截 (Rate Limiting: 15 req/min)
     ├── 2. 每日全班 Token 預算中介攔截 (Token Budget Guard: 100,000 Tokens)
     ├── 3. 金鑰保管庫 (Server Key Vault: process.env.GEMINI_API_KEY)
     └── 4. 雙語回答過濾與 S1 提示洩漏防護
     │
     ▼ HTTP POST
[Google Gemini API (gemini-2.5-flash / gemini-3.6-flash)]
     │
     ▼ (usageMetadata: promptTokenCount, candidatesTokenCount)
[資料與快取層 Database & Cache Layer]
     ├── In-Memory 快取：<1ms 同步扣減配額、滑動窗口頻率統計
     └── Persistent 審計：data/audit_log.json & data/budget_records.json
```

#### a) 前端（Presentation Layer）
- 嚴格僅負責資料呈現與學生文字輸入，**絕不**在前端執行預算扣除或權限放行邏輯。
- 徹底停止過往在公開 MQTT 頻道廣播 API Key 之不安全行為。
- 提供實時 AI Gateway 連線狀態偵測與每日 Token 預算進度條（Visual Progress Bar）。

#### b) 伺服器層（AI Gateway / Server Layer - `server.js`）
- 採用 **零依賴（Zero Dependencies）** 原生 Node.js 構建，輕量、極速、無安全依賴漏洞。
- **預請求攔截（Pre-request Interception）**：
  - 單組發送頻率防刷（預設 15 次/分鐘，超出即回傳 HTTP 429）。
  - 全班每日 Token 總消耗上限攔截（預設 100,000 Tokens，防超支爆額）。
- **金鑰保管庫（Secure Key Vault）**：API Key 僅存在於伺服器環境變數（`.env`）或記憶體中，學生端永遠無法接觸。
- **雙語回應審計與清理**：解析並校驗 Gemini 回傳之 `usageMetadata`，並清理所有中繼提示符號。

#### c) 資料與快取層（Database & Cache Layer）
- **記憶體即時配額快取（In-Memory Fast Cache）**：毫秒級同步檢查與扣減配額。
- **持久化審計日誌（Persistent Audit Store）**：自動記錄至 `data/audit_log.json`，涵蓋調用時間、班別、組別、模型、Token 輸入/輸出數值、預估費用（USD）、延遲（Latency）與狀態。

---

## 🚀 快速啟動指南 (Quick Start)

### 方式一：啟動原生 AI Gateway 伺服器（推薦 • 生產級安全架構）
確保本機已安裝 Node.js（v18+）：

1. 複製設定檔：
   ```bash
   cp .env.example .env
   ```
2. 編輯 `.env` 填入你的 Google Gemini API Key：
   ```env
   GEMINI_API_KEY=AIzaSy...YourKeyHere
   PORT=3000
   DAILY_TOKEN_BUDGET=100000
   TEACHER_PASSWORD=teacherwater
   ADMIN_PASSWORD=teacheradmin
   ```
3. 啟動伺服器：
   ```bash
   npm start
   # 或 node server.js
   ```
4. 開啟瀏覽器訪問：
   ```
   http://localhost:3000
   ```

### 方式二：靜態託管（GitHub Pages）
本系統支援雙軌混合模式（Hybrid Mode）：
- 直接在 GitHub Pages 上瀏覽時，前端能無縫相容靜態託管。
- 可於管理員後台自訂已部署之 AI Gateway 代理伺服器網址（如部署至 Google Cloud Run, Render, Railway 或本機），亦可在離線時啟用本地蘇格拉底啟發式教學引擎。

---

## 🔒 預設密碼說明 (Default Passwords)

| 後台入口 | 角色標籤 | 預設密碼 | 安全處理 |
| :--- | :--- | :--- | :--- |
| **教師指揮中心** | `Teacher` | `teacherwater` | 加鹽雜湊 SHA-256（原始碼無明文） |
| **系統管理控制台** | `Admin` | `teacheradmin` | 加鹽雜湊 SHA-256（原始碼無明文） |

---

## 🌐 線上展示連結 (Live Link)
- **GitHub Pages 部署網址**：[https://tsehowingpeter-sys.github.io/rate-of-dissolving-fair-test/](https://tsehowingpeter-sys.github.io/rate-of-dissolving-fair-test/)
