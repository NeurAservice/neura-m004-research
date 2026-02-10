/**
 * @file src/index.ts
 * @description Точка входа приложения
 * @context Запуск сервера, инициализация БД
 */

import { createApp } from './app';
import { initDatabase, cleanupOldData } from './storage/database';
import { initStatsDir } from './utils/statsCollector';
import config from './config';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  logger.info('Starting NeurA Research module', {
    module_id: config.moduleId,
    version: config.moduleVersion,
    environment: config.nodeEnv,
  });

  // Инициализация базы данных
  try {
    initDatabase();
    logger.info('Database initialized');
  } catch (error) {
    logger.error('Failed to initialize database', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    process.exit(1);
  }

  // Инициализация директории для статистики (fire-and-forget)
  try {
    await initStatsDir();
  } catch (error) {
    logger.warn('Stats directory initialization failed, will retry on first write', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  // Запуск очистки старых данных (раз в час)
  setInterval(() => {
    try {
      cleanupOldData();
    } catch (error) {
      logger.warn('Failed to cleanup old data', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, 60 * 60 * 1000); // 1 hour

  // Создание и запуск приложения
  const app = createApp();

  const server = app.listen(config.port, () => {
    logger.info(`Server started on port ${config.port}`, {
      port: config.port,
      module_id: config.moduleId,
      environment: config.nodeEnv,
    });
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Unhandled rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  // Uncaught exceptions
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  });
}

main().catch((error) => {
  logger.error('Failed to start server', {
    error: error instanceof Error ? error.message : 'Unknown error',
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
