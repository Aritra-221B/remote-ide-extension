import { Router } from 'express';
import { getIDESnapshot } from '../ide-bridge';

export function ideRoutes() {
    const router = Router();

    router.get('/status', (req, res) => {
        res.json({ success: true, ...getIDESnapshot() });
    });

    return router;
}
