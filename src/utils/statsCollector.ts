/**
 * @file src/utils/statsCollector.ts
 * @description Автосбор статистики для калибровки порогов (грейды, QG threshold, бюджет)
 * @context Каждый завершённый research сохраняет метрики в JSONL-файл на volume.
 *          Fire-and-forget: ошибки сбора статистики НЕ влияют на pipeline.
 *          initStatsDir() вызывается при старте приложения для создания директории.
 * @dependencies config/index.ts, utils/logger.ts
 * @affects data/stats/ (volume)
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import config from '../config';
import { logger } from './logger';
import { ResearchMode } from '../types/research';

// ============================================
// Интерфейс статистики
// ============================================

export interface ResearchStats {
  timestamp: string;
  requestId: string;
  mode: ResearchMode;
  queryWordCount: number;
  preTriageFloor: ResearchMode;
  finalMode: ResearchMode;
  totalClaims: number;
  verifiedClaims: number;
  partiallyCorrectClaims: number;
  omittedClaims: number;
  numericalClaims: number;
  sourcesTotal: number;
  sourcesAvailable: number;
  compositeScore: number;
  grade: 'A' | 'B' | 'C' | 'F';
  qualityGatePassed: boolean | null;
  faithfulnessScore: number | null;
  totalCostUsd: number;
  durationMs: number;
  verificationLevel: 'full' | 'simplified' | 'skipped';
  goldenSet?: boolean; // true если запрос от golden set (requestId starts with gs-)
}

// ============================================
// Путь к директории статистики
// ============================================

const STATS_DIR = path.join(config.dataPath, 'stats');

/** Флаг успешной инициализации директории */
let statsDirReady = false;

// ============================================
// Инициализация
// ============================================

/**
 * Инициализирует директорию для статистики при запуске приложения.
 * Вызывать из index.ts при старте сервера.
 * @sideEffects Создаёт директорию data/stats/ на volume
 */
export async function initStatsDir(): Promise<void> {
  if (!config.statsCollectionEnabled) {
    logger.info('Stats collection is disabled via config');
    return;
  }

  try {
    await fs.mkdir(STATS_DIR, { recursive: true });
    statsDirReady = true;
    logger.info('Stats directory initialized', {
      stats_dir: STATS_DIR,
      data_path: config.dataPath,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    logger.error('Failed to initialize stats directory', {
      stats_dir: STATS_DIR,
      data_path: config.dataPath,
      error: err.message,
      code: err.code,
    });
  }
}

// ============================================
// Публичный API
// ============================================

/**
 * Сохраняет статистику завершённого research в JSONL-файл
 * @param stats - Метрики исследования
 * @sideEffects Пишет файл на диск (volume)
 */
export async function saveResearchStats(stats: ResearchStats): Promise<void> {
  if (!config.statsCollectionEnabled) return;

  try {
    // Если директория не была создана при старте — пробуем создать сейчас
    if (!statsDirReady) {
      await fs.mkdir(STATS_DIR, { recursive: true });
      statsDirReady = true;
    }

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filename = `stats-${date}.jsonl`;
    const filepath = path.join(STATS_DIR, filename);

    await fs.appendFile(filepath, JSON.stringify(stats) + '\n', 'utf-8');

    logger.debug('Research stats saved', {
      request_id: stats.requestId,
      grade: stats.grade,
      composite_score: stats.compositeScore,
      file: filename,
      filepath,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // Не падаем при ошибке сбора статистики, но логируем детально
    logger.error('Failed to save research stats', {
      request_id: stats.requestId,
      error: err.message,
      code: err.code,
      stats_dir: STATS_DIR,
      data_path: config.dataPath,
      stats_dir_ready: statsDirReady,
    });
    // Сброс флага, чтобы при следующей записи попробовать создать директорию заново
    statsDirReady = false;
  }
}
