/**
 * @file src/storage/database.ts
 * @description SQLite database initialization and management
 * @context Управляет подключением к базе данных
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import config from '../config';
import { logger } from '../utils/logger';

let db: Database.Database | null = null;

/**
 * Инициализация базы данных
 */
export function initDatabase(): Database.Database {
  if (db) return db;

  // Создаём директорию если не существует
  const dataDir = config.dataPath;
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = config.databasePath;

  logger.info('Initializing database', { path: dbPath });

  db = new Database(dbPath);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');

  // Create tables
  createTables(db);

  logger.info('Database initialized successfully');

  return db;
}

/**
 * Создание таблиц
 */
function createTables(database: Database.Database): void {
  // Researches table
  database.exec(`
    CREATE TABLE IF NOT EXISTS researches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT,
      query TEXT NOT NULL,
      clarified_query TEXT,
      options TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      current_phase TEXT,
      result TEXT,
      usage TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_researches_user_id ON researches(user_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_researches_session_id ON researches(session_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_researches_created_at ON researches(created_at)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_researches_status ON researches(status)
  `);

  // Metrics table
  database.exec(`
    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      research_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (research_id) REFERENCES researches(id)
    )
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_metrics_research_id ON metrics(research_id)
  `);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_metrics_created_at ON metrics(created_at)
  `);

  // Golden Set table
  database.exec(`
    CREATE TABLE IF NOT EXISTS golden_set (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      expected_facts TEXT NOT NULL,
      forbidden_claims TEXT,
      min_quality_score REAL NOT NULL,
      domain TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Golden Set Results table
  database.exec(`
    CREATE TABLE IF NOT EXISTS golden_set_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      golden_set_id INTEGER NOT NULL,
      research_id TEXT NOT NULL,
      passed INTEGER NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (golden_set_id) REFERENCES golden_set(id),
      FOREIGN KEY (research_id) REFERENCES researches(id)
    )
  `);

  logger.info('Database tables created/verified');

  // Миграции: добавление новых колонок (idempotent)
  runMigrations(database);
}

/**
 * Выполняет миграции (добавление новых колонок)
 * Безопасно — если колонка уже существует, ошибка игнорируется
 */
function runMigrations(database: Database.Database): void {
  const migrations = [
    // v2.0.0: budget_metrics для хранения данных бюджета
    `ALTER TABLE researches ADD COLUMN budget_metrics TEXT`,
  ];

  for (const sql of migrations) {
    try {
      database.exec(sql);
    } catch (error) {
      // Колонка уже существует — это нормально
      const msg = error instanceof Error ? error.message : '';
      if (!msg.includes('duplicate column')) {
        logger.warn('Migration warning', { sql, error: msg });
      }
    }
  }
}

/**
 * Получение инстанса базы данных
 */
export function getDatabase(): Database.Database {
  if (!db) {
    return initDatabase();
  }
  return db;
}

/**
 * Закрытие базы данных
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}

/**
 * Очистка старых данных
 */
export function cleanupOldData(): void {
  const database = getDatabase();
  const retentionDays = config.retentionDays;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffIso = cutoffDate.toISOString();

  const metricsResult = database.prepare(`
    DELETE FROM metrics WHERE created_at < ?
  `).run(cutoffIso);

  const researchesResult = database.prepare(`
    DELETE FROM researches WHERE created_at < ?
  `).run(cutoffIso);

  logger.info('Old data cleaned up', {
    metrics_deleted: metricsResult.changes,
    researches_deleted: researchesResult.changes,
    cutoff_date: cutoffIso,
  });
}

export default {
  initDatabase,
  getDatabase,
  closeDatabase,
  cleanupOldData,
};
