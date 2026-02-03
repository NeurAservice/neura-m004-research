/**
 * @file src/routes/health.ts
 * @description Health check endpoint
 * @context Используется для мониторинга состояния модуля
 */

import { Router, Request, Response } from 'express';
import config from '../config';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    module: {
      id: config.moduleId,
      name: config.moduleName,
      version: config.moduleVersion,
    },
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

export { router as healthRouter };
export default router;
