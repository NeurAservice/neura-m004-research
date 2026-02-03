/**
 * @file src/utils/logger.ts
 * @description Winston logger с JSON-форматом
 * @context Используется всеми компонентами для структурированного логирования
 */

import winston from 'winston';
import path from 'path';
import fs from 'fs';
import config from '../config';

const { combine, timestamp, json, printf, colorize } = winston.format;

// Кастомный формат для dev-режима
const devFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
  const metaStr = Object.keys(meta).length > 0 ? JSON.stringify(meta) : '';
  return `${ts} [${level}]: ${message} ${metaStr}`;
});

// Создаём директории для логов
const logsPath = config.logsPath;
const appLogsPath = path.join(logsPath, 'app');
const errorLogsPath = path.join(logsPath, 'error');

[logsPath, appLogsPath, errorLogsPath].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Создаём транспорты
const transports: winston.transport[] = [];

// Console транспорт (всегда)
transports.push(
  new winston.transports.Console({
    format: config.isDev
      ? combine(colorize(), timestamp({ format: 'HH:mm:ss' }), devFormat)
      : combine(timestamp(), json()),
  })
);

// File транспорты
if (!config.isDev || process.env.LOG_TO_FILE === 'true') {
  const dateStr = new Date().toISOString().split('T')[0];

  // App logs
  transports.push(
    new winston.transports.File({
      filename: path.join(appLogsPath, `app-${dateStr}.log`),
      format: combine(timestamp(), json()),
      level: 'info',
    })
  );

  // Error logs
  transports.push(
    new winston.transports.File({
      filename: path.join(errorLogsPath, `error-${dateStr}.log`),
      format: combine(timestamp(), json()),
      level: 'error',
    })
  );
}

// Создаём логгер
export const logger = winston.createLogger({
  level: config.logLevel,
  defaultMeta: {
    module_id: config.moduleId,
    module_version: config.moduleVersion,
  },
  transports,
});

// Хелпер для логирования с request_id
export function createRequestLogger(requestId: string, researchId?: string) {
  return {
    info: (message: string, meta?: Record<string, unknown>) => {
      logger.info(message, { request_id: requestId, research_id: researchId, ...meta });
    },
    error: (message: string, meta?: Record<string, unknown>) => {
      logger.error(message, { request_id: requestId, research_id: researchId, ...meta });
    },
    warn: (message: string, meta?: Record<string, unknown>) => {
      logger.warn(message, { request_id: requestId, research_id: researchId, ...meta });
    },
    debug: (message: string, meta?: Record<string, unknown>) => {
      logger.debug(message, { request_id: requestId, research_id: researchId, ...meta });
    },
  };
}

// Логирование AI-вызовов
export function logAiCall(
  requestId: string,
  provider: string,
  model: string,
  action: string,
  details: Record<string, unknown>
) {
  logger.info(`AI call: ${provider}/${model} - ${action}`, {
    request_id: requestId,
    provider,
    model,
    action,
    ...details,
  });
}

export default logger;
