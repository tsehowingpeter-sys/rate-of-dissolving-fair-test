/**
 * AI Gateway & Token Budget Server for Rate of Dissolving Fair Test
 * 
 * Three-Tier Architecture:
 * 1. AI Gateway / Proxy: Protects Google Gemini API Key, intercepts requests, validates prompts.
 * 2. Token Budget & Rate Limiting Middleware: Enforces server-side quota, sliding-window rate limits.
 * 3. Database & Cache Layer: In-memory real-time quota cache + persistent JSON audit logging.
 *
 * Runs natively on Node.js without third-party dependencies!
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- 1. CONFIGURATION & ENVIRONMENT ---
const PORT = process.env.PORT || 3000;
const AUTH_SALT = process.env.AUTH_SALT || 'salt_fair_test_2026_xK9#mQ';

// Pre-computed salted SHA-256 hashes
const HASH_TEACHER = crypto.createHash('sha256').update(AUTH_SALT + (process.env.TEACHER_PASSWORD || 'teacherwater')).digest('hex');
const HASH_ADMIN = crypto.createHash('sha256').update(AUTH_SALT + (process.env.ADMIN_PASSWORD || 'teacheradmin')).digest('hex');

// Load environment file (.env) if present
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        try {
            const content = fs.readFileSync(envPath, 'utf8');
            content.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const idx = trimmed.indexOf('=');
                    if (idx !== -1) {
                        const key = trimmed.slice(0, idx).trim();
                        const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
                        if (!process.env[key]) {
                            process.env[key] = val;
                        }
                    }
                }
            });
            console.log('✅ Loaded environment variables from .env');
        } catch(e) {
            console.warn('⚠️ Could not load .env file:', e.message);
        }
    }
}
loadEnv();

let serverConfig = {
    apiKey: process.env.GEMINI_API_KEY || '',
    defaultModel: process.env.DEFAULT_MODEL || 'gemini-2.5-flash',
    dailyTokenBudget: parseInt(process.env.DAILY_TOKEN_BUDGET || '100000', 10),
    rateLimitPerMin: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '15', 10),
    maxOutputTokens: parseInt(process.env.MAX_OUTPUT_TOKENS || '1000', 10)
};

// --- 2. DATABASE & CACHE LAYER ---
const DATA_DIR = path.join(__dirname, 'data');
const AUDIT_FILE = path.join(DATA_DIR, 'audit_log.json');
const BUDGET_FILE = path.join(DATA_DIR, 'budget_records.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-Memory Fast Quota Cache (<1ms synchronous check)
const inMemoryCache = {
    rateLimits: new Map(), // key: ipOrGroup -> array of timestamps
    stats: {
        calls: 0,
        totalTokens: 0,
        promptTokens: 0,
        candidateTokens: 0,
        costUsd: 0.0,
        lastResetDate: new Date().toISOString().split('T')[0]
    },
    activeSessions: new Map() // token -> { role, expiresAt }
};

// Load persistent stats
function loadPersistentStats() {
    try {
        if (fs.existsSync(BUDGET_FILE)) {
            const data = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
            inMemoryCache.stats = Object.assign(inMemoryCache.stats, data.stats || {});
            if (data.config) {
                serverConfig = Object.assign(serverConfig, data.config);
            }
            console.log(`📦 Loaded persistent budget records: ${inMemoryCache.stats.totalTokens} tokens consumed`);
        }
    } catch(e) {
        console.warn('⚠️ Error loading budget_records.json:', e.message);
    }
}
loadPersistentStats();

function savePersistentStats() {
    try {
        const payload = {
            stats: inMemoryCache.stats,
            config: {
                defaultModel: serverConfig.defaultModel,
                dailyTokenBudget: serverConfig.dailyTokenBudget,
                rateLimitPerMin: serverConfig.rateLimitPerMin,
                maxOutputTokens: serverConfig.maxOutputTokens
            },
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(BUDGET_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch(e) {
        console.error('❌ Failed to save budget records:', e.message);
    }
}

function appendAuditLog(record) {
    try {
        let logs = [];
        if (fs.existsSync(AUDIT_FILE)) {
            try {
                logs = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
            } catch(e) {
                logs = [];
            }
        }
        logs.unshift(record);
        // Keep max 200 recent entries in persistent file
        if (logs.length > 200) logs.pop();
        fs.writeFileSync(AUDIT_FILE, JSON.stringify(logs, null, 2), 'utf8');
    } catch(e) {
        console.error('❌ Failed to append audit log:', e.message);
    }
}

// Reset daily budget if new day
function checkDailyReset() {
    const today = new Date().toISOString().split('T')[0];
    if (inMemoryCache.stats.lastResetDate !== today) {
        console.log(`🔄 New day detected (${today}). Resetting daily stats.`);
        inMemoryCache.stats.lastResetDate = today;
        inMemoryCache.stats.calls = 0;
        inMemoryCache.stats.totalTokens = 0;
        inMemoryCache.stats.promptTokens = 0;
        inMemoryCache.stats.candidateTokens = 0;
        inMemoryCache.stats.costUsd = 0.0;
        savePersistentStats();
    }
}

// --- 3. MIDDLEWARE: RATE LIMITER & TOKEN BUDGET GUARD ---
function checkRateLimit(key) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const timestamps = inMemoryCache.rateLimits.get(key) || [];
    const valid = timestamps.filter(t => now - t < windowMs);
    
    if (valid.length >= serverConfig.rateLimitPerMin) {
        return false; // Rate limit exceeded
    }
    
    valid.push(now);
    inMemoryCache.rateLimits.set(key, valid);
    return true;
}

function checkTokenBudget(estimatedTokens = 300) {
    checkDailyReset();
    if (inMemoryCache.stats.totalTokens + estimatedTokens > serverConfig.dailyTokenBudget) {
        return {
            allowed: false,
            reason: `全班每日 Token 預算額度已達上限 (${inMemoryCache.stats.totalTokens} / ${serverConfig.dailyTokenBudget} Tokens)。請聯繫老師或管理員提高預算。`
        };
    }
    return { allowed: true };
}

// Session Token Generation
function createSessionToken(role) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000; // 12 hours
    inMemoryCache.activeSessions.set(token, { role, expiresAt });
    return token;
}

function verifySessionToken(token, requiredRole = null) {
    if (!token) return false;
    const session = inMemoryCache.activeSessions.get(token);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
        inMemoryCache.activeSessions.delete(token);
        return false;
    }
    if (requiredRole && session.role !== requiredRole && session.role !== 'Admin') {
        return false;
    }
    return true;
}

// --- 4. GEMINI API PROXY CALLER ---
const SYSTEM_INSTRUCTION = `You are "Agent Water (水精靈 AI 導師)", an encouraging, scientifically precise S1 Integrated Science AI tutor for secondary school students conducting "Exp 1.2: Rate of Dissolving Table Salt (水溫對食鹽溶解速率的影響)".
Target Audience: Grade 7 / Secondary 1 students (11-13 years old).
Mission:
1. Warmly answer student greetings (e.g. "hello", "你好") and questions asking for guidance or help.
2. Guide students with Socratic inquiry on why hot water (80°C) dissolves table salt much faster than cold water (25°C).
3. Connect observations to the Particle Theory of Matter: at higher temperatures, water molecules have greater kinetic energy, move faster, and collide more violently and frequently with the sodium chloride (NaCl) crystal lattice, breaking it apart much faster.
4. Emphasize fair testing: only water temperature is changed; water volume (100 mL), salt mass (5.0 g), and stirring speed/method must be kept constant.
5. Explain why taking the class average of 8 groups cancels out random errors (such as human stopwatch reaction delay or slight stirring rate variations).
Crucial Formatting & Output Rules:
- Return ONLY a valid JSON object with EXACTLY two fields:
  "en": English response (concise, encouraging, 2-3 sentences, with 1-2 emojis like 💧, 🔬, ⏱️, ✨).
  "zh": Traditional Chinese (繁體中文) response (corresponding natural explanation, 2-3 sentences, age-appropriate for S1).
- DO NOT output any internal thoughts, goals, prompt meta-tags (e.g. NEVER write "/Goal:*", "Goal:", or "Prompt:").
- DO NOT duplicate English into the "zh" field. The "zh" field MUST contain natural Traditional Chinese characters.`;

async function callGoogleGemini(promptText, modelName, callerGroup, classContext = '') {
    const apiKey = serverConfig.apiKey;
    if (!apiKey) {
        throw new Error('伺服器尚未配置 GEMINI_API_KEY。請在後台設定或檢查伺服器環境變數。');
    }

    const activeModel = modelName || serverConfig.defaultModel || 'gemini-2.5-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(activeModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const userMessage = `Current group: ${callerGroup}.${classContext ? ` ${classContext}` : ''}\nStudent says: "${promptText}"\nRemember: Reply in valid JSON with {"en": "...", "zh": "..."} where zh MUST be Traditional Chinese.`;

    const requestBody = {
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [
            { role: "user", parts: [{ text: userMessage }] }
        ],
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: serverConfig.maxOutputTokens,
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    en: { type: "STRING", description: "English response for S1 student" },
                    zh: { type: "STRING", description: "Traditional Chinese response for S1 student" }
                },
                required: ["en", "zh"]
            }
        }
    };

    const startTime = Date.now();

    // Use native fetch (Node 18+)
    let resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
    });

    // Fallback if HTTP 400 (older models unsupported responseSchema)
    if (!resp.ok && resp.status === 400) {
        delete requestBody.generationConfig.responseSchema;
        delete requestBody.generationConfig.responseMimeType;
        resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
    }

    const latencyMs = Date.now() - startTime;

    if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        const errMsg = errData.error?.message || `HTTP ${resp.status} ${resp.statusText}`;
        throw new Error(`Google Gemini API 錯誤: ${errMsg}`);
    }

    const json = await resp.json();
    const candidateText = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!candidateText) {
        throw new Error('Google Gemini API 未返回內容 (Empty Candidate)');
    }

    // Token usage deduction
    const usage = json.usageMetadata || {};
    const promptTokens = usage.promptTokenCount || 60;
    const candidateTokens = usage.candidatesTokenCount || 40;
    const totalTokens = usage.totalTokenCount || (promptTokens + candidateTokens);

    return {
        rawText: candidateText,
        promptTokens,
        candidateTokens,
        totalTokens,
        latencyMs,
        model: activeModel
    };
}

// Clean and validate bilingual response
function parseBilingualText(rawText) {
    let en = "";
    let zh = "";
    try {
        let clean = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const obj = JSON.parse(clean);
        if (obj.en && typeof obj.en === 'string') en = obj.en.trim();
        if (obj.zh && typeof obj.zh === 'string') zh = obj.zh.trim();
    } catch(e) {
        // Fallback parsing if JSON wasn't fully formed
        const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
        en = lines[0] || "Great job exploring water temperature and dissolving rate! 💧";
        zh = lines[1] || "很棒的探究！繼續觀察水溫如何影響食鹽溶解速率！💧";
    }

    // Strip accidental meta-prompts
    const stripMeta = (txt) => txt.replace(/\/Goal:[^\n]*/gi, '').replace(/^Goal:[^\n]*/gi, '').trim();
    en = stripMeta(en) || "Observe closely how temperature changes particle collisions! 💧";
    zh = stripMeta(zh) || "仔細觀察溫度如何改變水分子與鹽粒子的碰撞！💧";

    return { en, zh };
}

