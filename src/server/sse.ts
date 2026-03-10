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
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        const id = String(++this.idCounter);
        this.clients.push({ id, res });

        // Send initial connection event
        res.write(`event: connected\ndata: ${JSON.stringify({ id })}\n\n`);

        // Heartbeat every 30s to keep connection alive
        const heartbeat = setInterval(() => {
            res.write(`:heartbeat\n\n`);
        }, 30000);

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
