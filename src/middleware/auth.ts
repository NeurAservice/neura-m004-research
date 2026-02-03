/**
 * @file src/middleware/auth.ts
 * @description Аутентификация для Internal API
 * @context Проверяет API ключ для запросов от других модулей
 */

import { Request, Response, NextFunction } from 'express';
import config from '../config';
import { UnauthorizedError } from '../types/errors';
import { logger } from '../utils/logger';

/**
 * Middleware для проверки Internal API Key
 */
export function requireInternalAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-module-api-key'] as string;

  if (!apiKey) {
    logger.warn('Internal API request without API key', {
      request_id: (req as any).id,
      path: req.path,
    });
    return next(new UnauthorizedError('Missing X-Module-Api-Key header'));
  }

  if (apiKey !== config.internalApiKey) {
    logger.warn('Internal API request with invalid API key', {
      request_id: (req as any).id,
      path: req.path,
    });
    return next(new UnauthorizedError('Invalid API key'));
  }

  next();
}

export default { requireInternalAuth };
