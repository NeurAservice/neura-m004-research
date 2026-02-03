/**
 * @file src/middleware/requestLogger.ts
 * @description Логирование входящих запросов с request_id
 * @context Добавляет request_id к каждому запросу
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  const startTime = Date.now();

  // Добавляем request_id к запросу
  (req as any).id = requestId;

  // Логируем входящий запрос
  logger.info('Incoming request', {
    request_id: requestId,
    method: req.method,
    path: req.path,
    query: req.query,
    user_agent: req.headers['user-agent'],
  });

  // Логируем ответ
  res.on('finish', () => {
    const duration = Date.now() - startTime;

    logger.info('Request completed', {
      request_id: requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration,
    });
  });

  next();
}

export default requestLogger;
