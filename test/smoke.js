/**
 * Smoke test: starts the Express server standalone (without VS Code APIs)
 * and verifies routes respond correctly.
 *
 * Run: node test/smoke.js
 */

const http = require('http');

const PORT = 9876;
const FAKE_TOKEN = 'test-token-12345';

// Mock vscode module before requiring server code
const mockVscode = {
    workspace: {
        getConfiguration: () => ({
            get: (key, def) => def,
        }),
        workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    },
    window: {
        activeTerminal: null,
        terminals: [],
        createTerminal: () => ({ show: () => {}, sendText: () => {} }),
    },
};

// Intercept require('vscode')
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === 'vscode') return mockVscode;
    return originalRequire.apply(this, arguments);
};

const express = require('express');
const { authMiddleware } = require('../dist/server/middleware');
const { authRoutes } = require('../dist/server/routes/auth');
const { fileRoutes } = require('../dist/server/routes/files');
const { usageRoutes } = require('../dist/server/routes/usage');
const { bugfixRoutes } = require('../dist/server/routes/bugfix');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes(FAKE_TOKEN));
app.use('/api', authMiddleware(FAKE_TOKEN));
app.use('/api/files', fileRoutes());
app.use('/api/usage', usageRoutes());
app.use('/api/bugs', bugfixRoutes());

let server;
let passed = 0;
let failed = 0;

function fetch(path, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, `http://localhost:${PORT}`);
        const opts = {
            hostname: 'localhost',
            port: PORT,
            path: url.pathname + url.search,
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {}),
            },
        };
        const req = http.request(opts, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(body) });
                } catch {
                    resolve({ status: res.statusCode, data: body });
                }
            });
        });
        req.on('error', reject);
        if (options.body) req.write(JSON.stringify(options.body));
        req.end();
    });
}

function assert(name, condition) {
    if (condition) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.log(`  ❌ ${name}`);
        failed++;
    }
}

async function runTests() {
    console.log('\n🧪 Remote Control — Smoke Tests\n');

    // 1. Auth: reject without token
    console.log('Auth:');
    let res = await fetch('/api/files/list');
    assert('Rejects request without token', res.status === 401);

    // 2. Auth: accept with token
    res = await fetch('/api/files/list?token=' + FAKE_TOKEN);
    assert('Accepts request with valid token', res.status === 200);

    // 3. Auth check endpoint
    res = await fetch('/api/auth/check?token=' + FAKE_TOKEN);
    assert('Auth check returns authenticated', res.data.authenticated === true);

    res = await fetch('/api/auth/check?token=wrong');
    assert('Auth check rejects bad token', res.data.authenticated === false);

    // 4. Files: list workspace root
    console.log('\nFiles:');
    res = await fetch('/api/files/list?token=' + FAKE_TOKEN);
    assert('Lists files in workspace root', res.data.success === true && Array.isArray(res.data.items));
    assert('Found package.json in listing', res.data.items?.some(i => i.name === 'package.json'));

    // 5. Files: read a file
    res = await fetch('/api/files/read?token=' + FAKE_TOKEN + '&path=package.json');
    assert('Reads package.json', res.data.success === true && res.data.content.includes('remote-ide-extension'));

    // 6. Files: path traversal protection
    res = await fetch('/api/files/read?token=' + FAKE_TOKEN + '&path=../../etc/passwd');
    assert('Blocks path traversal attempt', res.status === 403);

    // 7. Usage: summary
    console.log('\nUsage:');
    res = await fetch('/api/usage/summary?token=' + FAKE_TOKEN);
    assert('Returns usage summary', res.data.success === true && res.data.totalRequests === 0);

    // 8. Usage: log an entry
    res = await fetch('/api/usage/log?token=' + FAKE_TOKEN, {
        method: 'POST',
        body: { model: 'gpt-4o', inputTokens: 100, outputTokens: 50, action: 'chat' },
    });
    assert('Logs usage entry', res.data.success === true);

    res = await fetch('/api/usage/summary?token=' + FAKE_TOKEN);
    assert('Summary reflects logged entry', res.data.totalRequests === 1);

    // 9. Bugs: create, list, update
    console.log('\nBugs:');
    res = await fetch('/api/bugs/report?token=' + FAKE_TOKEN, {
        method: 'POST',
        body: { title: 'Test Bug', description: 'A test bug', reproSteps: ['step1', 'step2'] },
    });
    assert('Creates bug report', res.data.success === true && res.data.bug.id.startsWith('BUG-'));
    const bugId = res.data.bug.id;

    res = await fetch('/api/bugs/list?token=' + FAKE_TOKEN);
    assert('Lists bugs', res.data.bugs.length === 1);

    res = await fetch(`/api/bugs/${bugId}?token=` + FAKE_TOKEN);
    assert('Gets bug by ID', res.data.bug.title === 'Test Bug');

    res = await fetch(`/api/bugs/${bugId}?token=` + FAKE_TOKEN, {
        method: 'PATCH',
        body: { status: 'fixing' },
    });
    assert('Updates bug status', res.data.bug.status === 'fixing');

    // Summary
    console.log(`\n${'─'.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
    console.log(`${'─'.repeat(40)}\n`);

    server.close();
    process.exit(failed > 0 ? 1 : 0);
}

server = app.listen(PORT, () => {
    console.log(`Test server on port ${PORT}`);
    runTests().catch((err) => {
        console.error('Test error:', err);
        server.close();
        process.exit(1);
    });
});
