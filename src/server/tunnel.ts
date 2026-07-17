import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';

export class TunnelManager {
    private process: cp.ChildProcess | null = null;
    private publicUrl: string = '';
    private outputChannel: vscode.OutputChannel;

    constructor(private context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel("Remote Control (Tunnel)");
    }

    async start(port: number): Promise<string> {
        try {
            fs.writeFileSync('i:\\remote-ide-extension\\cloudflared_run_debug.log', '');
        } catch {}
        this.outputChannel.show(true);
        this.outputChannel.appendLine("[Tunnel] Starting cloudflared tunnel...");
        const binaryPath = await this.ensureBinary();

        const config = vscode.workspace.getConfiguration('remoteControl');
        const mode = config.get<string>('tunnelMode', 'quick');

        return new Promise((resolve, reject) => {
            const args = mode === 'quick'
                ? ['tunnel', '--url', `http://localhost:${port}`]
                : ['tunnel', 'run', '--token', config.get('tunnelToken', '')];

            this.outputChannel.appendLine(`[Tunnel] Executing: ${binaryPath} ${args.join(' ')}`);
            this.process = cp.spawn(binaryPath, args, { windowsHide: true });

            let outputBuffer = '';

            const onData = (data: Buffer) => {
                const str = data.toString();
                this.outputChannel.append(str);
                try {
                    fs.appendFileSync('i:\\remote-ide-extension\\cloudflared_run_debug.log', str);
                } catch {}
                
                outputBuffer += str.replace(/\x1b\[[0-9;]*m/g, '');
                
                if (mode === 'quick') {
                    const cleanedBuffer = outputBuffer.replace(/[\r\n\s|]+/g, '');
                    const match = cleanedBuffer.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
                    if (match && !this.publicUrl) {
                        this.publicUrl = match[0];
                        this.outputChannel.appendLine(`\n[Tunnel] URL detected: ${this.publicUrl}\n`);
                        resolve(this.publicUrl);
                    }
                } else {
                    const hasRegistered = outputBuffer.includes('Registered tunnel connection') || 
                                          (outputBuffer.includes('Connection') && outputBuffer.includes('established'));
                    if (hasRegistered && !this.publicUrl) {
                        const customDomain = config.get<string>('customDomain', '').trim();
                        this.publicUrl = customDomain || 'https://your-custom-domain.com';
                        this.outputChannel.appendLine(`\n[Tunnel] Named tunnel connected. Using domain: ${this.publicUrl}\n`);
                        resolve(this.publicUrl);
                    }
                }
            };

            this.process.stdout?.on('data', onData);
            this.process.stderr?.on('data', onData);

            let settled = false;
            const finish = (cb: () => void) => {
                if (!settled) { settled = true; cb(); }
            };

            this.process.on('error', (err) => {
                finish(() => {
                    this.outputChannel.appendLine(`[Tunnel] Spawn error: ${err.message}`);
                    reject(err);
                });
            });

            this.process.on('exit', (code) => {
                finish(() => {
                    this.outputChannel.appendLine(`[Tunnel] Process exited with code ${code} before URL was detected`);
                    reject(new Error(`cloudflared exited with code ${code}. Check the "Remote Control (Tunnel)" output panel for details.`));
                });
            });

            const timeout = setTimeout(() => {
                finish(() => {
                    this.outputChannel.appendLine(`\n[Tunnel] Timed out after 45s.\nBuffer:\n${outputBuffer}`);
                    reject(new Error('Tunnel timeout — cloudflared did not return a URL within 45s. Check the "Remote Control (Tunnel)" output panel for details.'));
                });
            }, 45000);
        });
    }

    async stop() {
        if (this.process) {
            if (process.platform === 'win32') {
                try {
                    if (this.process.pid) {
                        cp.execSync(`taskkill /pid ${this.process.pid} /T /F`, { stdio: 'ignore' });
                    }
                } catch {
                    // Process may already be gone; ignore shutdown race on Windows.
                }
            } else {
                this.process.kill('SIGTERM');
            }
            this.process = null;
            this.publicUrl = '';
        }
    }

    private async ensureBinary(): Promise<string> {
        const binDir = path.join(this.context.globalStorageUri.fsPath, 'bin');
        const binName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
        const binPath = path.join(binDir, binName);

        if (fs.existsSync(binPath)) { return binPath; }

        fs.mkdirSync(binDir, { recursive: true });
        const downloadUrl = this.getDownloadUrl();
        const isTgz = downloadUrl.endsWith('.tgz');
        const downloadDest = isTgz ? binPath + '.tgz' : binPath;

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Downloading cloudflared...' },
            () => this.downloadFile(downloadUrl, downloadDest)
        );

        if (isTgz) {
            // Extract the binary from the .tgz archive, then remove the archive
            await new Promise<void>((resolve, reject) => {
                cp.execFile('tar', ['-xzf', downloadDest, '-C', binDir], (err) => {
                    try { fs.unlinkSync(downloadDest); } catch { /* ignore */ }
                    if (err) { reject(err); } else { resolve(); }
                });
            });
            // cloudflared tarballs contain a single binary; rename if needed
            const extracted = fs.readdirSync(binDir)
                .find(f => f.startsWith('cloudflared') && !f.endsWith('.tgz'));
            if (extracted && extracted !== binName) {
                fs.renameSync(path.join(binDir, extracted), binPath);
            }
        }

        if (process.platform !== 'win32') {
            fs.chmodSync(binPath, '755');
        }

        return binPath;
    }

    private getDownloadUrl(): string {
        const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
        if (process.platform === 'win32') {
            return `${base}/cloudflared-windows-amd64.exe`;
        }
        if (process.platform === 'darwin') {
            return process.arch === 'arm64'
                ? `${base}/cloudflared-darwin-arm64.tgz`
                : `${base}/cloudflared-darwin-amd64.tgz`;
        }
        return process.arch === 'arm64'
            ? `${base}/cloudflared-linux-arm64`
            : `${base}/cloudflared-linux-amd64`;
    }

    private downloadFile(url: string, dest: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(dest);
            const request = (targetUrl: string) => {
                https.get(targetUrl, (response) => {
                    // Follow redirects
                    if (response.statusCode === 302 || response.statusCode === 301) {
                        const location = response.headers.location;
                        if (location) {
                            request(location);
                            return;
                        }
                    }
                    response.pipe(file);
                    file.on('finish', () => { file.close(); resolve(); });
                }).on('error', (err) => {
                    // Close the stream before attempting to delete the file;
                    // on Windows an open handle prevents unlinkSync (EBUSY).
                    file.destroy();
                    try { fs.unlinkSync(dest); } catch { /* ignore if file doesn't exist */ }
                    reject(err);
                });
            };
            request(url);
        });
    }

    getUrl() { return this.publicUrl; }
}
