// === State ===
const params = new URLSearchParams(window.location.search);
const TOKEN = params.get('token') || '';
const BASE = window.location.origin;
let currentPath = '';
let eventSource = null;
let promptPending = false; // true after sending a prompt, until accept/reject

// === SVG Icon Helper ===
function icon(name, size = 16) {
    return `<svg width="${size}" height="${size}"><use href="#i-${name}"/></svg>`;
}

// Activity type → icon mapping
const ACTIVITY_ICON_MAP = {
    'prompt': 'chat', 'action': 'zap', 'file-edit': 'file',
    'file-save': 'file', 'error': 'x', 'info': 'file', 'terminal': 'terminal'
};

// === API Helper ===
async function api(endpoint, options = {}) {
    const url = new URL(`/api${endpoint}`, BASE);
    url.searchParams.set('token', TOKEN);
    const res = await fetch(url.toString(), {
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': TOKEN },
        ...options,
    });
    return res.json();
}

// === SSE ===
let sseConnected = false;
function connectSSE() {
    const url = `${BASE}/api/events?token=${encodeURIComponent(TOKEN)}`;
    eventSource = new EventSource(url);

    eventSource.addEventListener('connected', () => {
        sseConnected = true;
        const dot = document.getElementById('status-dot');
        dot.classList.add('connected');
        document.getElementById('status-label').textContent = 'Connected';
    });

    eventSource.addEventListener('chat-update', (e) => {
        const data = JSON.parse(e.data);
        const container = document.getElementById('chat-container');
        container.innerHTML = data.html;
        container.scrollTop = container.scrollHeight;
    });

    eventSource.addEventListener('activity', (e) => {
        const entry = JSON.parse(e.data);
        appendActivityEntry(entry);
    });

    eventSource.addEventListener('chat-message', (e) => {
        const msg = JSON.parse(e.data);
        appendChatMessage(msg, true);
    });

    eventSource.addEventListener('chat-message-update', (e) => {
        const msg = JSON.parse(e.data);
        updateChatMessage(msg);
    });

    eventSource.addEventListener('terminal-output', (e) => {
        const data = JSON.parse(e.data);
        const output = document.getElementById('terminal-output');
        output.textContent += data.data;
        if (output.textContent.length > 10000) {
            output.textContent = output.textContent.slice(-8000);
        }
        output.scrollTop = output.scrollHeight;
    });

    // --- IDE real-time events ---
    eventSource.addEventListener('ide-active-editor', (e) => {
        const data = JSON.parse(e.data);
        updateActiveFile(data.file, data.languageId);
    });

    eventSource.addEventListener('ide-file-saved', (e) => {
        const data = JSON.parse(e.data);
        showToast(`Saved: ${shortPath(data.file)}`);
        if (promptPending) toggleQuickActions(true);
    });

    eventSource.addEventListener('ide-file-changed', (e) => {
        const data = JSON.parse(e.data);
        const el = document.getElementById('ide-active-file');
        if (el && data.file) {
            el.textContent = (data.dirty ? '● ' : '') + shortPath(data.file);
        }
        if (promptPending) toggleQuickActions(true);
    });

    eventSource.addEventListener('ide-diagnostics', (e) => {
        const data = JSON.parse(e.data);
        updateDiagnostics(data);
    });

    eventSource.addEventListener('ide-terminal-change', (e) => {
        const data = JSON.parse(e.data);
        updateTerminalList(data.terminals);
    });

    eventSource.addEventListener('ide-cursor', (e) => {
        const data = JSON.parse(e.data);
        const el = document.getElementById('ide-cursor-pos');
        if (el) el.textContent = `Ln ${data.line}, Col ${data.column}`;
    });

    eventSource.addEventListener('ide-snapshot', (e) => {
        const data = JSON.parse(e.data);
        applySnapshot(data);
    });

    eventSource.addEventListener('ide-window-state', (e) => {
        const data = JSON.parse(e.data);
        document.getElementById('status-dot')?.classList.toggle('focused', data.focused);
    });

    eventSource.addEventListener('pending-review', (e) => {
        const data = JSON.parse(e.data);
        toggleQuickActions(data.pending);
    });

    eventSource.onerror = () => {
        sseConnected = false;
        const dot = document.getElementById('status-dot');
        dot.classList.remove('connected');
        document.getElementById('status-label').textContent = 'Offline';
        setTimeout(() => {
            if (eventSource) eventSource.close();
            connectSSE();
        }, 3000);
    };

    setTimeout(() => {
        if (!sseConnected) startStatusPolling();
    }, 5000);
}

