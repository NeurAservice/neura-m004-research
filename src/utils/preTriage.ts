/**
 * @file src/utils/preTriage.ts
 * @description Pre-Triage — детерминистические эвристики до вызова LLM triage
 * @context Определяет минимальный (floor) режим на основе характеристик запроса.
 *          LLM-triage может повысить режим, но не понизить ниже floor.
 * @dependencies config/index.ts
 * @affects Выбор режима pipeline (simple → standard → deep)
 */

import config from '../config';
import { logger } from './logger';

type ResearchMode = 'simple' | 'standard' | 'deep';

export interface PreTriageResult {
  floor: ResearchMode;
  reasons: string[];
}

/**
 * Выполняет pre-triage эвристики для определения минимального режима
 * @param query - Исследовательский запрос пользователя
 * @returns Результат с floor-режимом и причинами повышения
 */
export function preTriage(query: string): PreTriageResult {
  let floor: ResearchMode = 'simple';
  const reasons: string[] = [];

  // 1. Длина запроса (по словам)
  const wordCount = query.split(/\s+/).filter(Boolean).length;
  if (wordCount > config.preTriageWordCountDeep) {
    floor = elevate(floor, 'deep');
    reasons.push(`query_length: ${wordCount} words > ${config.preTriageWordCountDeep}`);
  } else if (wordCount > config.preTriageWordCountStandard) {
    floor = elevate(floor, 'standard');
    reasons.push(`query_length: ${wordCount} words > ${config.preTriageWordCountStandard}`);
  }

  // 2. Вопросительные знаки (несколько вопросов в одном запросе)
  const questionMarks = (query.match(/\?/g) || []).length;
  if (questionMarks >= config.preTriageQuestionCountDeep) {
    floor = elevate(floor, 'deep');
    reasons.push(`many_questions: ${questionMarks} >= ${config.preTriageQuestionCountDeep}`);
  } else if (questionMarks >= config.preTriageQuestionCountStandard) {
    floor = elevate(floor, 'standard');
    reasons.push(`multiple_questions: ${questionMarks} >= ${config.preTriageQuestionCountStandard}`);
  }

  // 3. Структурные блоки (нумерованные списки, markdown-структура)
  const numberedItems = (query.match(/^\s*\d+[\.\)]/gm) || []).length;
  const bulletItems = (query.match(/^\s*[-*•]/gm) || []).length;
  const structuralBlocks = numberedItems + bulletItems;
  if (structuralBlocks >= 3) {
    floor = elevate(floor, 'standard');
    reasons.push(`structural_blocks: ${structuralBlocks}`);
  }

  // 4. Домены-индикаторы сложности
  const queryLower = query.toLowerCase();

  const deepDomainKeywords = [
    // Научные
    'systematic review', 'peer-reviewed', 'meta-analysis', 'randomized',
    'систематический обзор', 'мета-анализ', 'рандомизированное',
    // Правовые
    'legal precedent', 'court ruling', 'legislation analysis',
    'судебная практика', 'правовой анализ', 'нормативный акт',
    // Сравнительный анализ
    'compare and contrast', 'comprehensive comparison',
    'сравнительный анализ', 'всесторонний анализ',
  ];

  const standardDomainKeywords = [
    'how does', 'what are the advantages', 'explain the difference',
    'как работает', 'какие преимущества', 'объясни разницу',
    'pros and cons', 'плюсы и минусы',
  ];

  if (deepDomainKeywords.some(kw => queryLower.includes(kw))) {
    floor = elevate(floor, 'deep');
    reasons.push('deep_domain_keyword_detected');
  } else if (standardDomainKeywords.some(kw => queryLower.includes(kw))) {
    floor = elevate(floor, 'standard');
    reasons.push('standard_domain_keyword_detected');
  }

  // 5. Явное указание глубины пользователем
  const deepExplicitKeywords = ['deep', 'подробно', 'детально', 'глубоко', 'всесторонне', 'comprehensive'];
  if (deepExplicitKeywords.some(kw => queryLower.includes(kw))) {
    floor = elevate(floor, 'standard');
    reasons.push('explicit_depth_request');
  }

  return { floor, reasons };
}

/**
 * Повышает режим до кандидата, если кандидат выше текущего
 * @param current - Текущий режим
 * @param candidate - Предлагаемый режим
 * @returns Более высокий из двух
 */
export function elevate(current: ResearchMode, candidate: ResearchMode): ResearchMode {
  const priority: Record<ResearchMode, number> = {
    simple: 0,
    standard: 1,
    deep: 2,
  };
  return priority[candidate] > priority[current] ? candidate : current;
}
