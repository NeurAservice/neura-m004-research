/**
 * @file src/routes/identity.ts
 * @description Identity resolution API endpoint
 * @context Резолв внешнего user_id через CORE /identity/resolve
 * @dependencies services/core.ts
 */

import { Router, Request, Response, NextFunction } from 'express';
import { getCoreService } from '../services/core';
import { ValidationError } from '../types/errors';

const router = Router();

/**
 * POST /api/identity/init
 * Инициализация пользователя (identity/resolve)
 * Преобразует внешний ID из оболочки во внутренний user_id
 */
router.post('/init', async (req: Request, res: Response, next: NextFunction) => {
  const requestId = (req as any).id || 'unknown';

  try {
    const { provider, tenant, external_user_id } = req.body;

    if (!provider) {
      throw new ValidationError('provider is required');
    }

    if (!tenant) {
      throw new ValidationError('tenant is required');
    }

    if (!external_user_id) {
      throw new ValidationError('external_user_id is required');
    }

    const coreService = getCoreService();
    const result = await coreService.resolveIdentity(provider, tenant, external_user_id, requestId);

    res.json({
      success: true,
      user_id: result.user_id,
      is_new: result.is_new,
      request_id: requestId,
    });
  } catch (error) {
    next(error);
  }
});

export { router as identityRouter };
export default router;