function startStatusPolling() {
    if (sseConnected) return;
    setInterval(async () => {
        try {
            const data = await api('/chat/status');
            if (data.success) {
                document.getElementById('status-dot').classList.add('connected');
                document.getElementById('status-label').textContent = 'Connected';
            }
        } catch {
            document.getElementById('status-dot').classList.remove('connected');
            document.getElementById('status-label').textContent = 'Offline';
        }
    }, 5000);
}

// === Tab Navigation (Bottom Nav) ===
document.querySelectorAll('.nav-item').forEach(navBtn => {
    navBtn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => {
            p.classList.remove('active');
        });
        navBtn.classList.add('active');
        const panel = document.getElementById(`tab-${navBtn.dataset.tab}`);
        panel.classList.add('active');
        onTabActivated(navBtn.dataset.tab);
    });
});

function onTabActivated(tab) {
    if (tab === 'chat') loadChat();
    if (tab === 'files') navigateFiles(currentPath);
    if (tab === 'terminal') loadTerminal();
    if (tab === 'usage') refreshUsage();
    if (tab === 'bugs') loadBugs();
}

// === Chat ===
let chatViewMode = 'conversation';

async function loadChat() {
    const container = document.getElementById('chat-container');
    container.innerHTML = '';

    try {
        const data = await api('/chat/messages');
        if (data.success && data.messages && data.messages.length > 0) {
            chatViewMode = 'conversation';
            addChatViewToggle(container);
            for (const msg of data.messages) {
                appendChatMessage(msg, false);
            }
            container.scrollTop = container.scrollHeight;
            return;
        }
    } catch { /* fall through */ }

    chatViewMode = 'activity';
    seenActivityIds.clear();

    const actData = await api('/chat/activity');
    if (actData.entries && actData.entries.length > 0) {
        actData.entries.forEach(entry => appendActivityEntry(entry, false));
    } else {
        try {
            const snap = await api('/ide/status');
            if (snap.success) {
                appendActivityEntry({ id: -1, time: Date.now(), type: 'info', text: `Workspace: ${snap.workspaceFolder || 'unknown'}` }, false);
                if (snap.activeFile) {
                    appendActivityEntry({ id: -2, time: Date.now(), type: 'info', text: `Active: ${shortPath(snap.activeFile)}` }, false);
                }
            }
        } catch { /* ignore */ }
    }
    container.scrollTop = container.scrollHeight;
}

function addChatViewToggle(container) {
    const toggle = document.createElement('div');
    toggle.className = 'segment-control';
    toggle.innerHTML = `
        <button class="segment ${chatViewMode === 'conversation' ? 'active' : ''}" onclick="switchChatView('conversation')">Conversation</button>
        <button class="segment ${chatViewMode === 'activity' ? 'active' : ''}" onclick="switchChatView('activity')">Activity</button>
    `;
    container.appendChild(toggle);
}

async function switchChatView(mode) {
    chatViewMode = mode;
    const container = document.getElementById('chat-container');
    container.innerHTML = '';
    addChatViewToggle(container);

    if (mode === 'conversation') {
        try {
            const data = await api('/chat/messages');
            if (data.success && data.messages) {
                for (const msg of data.messages) {
                    appendChatMessage(msg, false);
                }
            }
        } catch { /* ignore */ }
    } else {
        seenActivityIds.clear();
        const actData = await api('/chat/activity');
        if (actData.entries) {
            actData.entries.forEach(entry => appendActivityEntry(entry, false));
        }
    }
    container.scrollTop = container.scrollHeight;
}

