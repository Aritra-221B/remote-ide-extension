import { Router } from 'express';

export function authRoutes(sessionToken: string) {
    const router = Router();

    router.post('/login', (req, res) => {
        const { token, pin } = req.body;
        if (token !== sessionToken) {
            res.status(401).json({ success: false, error: 'Invalid token' });
            return;
        }
        // PIN check is optional — handled by middleware on subsequent requests
        res.json({ success: true, message: 'Authenticated' });
    });

    router.get('/check', (req, res) => {
        const token = req.query.token as string;
        if (token === sessionToken) {
            res.json({ success: true, authenticated: true });
        } else {
            res.status(401).json({ success: false, authenticated: false });
        }
    });

    return router;
}