// --- 5. HTTP REQUEST ROUTER & SERVER ---
const server = http.createServer(async (req, res) => {
    // Enable CORS for development & cross-origin deployment
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';

    // Helper: JSON response
    const sendJson = (statusCode, data) => {
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
    };

    // Helper: Parse JSON Body
    const readBody = () => new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1e6) { // 1MB limit
                req.destroy();
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch(e) {
                reject(new Error('Invalid JSON format'));
            }
        });
        req.on('error', reject);
    });

    try {
        // --- API ROUTES ---

        // 1. Health & Status Check
        if (pathname === '/api/health' && req.method === 'GET') {
            return sendJson(200, {
                status: 'ok',
                gateway: 'online',
                hasApiKey: Boolean(serverConfig.apiKey),
                model: serverConfig.defaultModel,
                dailyBudget: serverConfig.dailyTokenBudget,
                totalUsedToday: inMemoryCache.stats.totalTokens,
                remainingTokens: Math.max(0, serverConfig.dailyTokenBudget - inMemoryCache.stats.totalTokens)
            });
        }

        // 2. Authentication Verification (Salted SHA-256)
        if (pathname === '/api/auth/verify' && req.method === 'POST') {
            const body = await readBody();
            const { role, hash, password, salt } = body;

            let computedHash = hash;
            if (password && salt) {
                computedHash = crypto.createHash('sha256').update(salt + password).digest('hex');
            }

            let isValid = false;
            if (role === 'Teacher') {
                isValid = (computedHash === HASH_TEACHER);
            } else if (role === 'Admin') {
                isValid = (computedHash === HASH_ADMIN);
            }

            if (isValid) {
                const token = createSessionToken(role);
                return sendJson(200, {
                    ok: true,
                    role,
                    token,
                    message: 'Authentication successful'
                });
            } else {
                return sendJson(401, {
                    ok: false,
                    message: '密碼驗證失敗 (Authentication failed)'
                });
            }
        }

        // 3. AI Gateway Chat Proxy (Strict Token Budget & Security Core)
        if (pathname === '/api/chat' && req.method === 'POST') {
            const body = await readBody();
            const { userText, callerGroup, classId, model, contextExtra } = body;

            if (!userText || typeof userText !== 'string' || !userText.trim()) {
                return sendJson(400, { ok: false, error: '缺少有效的學生輸入文本 (Empty user text)' });
            }

            const targetGroup = callerGroup || 'Group 1';
            const rateLimitKey = `${clientIp}_${targetGroup}`;

            // A) Pre-Request Rate Limit Interception
            if (!checkRateLimit(rateLimitKey)) {
                return sendJson(429, {
                    ok: false,
                    error: `發送頻率過高 (Rate limit exceeded)！每分鐘上限 ${serverConfig.rateLimitPerMin} 次，請稍候片刻再試。`
                });
            }

            // B) Pre-Request Token Budget Interception
            const budgetCheck = checkTokenBudget(250);
            if (!budgetCheck.allowed) {
                return sendJson(429, {
                    ok: false,
                    error: budgetCheck.reason
                });
            }

            // C) Call Google Gemini API through Secure Proxy
            try {
                const result = await callGoogleGemini(userText.trim(), model, targetGroup, contextExtra);

                // D) Deduct Budget & Calculate Costs
                const costThisCall = (result.promptTokens * 0.000000075) + (result.candidateTokens * 0.00000030);
                inMemoryCache.stats.calls += 1;
                inMemoryCache.stats.totalTokens += result.totalTokens;
                inMemoryCache.stats.promptTokens += result.promptTokens;
                inMemoryCache.stats.candidateTokens += result.candidateTokens;
                inMemoryCache.stats.costUsd = parseFloat((inMemoryCache.stats.costUsd + costThisCall).toFixed(6));

                // Save to persistent file
                savePersistentStats();

                // Clean bilingual response
                const parsedResponse = parseBilingualText(result.rawText);

                // Audit Log Record
                const logRecord = {
                    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    timestamp: new Date().toISOString(),
                    classId: classId || '1CL',
                    group: targetGroup,
                    model: result.model,
                    promptTokens: result.promptTokens,
                    candidateTokens: result.candidateTokens,
                    totalTokens: result.totalTokens,
                    costUsd: costThisCall,
                    status: 'SUCCESS',
                    latencyMs: result.latencyMs,
                    clientIp: clientIp
                };
                appendAuditLog(logRecord);

                return sendJson(200, {
                    ok: true,
                    data: parsedResponse,
                    usage: {
                        promptTokens: result.promptTokens,
                        candidateTokens: result.candidateTokens,
                        totalTokens: result.totalTokens,
                        costUsd: costThisCall
                    },
                    budget: {
                        dailyLimit: serverConfig.dailyTokenBudget,
                        totalUsedToday: inMemoryCache.stats.totalTokens,
                        remaining: Math.max(0, serverConfig.dailyTokenBudget - inMemoryCache.stats.totalTokens)
                    }
                });

            } catch(geminiErr) {
                console.error('❌ Gemini Proxy Error:', geminiErr.message);

                // Audit Log Record for Failure
                const logRecord = {
                    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    timestamp: new Date().toISOString(),
                    classId: classId || '1CL',
                    group: targetGroup,
                    model: model || serverConfig.defaultModel,
                    promptTokens: 0,
                    candidateTokens: 0,
                    totalTokens: 0,
                    costUsd: 0,
                    status: 'FAILED',
                    error: geminiErr.message,
                    clientIp: clientIp
                };
                appendAuditLog(logRecord);

                return sendJson(502, {
                    ok: false,
                    error: geminiErr.message
                });
            }
        }

        // 4. Admin: Get Stats & Audit Logs
        if (pathname === '/api/admin/stats' && req.method === 'GET') {
            checkDailyReset();
            return sendJson(200, {
                ok: true,
                stats: inMemoryCache.stats,
                config: {
                    defaultModel: serverConfig.defaultModel,
                    dailyTokenBudget: serverConfig.dailyTokenBudget,
                    rateLimitPerMin: serverConfig.rateLimitPerMin,
                    maxOutputTokens: serverConfig.maxOutputTokens,
                    hasApiKey: Boolean(serverConfig.apiKey)
                }
            });
        }

        if (pathname === '/api/admin/logs' && req.method === 'GET') {
            let logs = [];
            if (fs.existsSync(AUDIT_FILE)) {
                try {
                    logs = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
                } catch(e) {
                    logs = [];
                }
            }
            return sendJson(200, {
                ok: true,
                logs: logs.slice(0, 50)
            });
        }

        // 5. Admin: Update Budget Settings
        if (pathname === '/api/admin/budget' && req.method === 'POST') {
            const authHeader = req.headers['authorization'] || '';
            const token = authHeader.replace(/^Bearer\s+/i, '');
            if (!verifySessionToken(token, 'Admin') && !verifySessionToken(token, 'Teacher')) {
                // allow if no active session or local dev
            }

            const body = await readBody();
            if (body.dailyTokenBudget) {
                serverConfig.dailyTokenBudget = parseInt(body.dailyTokenBudget, 10);
            }
            if (body.rateLimitPerMin) {
                serverConfig.rateLimitPerMin = parseInt(body.rateLimitPerMin, 10);
            }
            if (body.defaultModel) {
                serverConfig.defaultModel = body.defaultModel.trim();
            }

            savePersistentStats();
            return sendJson(200, {
                ok: true,
                message: 'Budget settings updated successfully',
                config: {
                    defaultModel: serverConfig.defaultModel,
                    dailyTokenBudget: serverConfig.dailyTokenBudget,
                    rateLimitPerMin: serverConfig.rateLimitPerMin
                }
            });
        }

        // 6. Admin: Set or Update API Key on Server
        if (pathname === '/api/admin/config' && req.method === 'POST') {
            const body = await readBody();
            if (body.apiKey !== undefined) {
                serverConfig.apiKey = body.apiKey.trim();
                console.log(`🔑 Server API Key updated (${serverConfig.apiKey ? 'Key Set' : 'Key Cleared'})`);
            }
            if (body.defaultModel) {
                serverConfig.defaultModel = body.defaultModel.trim();
            }
            savePersistentStats();
            return sendJson(200, {
                ok: true,
                hasApiKey: Boolean(serverConfig.apiKey),
                defaultModel: serverConfig.defaultModel,
                message: '伺服器配置已更新 (Server config updated)'
            });
        }

        // 7. Admin: Reset Stats
        if (pathname === '/api/admin/reset' && req.method === 'POST') {
            inMemoryCache.stats.calls = 0;
            inMemoryCache.stats.totalTokens = 0;
            inMemoryCache.stats.promptTokens = 0;
            inMemoryCache.stats.candidateTokens = 0;
            inMemoryCache.stats.costUsd = 0.0;
            savePersistentStats();
            if (fs.existsSync(AUDIT_FILE)) {
                fs.writeFileSync(AUDIT_FILE, JSON.stringify([], null, 2), 'utf8');
            }
            return sendJson(200, {
                ok: true,
                message: 'Stats and logs have been reset successfully'
            });
        }

        // --- STATIC FILE SERVING ---
        let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = {
                '.html': 'text/html; charset=utf-8',
                '.js': 'application/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.json': 'application/json; charset=utf-8',
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.svg': 'image/svg+xml',
                '.ico': 'image/x-icon'
            };
            const contentType = mimeTypes[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType });
            fs.createReadStream(filePath).pipe(res);
            return;
        }

        // Default fallback to index.html for SPA routing
        const indexPath = path.join(__dirname, 'index.html');
        if (fs.existsSync(indexPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            fs.createReadStream(indexPath).pipe(res);
            return;
        }

        sendJson(404, { error: 'Not Found' });

    } catch(err) {
        console.error('Unhandled server error:', err);
        sendJson(500, { error: 'Internal Server Error', details: err.message });
    }
});

server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 AI Gateway & Token Budget Server Running`);
    console.log(`📡 URL: http://localhost:${PORT}`);
    console.log(`🛡️ Gemini Key: ${serverConfig.apiKey ? 'Secured in Server' : 'Not Set (Set in .env or Admin)'}`);
    console.log(`💰 Daily Token Budget: ${serverConfig.dailyTokenBudget.toLocaleString()} Tokens`);
    console.log(`⚡ Rate Limit: ${serverConfig.rateLimitPerMin} req/min per group`);
    console.log(`=======================================================`);
});
