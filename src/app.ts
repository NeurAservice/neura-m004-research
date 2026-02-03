/**
 * @file src/app.ts
 * @description Express приложение
 * @context Конфигурация Express, middleware, routes
 */

import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { healthRouter, balanceRouter, identityRouter, researchRouter, internalRouter } from './routes';
import { errorHandler, requestLogger } from './middleware';
import config from './config';

export function createApp(): Express {
  const app = express();

  // Trust proxy для корректной работы за nginx
  app.set('trust proxy', 1);

  // CORS
  app.use(cors({
    origin: config.cors.origins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Internal-Api-Key'],
    credentials: true,
  }));

  // Body parsing
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Request logging
  app.use(requestLogger);

  // Static files
  app.use(express.static(path.join(__dirname, '../public')));

  // API routes
  app.use('/health', healthRouter);
  app.use('/api/health', healthRouter);
  app.use('/api/balance', balanceRouter);
  app.use('/api/identity', identityRouter);
  app.use('/api/research', researchRouter);
  app.use('/api/internal', internalRouter);

  // Root redirect
  app.get('/', (req: Request, res: Response) => {
    res.redirect('/index.html');
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      status: 'error',
      error_code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    });
  });

  // Error handler
  app.use(errorHandler);

  return app;
}

export default createApp;
