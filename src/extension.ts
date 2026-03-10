import * as vscode from 'vscode';
import { RemoteServer } from './server/index';
import { TunnelManager } from './server/tunnel';
import { initIDEBridge } from './server/ide-bridge';
import { initChatReader, disposeChatReader } from './server/chat-reader';
import * as qrcode from 'qrcode';

let server: RemoteServer | null = null;
let tunnel: TunnelManager | null = null;
let statusBar: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
    const toggleCmd = vscode.commands.registerCommand(
        'remoteControl.toggle',
        async () => {
            if (server?.isRunning) {
                await stopRemoteControl();
            } else {
                await startRemoteControl(context);
            }
        }
    );

    const settingsCmd = vscode.commands.registerCommand(
        'remoteControl.showSettings',
        () => showSettingsPanel(context)
    );

    const qrCmd = vscode.commands.registerCommand(
        'remoteControl.showQR',
        () => showQRCode(context)
    );

    context.subscriptions.push(toggleCmd, settingsCmd, qrCmd);

    statusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right, 100
    );
    statusBar.command = 'remoteControl.toggle';
    statusBar.text = '$(remote) Remote: OFF';
    statusBar.show();
    context.subscriptions.push(statusBar);
}

async function startRemoteControl(context: vscode.ExtensionContext) {
    try {
        server = new RemoteServer(context);
        const port = await server.start();

        // Start broadcasting IDE events to connected clients
        initIDEBridge(context);

        // Start reading chat sessions for live chat display
        initChatReader(context);

        tunnel = new TunnelManager(context);
        const publicUrl = await tunnel.start(port);

        statusBar.text = '$(remote) Remote: ON';
        statusBar.tooltip = publicUrl;

        showQRCode(context);
        vscode.window.showInformationMessage(`Remote Control active at ${publicUrl}`);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Remote Control failed: ${err.message}`);
        await stopRemoteControl();
    }
}

async function stopRemoteControl() {
    disposeChatReader();
    await tunnel?.stop();
    await server?.stop();
    server = null;
    tunnel = null;
    statusBar.text = '$(remote) Remote: OFF';
    statusBar.tooltip = undefined;
}

function showQRCode(context: vscode.ExtensionContext) {
    const url = tunnel?.getUrl();
    if (!url) {
        vscode.window.showWarningMessage('Remote Control is not running. Start it first.');
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'remoteControlQR',
        'Remote Control QR Code',
        vscode.ViewColumn.One,
        {}
    );

    const token = server?.getToken() || '';
    const fullUrl = `${url}/dashboard?token=${token}`;

    qrcode.toDataURL(fullUrl, { width: 300, margin: 2 }, (err, dataUrl) => {
        if (err) {
            panel.webview.html = `<h2>Error generating QR code</h2>`;
            return;
        }
        panel.webview.html = `<!DOCTYPE html>
<html>
<head><style>
    body { display:flex; flex-direction:column; align-items:center; justify-content:center;
           min-height:100vh; margin:0; font-family:system-ui; background:#1e1e1e; color:#ccc; }
    img { border-radius:12px; margin:20px 0; }
    a { color:#4fc3f7; word-break:break-all; }
    .url-box { background:#2d2d2d; padding:12px 20px; border-radius:8px; margin:12px; max-width:90%; text-align:center; }
</style></head>
<body>
    <h2>📱 Scan to Connect</h2>
    <img src="${dataUrl}" alt="QR Code" />
    <div class="url-box"><a href="${fullUrl}">${fullUrl}</a></div>
    <p style="opacity:0.6">Open this URL on your phone</p>
</body>
</html>`;
    });
}

function showSettingsPanel(context: vscode.ExtensionContext) {
    const panel = vscode.window.createWebviewPanel(
        'remoteControlSettings',
        'Remote Control Settings',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    const config = vscode.workspace.getConfiguration('remoteControl');
    const pin = config.get<string>('pin', '');
    const tunnelMode = config.get<string>('tunnelMode', 'quick');
    const tunnelToken = config.get<string>('tunnelToken', '');

    panel.webview.html = `<!DOCTYPE html>
<html>
<head><style>
    body { font-family:system-ui; padding:24px; background:#1e1e1e; color:#ccc; }
    label { display:block; margin:16px 0 6px; font-weight:600; }
    input, select { width:100%; padding:8px 12px; border:1px solid #555; border-radius:6px;
                    background:#2d2d2d; color:#ccc; font-size:14px; box-sizing:border-box; }
    button { margin-top:20px; padding:10px 24px; background:#0078d4; color:#fff; border:none;
             border-radius:6px; font-size:14px; cursor:pointer; }
    button:hover { background:#106ebe; }
</style></head>
<body>
    <h2>⚙️ Remote Control Settings</h2>
    <label for="pin">PIN Code (4+ digits, optional)</label>
    <input id="pin" type="password" value="${pin}" placeholder="Leave empty to disable" />
    <label for="mode">Tunnel Mode</label>
    <select id="mode">
        <option value="quick" ${tunnelMode === 'quick' ? 'selected' : ''}>Quick (no account)</option>
        <option value="named" ${tunnelMode === 'named' ? 'selected' : ''}>Named (requires token)</option>
    </select>
    <label for="token">Tunnel Token</label>
    <input id="token" type="password" value="${tunnelToken}" placeholder="Required for named mode" />
    <button onclick="save()">Save Settings</button>
    <script>
        const vscode = acquireVsCodeApi();
        function save() {
            vscode.postMessage({
                command: 'save',
                pin: document.getElementById('pin').value,
                tunnelMode: document.getElementById('mode').value,
                tunnelToken: document.getElementById('token').value,
            });
        }
    </script>
</body>
</html>`;

    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'save') {
            const config = vscode.workspace.getConfiguration('remoteControl');
            await config.update('pin', msg.pin, vscode.ConfigurationTarget.Global);
            await config.update('tunnelMode', msg.tunnelMode, vscode.ConfigurationTarget.Global);
            await config.update('tunnelToken', msg.tunnelToken, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('Settings saved. Restart Remote Control to apply.');
        }
    });
}

export function deactivate() {
    stopRemoteControl();
}
