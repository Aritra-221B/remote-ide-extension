import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';

export class TunnelManager {
    private process: cp.ChildProcess | null = null;
    private publicUrl: string = '';

    constructor(private context: vscode.ExtensionContext) {}

    async start(port: number): Promise<string> {
        const binaryPath = await this.ensureBinary();

        const config = vscode.workspace.getConfiguration('remoteControl');
        const mode = config.get<string>('tunnelMode', 'quick');

        return new Promise((resolve, reject) => {
            const args = mode === 'quick'
                ? ['tunnel', '--url', `http://localhost:${port}`]
                : ['tunnel', 'run', '--token', config.get('tunnelToken', '')];

            this.process = cp.spawn(binaryPath, args);

            this.process.stderr?.on('data', (data: Buffer) => {
                const output = data.toString();
                const match = output.match(/https:\/\/[^\s]+\.trycloudflare\.com/);
                if (match && !this.publicUrl) {
                    this.publicUrl = match[0];
                    resolve(this.publicUrl);
                }
            });

            this.process.on('error', reject);

            setTimeout(() => {
                if (!this.publicUrl) {
                    reject(new Error('Tunnel timeout — cloudflared did not return a URL within 30s'));
                }
            }, 30000);
        });
    }

    async stop() {
        if (this.process) {
            if (process.platform === 'win32') {
                cp.execSync(`taskkill /pid ${this.process.pid} /T /F`, { stdio: 'ignore' });
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