function appendChatMessage(msg, scroll) {
    if (chatViewMode !== 'conversation') return;
    const container = document.getElementById('chat-container');

    const div = document.createElement('div');
    div.className = `chat-msg chat-msg-${msg.role}`;
    div.dataset.requestIndex = String(msg.requestIndex);

    if (msg.role === 'user') {
        div.innerHTML = `
            <div class="chat-msg-header">
                <span class="chat-role">${icon('user', 14)} You</span>
                <span class="chat-time">${formatTime(msg.timestamp)}</span>
            </div>
            <div class="chat-msg-body">${escapeHtml(msg.text)}</div>
        `;
    } else {
        const bodyHtml = renderMarkdownLite(msg.text);
        const tokenInfo = msg.tokens
            ? `<span class="chat-tokens">${msg.tokens.prompt || 0} → ${msg.tokens.output || 0} tok</span>`
            : '';
        const statusClass = msg.completed ? 'done' : 'pending';
        const statusText = msg.completed ? 'Done' : 'Thinking...';
        div.innerHTML = `
            <div class="chat-msg-header">
                <span class="chat-role">${icon('bot', 14)} Copilot</span>
                <span class="chat-status ${statusClass}">${statusText}</span>
                ${tokenInfo}
                <span class="chat-time">${formatTime(msg.timestamp)}</span>
            </div>
            <div class="chat-msg-body">${bodyHtml}</div>
        `;
    }

    container.appendChild(div);
    while (container.children.length > 200) container.removeChild(container.firstChild);
    if (scroll) container.scrollTop = container.scrollHeight;
}

function updateChatMessage(msg) {
    if (chatViewMode !== 'conversation') return;
    const container = document.getElementById('chat-container');
    const existing = container.querySelector(
        `.chat-msg-${msg.role}[data-request-index="${msg.requestIndex}"]`
    );
    if (existing) {
        if (msg.role === 'assistant') {
            const body = existing.querySelector('.chat-msg-body');
            if (body) body.innerHTML = renderMarkdownLite(msg.text);
            const status = existing.querySelector('.chat-status');
            if (status) {
                status.className = `chat-status ${msg.completed ? 'done' : 'pending'}`;
                status.textContent = msg.completed ? 'Done' : 'Thinking...';
            }
            if (msg.tokens) {
                let tokenEl = existing.querySelector('.chat-tokens');
                if (tokenEl) {
                    tokenEl.textContent = `${msg.tokens.prompt || 0} → ${msg.tokens.output || 0} tok`;
                }
            }
        }
        container.scrollTop = container.scrollHeight;
    } else {
        appendChatMessage(msg, true);
    }
}

function formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Lightweight markdown → HTML for mobile display */
function renderMarkdownLite(md) {
    if (!md) return '';
    let html = escapeHtml(md);

    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre class="chat-code"><code>${code.trim()}</code></pre>`;
    });
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Line breaks
    html = html.replace(/\n/g, '<br>');
    // Bullet lists
    html = html.replace(/^- (.+)/gm, '• $1');

    return html;
}

async function sendPrompt() {
    const input = document.getElementById('prompt-input');
    const prompt = input.value.trim();
    if (!prompt) return;
    input.value = '';
    promptPending = true;
    appendActivityEntry({
        id: Date.now(), time: Date.now(), type: 'prompt',
        text: `Prompt: ${prompt.substring(0, 100)}`,
    });
    await api('/chat/send', {
        method: 'POST',
        body: JSON.stringify({ prompt }),
    });
}

async function sendAction(action, btnEl) {
    const btn = btnEl || document.querySelector(action === 'accept' ? '.qa-accept' : '.qa-reject');
    if (btn) btn.style.opacity = '0.5';
    try {
        const data = await api('/chat/action', {
            method: 'POST',
            body: JSON.stringify({ action }),
        });
        if (data.success) {
            showToast(action === 'accept' ? 'Accepted' : 'Rejected');
            promptPending = false;
            toggleQuickActions(false);
        }
    } catch (e) { console.error('sendAction error', e); }
    setTimeout(() => { if (btn) btn.style.opacity = '1'; }, 500);
}

function toggleQuickActions(show) {
    const el = document.getElementById('quick-actions');
    if (el) el.classList.toggle('hidden', !show);
}

// Prompt on Enter (Shift+Enter for newline)
document.getElementById('prompt-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendPrompt();
    }
});

// === Files ===
async function navigateFiles(dirPath) {
    currentPath = dirPath;
    const data = await api(`/files/list?path=${encodeURIComponent(dirPath)}`);
    const list = document.getElementById('file-list');

    // Update breadcrumb
    const breadcrumb = document.getElementById('file-breadcrumb');
    const parts = dirPath ? dirPath.split('/') : [];
    let html = `<button onclick="navigateFiles('')" class="crumb">${icon('home', 14)}<span>root</span></button>`;
    let accumulated = '';
    for (const part of parts) {
        accumulated += (accumulated ? '/' : '') + part;
        const path = accumulated;
        html += `<button onclick="navigateFiles('${path}')" class="crumb">${icon('chevron', 10)}<span>${part}</span></button>`;
    }
    breadcrumb.innerHTML = html;

    // Render files
    if (data.items) {
        list.innerHTML = data.items.map(item => {
            const isDir = item.type === 'directory';
            const clickAction = isDir
                ? `navigateFiles('${item.path}')`
                : `viewFile('${item.path}')`;
            return `
                <div class="file-item" onclick="${clickAction}">
                    ${icon(isDir ? 'folder' : 'file')}
                    <span class="file-name">${item.name}</span>
                    ${isDir ? `<span class="file-arrow">${icon('chevron', 14)}</span>` : ''}
                </div>
            `;
        }).join('');
    } else {
        list.innerHTML = '<p class="placeholder">No files found</p>';
    }
}

async function viewFile(filePath) {
    const data = await api(`/files/read?path=${encodeURIComponent(filePath)}`);
    document.getElementById('file-viewer-name').textContent = filePath;
    document.getElementById('file-viewer-content').textContent = data.content || '';
    document.getElementById('file-viewer').classList.remove('hidden');
}

function closeFileViewer() {
    document.getElementById('file-viewer').classList.add('hidden');
}

// === Terminal ===
async function loadTerminal() {
    const data = await api('/terminal/output');
    const output = document.getElementById('terminal-output');
    if (data.output) {
        output.textContent = data.output;
    } else {
        output.textContent = '$ Ready for commands...\n';
    }
    output.scrollTop = output.scrollHeight;
    const cmdInput = document.getElementById('cmd-input');
    if (cmdInput) cmdInput.focus();
}

async function executeCommand() {
    const input = document.getElementById('cmd-input');
    if (!input) return;
    const command = input.value.trim();
    if (!command) return;
    input.value = '';

    try {
        const data = await api('/terminal/execute', {
            method: 'POST',
            body: JSON.stringify({ command }),
        });
        if (!data.success) {
            const output = document.getElementById('terminal-output');
            output.textContent += `Error: ${data.error || 'Failed to execute'}\n`;
            output.scrollTop = output.scrollHeight;
        }
    } catch (e) {
        const output = document.getElementById('terminal-output');
        output.textContent += `Error: ${e.message}\n`;
        output.scrollTop = output.scrollHeight;
    }
}

function bindTerminalInput() {
    const cmdInput = document.getElementById('cmd-input');
    if (cmdInput) {
        cmdInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                executeCommand();
            }
        });
    }
}
bindTerminalInput();
document.addEventListener('DOMContentLoaded', bindTerminalInput);

// === Usage ===
async function refreshUsage() {
    const data = await api('/usage/summary');
    const modelData = await api('/usage/current-model');

    const kpis = document.getElementById('usage-kpis');
    kpis.innerHTML = `
        <div class="kpi-card">
            <div class="kpi-value">${data.totalRequests || 0}</div>
            <div class="kpi-label">Requests</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-value">${data.totalEstimatedCost || '$0.00'}</div>
            <div class="kpi-label">Est. Cost</div>
        </div>
        <div class="kpi-card">
            <div class="kpi-value">${modelData.model || 'N/A'}</div>
            <div class="kpi-label">Model</div>
        </div>
    `;

    const details = document.getElementById('usage-details');
    if (data.byModel && Object.keys(data.byModel).length > 0) {
        details.innerHTML = Object.entries(data.byModel).map(([name, m]) => `
            <div class="usage-model">
                <div class="usage-model-name">${name}</div>
                <div class="usage-model-stat">Requests: ${m.requests}</div>
                <div class="usage-model-stat">Input tokens: ${m.inputTokens.toLocaleString()}</div>
                <div class="usage-model-stat">Output tokens: ${m.outputTokens.toLocaleString()}</div>
                <div class="usage-model-stat">Cost: $${m.estimatedCost.toFixed(4)}</div>
            </div>
        `).join('');
    } else {
        details.innerHTML = '<p class="placeholder">No usage data yet</p>';
    }
}

// === Bugs ===
async function loadBugs() {
    const data = await api('/bugs/list');
    const list = document.getElementById('bug-list');

    if (data.bugs && data.bugs.length > 0) {
        list.innerHTML = data.bugs.map(bug => `
            <div class="bug-card">
                <div class="bug-card-header">
                    <span class="bug-card-title">${escapeHtml(bug.title)}</span>
                    <span class="bug-status ${bug.status}">${bug.status}</span>
                </div>
                <div class="bug-card-desc">${escapeHtml(bug.description)}</div>
                <div class="bug-card-actions">
                    ${bug.status === 'open' ? `<button onclick="updateBug('${bug.id}', 'fixing')">Start Fix</button>` : ''}
                    ${bug.status === 'fixing' ? `<button onclick="updateBug('${bug.id}', 'fixed')">Mark Fixed</button>` : ''}
                    ${bug.status === 'fixed' ? `<button onclick="verifyBug('${bug.id}')">Verify</button>` : ''}
                </div>
            </div>
        `).join('');
    } else {
        list.innerHTML = '<p class="placeholder">No bugs reported</p>';
    }
}

function showNewBugForm() {
    document.getElementById('new-bug-form').classList.remove('hidden');
}

function hideNewBugForm() {
    document.getElementById('new-bug-form').classList.add('hidden');
}

async function submitBug() {
    const title = document.getElementById('bug-title').value.trim();
    const description = document.getElementById('bug-desc').value.trim();
    const stepsText = document.getElementById('bug-steps').value.trim();
    const reproSteps = stepsText ? stepsText.split('\n').filter(s => s.trim()) : [];

    if (!title) return;

    await api('/bugs/report', {
        method: 'POST',
        body: JSON.stringify({ title, description, reproSteps }),
    });

    document.getElementById('bug-title').value = '';
    document.getElementById('bug-desc').value = '';
    document.getElementById('bug-steps').value = '';
    hideNewBugForm();
    loadBugs();
}

async function updateBug(id, status) {
    await api(`/bugs/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
    });
    loadBugs();
}

