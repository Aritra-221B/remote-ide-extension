import { Request, Response } from 'express';

interface SSEClient {
    id: string;
    res: Response;
}

class SSEManager {
    private clients: SSEClient[] = [];
    private idCounter = 0;

    addClient(req: Request, res: Response) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            // no-transform: tell Cloudflare/proxies not to compress or buffer
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders?.();

        const id = String(++this.idCounter);
        this.clients.push({ id, res });

        // 2KB comment padding: forces buffering proxies (Cloudflare tunnel)
        // to flush the stream so the client sees events immediately
        res.write(`:${' '.repeat(2048)}\n\n`);

        // Send initial connection event
        res.write(`event: connected\ndata: ${JSON.stringify({ id })}\n\n`);

        // Heartbeat every 15s to keep the tunnel connection alive
        const heartbeat = setInterval(() => {
            res.write(`:heartbeat\n\n`);
        }, 15000);

        req.on('close', () => {
            clearInterval(heartbeat);
            this.clients = this.clients.filter(c => c.id !== id);
        });
    }

    broadcast(event: string, data: any) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const client of this.clients) {
            client.res.write(payload);
        }
    }

    closeAll() {
        for (const client of this.clients) {
            client.res.end();
        }
        this.clients = [];
    }

    get clientCount() {
        return this.clients.length;
    }
}

export const sseManager = new SSEManager();
