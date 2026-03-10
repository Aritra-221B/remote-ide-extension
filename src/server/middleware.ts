import { Request, Response, NextFunction } from 'express';
import * as vscode from 'vscode';

export function authMiddleware(sessionToken: string) {
    return (req: Request, res: Response, next: NextFunction) => {
        const token = req.headers['x-session-token'] as string
            || req.query.token as string;

        if (token !== sessionToken) {
            res.status(401).json({ error: 'Invalid session token' });
            return;
        }

        const config = vscode.workspace.getConfiguration('remoteControl');
        const pin = config.get<string>('pin', '');

        if (pin && pin.length >= 4) {
            const providedPin = req.headers['x-pin'] as string
                || req.query.pin as string;
            if (providedPin !== pin) {
                res.status(401).json({ error: 'Invalid PIN' });
                return;
            }
        }

        next();
    };
}