async function verifyBug(id) {
    const data = await api(`/bugs/${id}/verify`, { method: 'POST' });
    showToast(data.fixVerified ? 'Fix verified — tests pass' : 'Fix not verified — tests failed');
    loadBugs();
}

// === Screenshot ===
async function captureScreenshot() {
    const img = document.getElementById('screenshot-img');
    const btn = document.getElementById('capture-btn');
    img.alt = 'Capturing...';
    img.src = '';
    if (btn) {
        btn.querySelector('span').textContent = 'Capturing...';
        btn.disabled = true;
    }
    try {
        const data = await api('/screenshot/capture');
        if (data.success && data.image) {
            img.src = data.image;
            img.alt = 'IDE Screenshot';
        } else {
            img.alt = data.error || 'Failed to capture';
        }
    } catch (e) {
        img.alt = 'Error: ' + e.message;
    }
    if (btn) {
        btn.querySelector('span').textContent = 'Capture Screen';
        btn.disabled = false;
    }
}

// === Helpers ===
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

// === Init ===
connectSSE();
loadChat();
fetchIDEStatus();
checkPendingReview();

async function checkPendingReview() {
    try {
        const data = await api('/chat/pending');
        if (data.success) toggleQuickActions(data.pending);
    } catch { /* ignore */ }
}

