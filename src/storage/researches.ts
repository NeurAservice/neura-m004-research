/**
 * @file src/storage/researches.ts
 * @description Repository для работы с исследованиями
 * @context Хранение и получение данных исследований
 */

import { getDatabase } from './database';
import { logger } from '../utils/logger';
import { ResearchResult, ResearchOptions, ResearchOutput, UsageData, ResearchStatus } from '../types/research';

interface ResearchRow {
  id: string;
  user_id: string;
  session_id: string | null;
  query: string;
  clarified_query: string | null;
  options: string;
  status: string;
  progress: number;
  current_phase: string | null;
  result: string | null;
  usage: string | null;
  error: string | null;
  budget_metrics: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/**
 * Создаёт новое исследование
 */
export function createResearch(research: ResearchResult): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO researches (
      id, user_id, session_id, query, clarified_query, options, status,
      progress, current_phase, result, usage, error, budget_metrics, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    research.id,
    research.user_id,
    research.session_id || null,
    research.query,
    research.clarifiedQuery || null,
    JSON.stringify(research.options),
    research.status,
    research.progress,
    research.currentPhase || null,
    research.output ? JSON.stringify(research.output) : null,
    research.usage ? JSON.stringify(research.usage) : null,
    research.error || null,
    research.output?.budgetMetrics ? JSON.stringify(research.output.budgetMetrics) : null,
    research.createdAt || now,
    research.updatedAt || now,
    research.completedAt || null
  );

  logger.debug('Research created', { id: research.id, status: research.status });
}

/**
 * Обновляет исследование
 */
export function updateResearch(
  id: string,
  updates: Partial<{
    status: ResearchStatus;
    progress: number;
    currentPhase: string;
    output: ResearchOutput;
    usage: UsageData;
    error: string;
    clarifiedQuery: string;
    completedAt: string;
  }>
): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  const fields: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [now];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.progress !== undefined) {
    fields.push('progress = ?');
    values.push(updates.progress);
  }
  if (updates.currentPhase !== undefined) {
    fields.push('current_phase = ?');
    values.push(updates.currentPhase);
  }
  if (updates.output !== undefined) {
    fields.push('result = ?');
    values.push(JSON.stringify(updates.output));
  }
  if (updates.usage !== undefined) {
    fields.push('usage = ?');
    values.push(JSON.stringify(updates.usage));
  }
  if (updates.error !== undefined) {
    fields.push('error = ?');
    values.push(updates.error);
  }
  if (updates.clarifiedQuery !== undefined) {
    fields.push('clarified_query = ?');
    values.push(updates.clarifiedQuery);
  }
  if (updates.completedAt !== undefined) {
    fields.push('completed_at = ?');
    values.push(updates.completedAt);
  }

  values.push(id);

  const stmt = db.prepare(`
    UPDATE researches SET ${fields.join(', ')} WHERE id = ?
  `);

  stmt.run(...values);

  logger.debug('Research updated', { id, updates: Object.keys(updates) });
}

/**
 * Получает исследование по ID
 */
export function getResearchById(id: string): ResearchResult | null {
  const db = getDatabase();

  const row = db.prepare(`
    SELECT * FROM researches WHERE id = ?
  `).get(id) as ResearchRow | undefined;

  if (!row) return null;

  return rowToResearch(row);
}

/**
 * Получает историю исследований пользователя
 */
export function getResearchHistory(
  userId: string,
  limit: number = 20,
  offset: number = 0
): { items: ResearchResult[]; total: number } {
  const db = getDatabase();

  const countRow = db.prepare(`
    SELECT COUNT(*) as count FROM researches WHERE user_id = ?
  `).get(userId) as { count: number };

  const rows = db.prepare(`
    SELECT * FROM researches
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset) as ResearchRow[];

  return {
    items: rows.map(rowToResearch),
    total: countRow.count,
  };
}

/**
 * Получает активные исследования пользователя
 */
export function getActiveResearches(userId: string): ResearchResult[] {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT * FROM researches
    WHERE user_id = ? AND status IN ('pending', 'in_progress', 'clarification_needed')
    ORDER BY created_at DESC
  `).all(userId) as ResearchRow[];

  return rows.map(rowToResearch);
}

/**
 * Конвертирует строку БД в ResearchResult
 */
function rowToResearch(row: ResearchRow): ResearchResult {
  return {
    id: row.id,
    user_id: row.user_id,
    session_id: row.session_id || undefined,
    query: row.query,
    clarifiedQuery: row.clarified_query || undefined,
    options: JSON.parse(row.options) as ResearchOptions,
    status: row.status as ResearchStatus,
    progress: row.progress,
    currentPhase: row.current_phase || undefined,
    output: row.result ? JSON.parse(row.result) as ResearchOutput : undefined,
    usage: row.usage ? JSON.parse(row.usage) as UsageData : undefined,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || undefined,
  };
}

export default {
  createResearch,
  updateResearch,
  getResearchById,
  getResearchHistory,
  getActiveResearches,
};
