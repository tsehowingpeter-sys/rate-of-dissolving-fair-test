/**
 * Test Suite for AI Gateway Server & Security Logic
 */
const http = require('http');
const crypto = require('crypto');

const AUTH_SALT = 'salt_fair_test_2026_xK9#mQ';
const TEACHER_HASH = crypto.createHash('sha256').update(AUTH_SALT + 'teacherwater').digest('hex');
const ADMIN_HASH = crypto.createHash('sha256').update(AUTH_SALT + 'teacheradmin').digest('hex');

function request(options, data) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, headers: res.headers, data: body ? JSON.parse(body) : {} });
                } catch(e) {
                    resolve({ status: res.statusCode, headers: res.headers, raw: body });
                }
            });
        });
        req.on('error', reject);
        if (data) {
            req.write(typeof data === 'string' ? data : JSON.stringify(data));
        }
        req.end();
    });
}

async function runTests() {
    console.log("🧪 Starting Automated Test Suite for AI Gateway & Security...");
    let testsPassed = 0;

    // 1. Health check
    const health = await request({ host: 'localhost', port: 3000, path: '/api/health', method: 'GET' });
    if (health.status === 200 && health.data.gateway === 'online') {
        console.log("✅ Test 1 Passed: /api/health returned online status & budget");
        testsPassed++;
    } else {
        console.error("❌ Test 1 Failed:", health);
    }

    // 2. Auth verification: Teacher
    const teacherAuth = await request(
        { host: 'localhost', port: 3000, path: '/api/auth/verify', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        { role: 'Teacher', hash: TEACHER_HASH }
    );
    if (teacherAuth.status === 200 && teacherAuth.data.ok === true && teacherAuth.data.token) {
        console.log("✅ Test 2 Passed: Teacher salted hash verified, session token issued");
        testsPassed++;
    } else {
        console.error("❌ Test 2 Failed:", teacherAuth);
    }

    // 3. Auth verification: Admin
    const adminAuth = await request(
        { host: 'localhost', port: 3000, path: '/api/auth/verify', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        { role: 'Admin', hash: ADMIN_HASH }
    );
    if (adminAuth.status === 200 && adminAuth.data.ok === true && adminAuth.data.token) {
        console.log("✅ Test 3 Passed: Admin salted hash verified, session token issued");
        testsPassed++;
    } else {
        console.error("❌ Test 3 Failed:", adminAuth);
    }

    // 4. Auth verification: Invalid password
    const wrongAuth = await request(
        { host: 'localhost', port: 3000, path: '/api/auth/verify', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        { role: 'Admin', hash: 'bad_hash_12345' }
    );
    if (wrongAuth.status === 401 && wrongAuth.data.ok === false) {
        console.log("✅ Test 4 Passed: Invalid hash rejected with HTTP 401");
        testsPassed++;
    } else {
        console.error("❌ Test 4 Failed:", wrongAuth);
    }

    // 5. Chat endpoint validation: missing input
    const emptyChat = await request(
        { host: 'localhost', port: 3000, path: '/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        { userText: '', callerGroup: 'Group 3' }
    );
    if (emptyChat.status === 400) {
        console.log("✅ Test 5 Passed: Empty userText rejected with HTTP 400");
        testsPassed++;
    } else {
        console.error("❌ Test 5 Failed:", emptyChat);
    }

    // 6. Admin stats check
    const statsRes = await request({ host: 'localhost', port: 3000, path: '/api/admin/stats', method: 'GET' });
    if (statsRes.status === 200 && statsRes.data.stats && statsRes.data.config) {
        console.log("✅ Test 6 Passed: /api/admin/stats returned usage stats and budget limits");
        testsPassed++;
    } else {
        console.error("❌ Test 6 Failed:", statsRes);
    }

    // 7. Admin budget update
    const budgetUpdate = await request(
        { host: 'localhost', port: 3000, path: '/api/admin/budget', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        { dailyTokenBudget: 150000, rateLimitPerMin: 20 }
    );
    if (budgetUpdate.status === 200 && budgetUpdate.data.config.dailyTokenBudget === 150000) {
        console.log("✅ Test 7 Passed: /api/admin/budget updated daily budget limit");
        testsPassed++;
    } else {
        console.error("❌ Test 7 Failed:", budgetUpdate);
    }

    console.log(`\n🎉 Test Results: ${testsPassed}/7 Tests Passed Successfully!`);
}

// If invoked directly, run tests
runTests().catch(err => {
    console.error("Test execution exception:", err);
});