// === IDE Real-time Helpers ===
function shortPath(fullPath) {
    if (!fullPath) return '';
    const parts = fullPath.replace(/\\/g, '/').split('/');
    return parts.slice(-2).join('/');
}

function updateActiveFile(file, languageId) {
    const el = document.getElementById('ide-active-file');
    if (el) {
        el.textContent = file ? shortPath(file) : 'No file open';
        el.title = file || '';
    }
}

function updateDiagnostics(data) {
    const el = document.getElementById('ide-diagnostics');
    if (!el) return;
    if (data.errors > 0) {
        el.textContent = `${data.errors} errors`;
        el.className = 'sf-meta has-errors';
    } else if (data.warnings > 0) {
        el.textContent = `${data.warnings} warnings`;
        el.className = 'sf-meta has-warnings';
    } else {
        el.textContent = 'No issues';
        el.className = 'sf-meta';
    }
}

function updateTerminalList(terminals) {
    const list = terminals || [];
    window._ideTerminals = list;
}

function applySnapshot(data) {
    updateActiveFile(data.activeFile, data.languageId);
    if (data.line) {
        const el = document.getElementById('ide-cursor-pos');
        if (el) el.textContent = `Ln ${data.line}`;
    }
    if (data.diagnostics) updateDiagnostics(data.diagnostics);
    if (data.terminals) updateTerminalList(data.terminals);
    document.getElementById('status-dot')?.classList.add('connected');
    document.getElementById('status-label').textContent = 'Connected';
}

let toastTimeout = null;
function showToast(msg) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 2500);
}

const seenActivityIds = new Set();

function appendActivityEntry(entry, scroll = true) {
    if (seenActivityIds.has(entry.id)) return;
    seenActivityIds.add(entry.id);
    const container = document.getElementById('chat-container');
    const ph = container.querySelector('.empty-state') || container.querySelector('.placeholder');
    if (ph) ph.remove();

    const div = document.createElement('div');
    div.className = `activity-entry activity-${entry.type}`;
    const time = new Date(entry.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'});
    const iconName = ACTIVITY_ICON_MAP[entry.type] || 'file';
    div.innerHTML = `
        <span class="activity-time">${time}</span>
        <span class="activity-icon">${icon(iconName, 14)}</span>
        <span class="activity-text">${escapeHtml(entry.text)}</span>
    `;
    if (entry.detail) div.title = entry.detail;
    container.appendChild(div);
    while (container.children.length > 100) container.removeChild(container.firstChild);
    if (scroll) container.scrollTop = container.scrollHeight;
}

async function fetchIDEStatus() {
    try {
        const data = await api('/ide/status');
        if (data.success) applySnapshot(data);
    } catch { /* ignore */ }
    setInterval(async () => {
        try {
            const data = await api('/ide/status');
            if (data.success) applySnapshot(data);
        } catch { /* ignore */ }
    }, 5000);
}
