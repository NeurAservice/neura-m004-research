/**
 * @file src/middleware/errorHandler.ts
 * @description Централизованная обработка ошибок
 * @context Используется как последний middleware в Express
 */

import { Request, Response, NextFunction } from 'express';
import { AppError } from '../types/errors';
import { logger } from '../utils/logger';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = (req as any).id || 'unknown';

  // Логируем ошибку
  logger.error('Request error', {
    request_id: requestId,
    path: req.path,
    method: req.method,
    error: err.message,
    stack: err.stack,
  });

  // Определяем статус и сообщение
  let statusCode = 500;
  let errorCode = 'INTERNAL_ERROR';
  let message = 'Internal server error';

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    errorCode = err.errorCode;
    message = err.message;
  } else if (err.name === 'ValidationError') {
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    message = err.message;
  } else if (err.name === 'SyntaxError') {
    statusCode = 400;
    errorCode = 'INVALID_JSON';
    message = 'Invalid JSON in request body';
  }

  res.status(statusCode).json({
    status: 'error',
    error_code: errorCode,
    message,
    request_id: requestId,
  });
}

export default errorHandler;
