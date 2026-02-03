/**
 * @file src/utils/helpers.ts
 * @description Вспомогательные функции
 * @context Общие утилиты для модуля
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Генерация UUID
 */
export function generateUUID(): string {
  return uuidv4();
}

/**
 * Задержка выполнения
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry с экспоненциальным backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelay?: number;
    maxDelay?: number;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelay = 1000,
    maxDelay = 30000,
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      await delay(delayMs);
    }
  }

  throw lastError;
}

/**
 * Безопасный JSON parse
 */
export function safeJsonParse<T>(str: string, fallback: T): T {
  try {
    return JSON.parse(str) as T;
  } catch {
    return fallback;
  }
}

/**
 * Извлечение JSON из текста (если AI вернул markdown)
 */
export function extractJsonFromText(text: string): string {
  // Ищем JSON в markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Ищем JSON объект или массив напрямую
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    return jsonMatch[1].trim();
  }

  return text.trim();
}

/**
 * Truncate текст до указанной длины
 */
export function truncate(text: string, maxLength: number, suffix: string = '...'): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - suffix.length) + suffix;
}

/**
 * Форматирование даты в ISO
 */
export function formatISODate(date: Date = new Date()): string {
  return date.toISOString();
}

/**
 * Получение домена из URL
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Проверка, содержит ли текст индикаторы текущих событий
 */
export function containsCurrentIndicators(text: string): boolean {
  const currentIndicators = [
    'сейчас', 'текущий', 'последний', 'недавно', 'сегодня', 'вчера',
    'на данный момент', 'в настоящее время', 'актуальный',
    'current', 'latest', 'recent', 'today', 'now', 'this year',
    '2025', '2026',
  ];

  const lowerText = text.toLowerCase();
  return currentIndicators.some(indicator => lowerText.includes(indicator));
}

/**
 * Проверка, содержит ли текст индикаторы исторических событий
 */
export function containsHistoricalIndicators(text: string): boolean {
  const historicalIndicators = [
    'история', 'исторический', 'в прошлом', 'ранее', 'основан',
    'history', 'historical', 'founded', 'established', 'origin',
  ];

  const lowerText = text.toLowerCase();
  return historicalIndicators.some(indicator => lowerText.includes(indicator));
}

/**
 * Вычисление среднего значения
 */
export function average(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

/**
 * Округление до N знаков после запятой
 */
export function round(value: number, decimals: number = 2): number {
  return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
}
