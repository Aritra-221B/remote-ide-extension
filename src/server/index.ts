import express from 'express';
import * as path from 'path';
import * as http from 'http';
import { v4 as uuidv4 } from 'uuid';
import * as vscode from 'vscode';
import { authMiddleware } from './middleware';
import { chatRoutes, stopChatPolling } from './routes/chat';
import { terminalRoutes } from './routes/terminal';
import { fileRoutes } from './routes/files';
import { gitRoutes } from './routes/git';
import { screenshotRoutes } from './routes/screenshot';
import { promptRoutes } from './routes/prompt';
import { authRoutes } from './routes/auth';
import { usageRoutes } from './routes/usage';
import { bugfixRoutes } from './routes/bugfix';
import { ideRoutes } from './routes/ide';
import { sseManager } from './sse';

export class RemoteServer {
    private app: express.Application;
    private httpServer: http.Server | null = null;
    private sessionToken: string;
    public isRunning = false;

    constructor(private context: vscode.ExtensionContext) {
        this.sessionToken = uuidv4();
        this.app = express();

        // Serve dashboard static files
        this.app.use('/dashboard', express.static(
            path.join(context.extensionPath, 'src', 'dashboard')
        ));

        this.app.use(express.json({ limit: '50mb' }));

        // Public auth route
        this.app.use('/api/auth', authRoutes(this.sessionToken));

        // SSE endpoint (needs auth via query param)
        this.app.get('/api/events', (req, res, next) => {
            const token = req.query.token as string;
            if (token !== this.sessionToken) {
                return res.status(401).json({ error: 'Invalid session token' });
            }
            next();
        }, (req, res) => {
            sseManager.addClient(req, res);
        });

        // Protected API routes
        this.app.use('/api', authMiddleware(this.sessionToken));
        this.app.use('/api/chat', chatRoutes(context));
        this.app.use('/api/terminal', terminalRoutes());
        this.app.use('/api/files', fileRoutes());
        this.app.use('/api/git', gitRoutes());
        this.app.use('/api/screenshot', screenshotRoutes());
        this.app.use('/api/prompt', promptRoutes());
        this.app.use('/api/usage', usageRoutes());
        this.app.use('/api/bugs', bugfixRoutes());
        this.app.use('/api/ide', ideRoutes());

        // Root redirect to dashboard
        this.app.get('/', (req, res) => {
            res.redirect(`/dashboard?token=${this.sessionToken}`);
        });
    }

    async start(): Promise<number> {
        return new Promise((resolve) => {
            this.httpServer = this.app.listen(0, () => {
                const addr = this.httpServer!.address() as { port: number };
                this.isRunning = true;
                resolve(addr.port);
            });
        });
    }

    async stop() {
        stopChatPolling();
        sseManager.closeAll();
        this.httpServer?.close();
        this.isRunning = false;
    }

    getToken() { return this.sessionToken; }
}
