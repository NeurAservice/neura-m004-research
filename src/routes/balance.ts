/**
 * @file src/routes/balance.ts
 * @description Balance API endpoint
 * @context Получение баланса пользователя из CORE
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getCoreService } from '../services/core';
import { ValidationError } from '../types/errors';

const router = Router();

/**
 * GET /api/balance
 * Получает баланс пользователя
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.query.user_id as string;

    if (!userId) {
      throw new ValidationError('user_id is required');
    }

    const coreService = getCoreService();
    const balanceData = await coreService.getBalance(userId, (req as any).id);

    res.json({
      status: 'success',
      data: {
        balance: balanceData.balance,
        currency: balanceData.currency || 'credits',
        topup_url: balanceData.topup_url || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

export { router as balanceRouter };
export default router;
