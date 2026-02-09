/**
 * @file src/services/pipeline/planning.ts
 * @description Phase 2: Planning — декомпозиция на research questions
 * @context Разбивает запрос на конкретные вопросы. Лимит: simple=3, standard=5, deep=10
 * @dependencies services/anthropic.ts, services/budget.ts
 * @affects Количество и качество research-вопросов
 */

import config from '../../config';
import { getAnthropicService } from '../anthropic';
import { TokenBudgetManager } from '../budget';
import { logger } from '../../utils/logger';
import {
  PlanningResult,
  ResearchQuestion,
  TriageResult,
  ResearchOptions,
  VerificationRequirement,
} from '../../types/research';

interface PlanningWithUsage extends PlanningResult {
  usage?: { input: number; output: number };
}

/**
 * Планирует исследование с учётом бюджета
 * @param query - Уточнённый запрос
 * @param triageResult - Результат triage
 * @param options - Опции исследования
 * @param requestId - ID запроса
 * @param budget - Менеджер бюджета (опционально)
 * @returns Список research-вопросов и стратегия
 */
export async function planResearch(
  query: string,
  triageResult: TriageResult,
  options: ResearchOptions,
  requestId?: string,
  budget?: TokenBudgetManager
): Promise<PlanningWithUsage> {
  const anthropic = getAnthropicService();

  // Определяем максимум вопросов по режиму
  const maxQuestions = triageResult.mode === 'simple'
    ? config.maxQuestionsSimple
    : triageResult.mode === 'deep'
      ? config.maxQuestionsDeep
      : config.maxQuestionsStandard;

  // Получаем max_tokens из бюджета если доступен
  const maxTokens = budget
    ? budget.getMaxTokensForCall('planning')
    : 2000;

  const researchTypeInstructions = {
    facts_only: 'Focus ONLY on factual questions. No analysis or predictions.',
    facts_and_analysis: 'Include both factual questions and analytical questions (comparisons, trends).',
    full: 'Include factual questions, analytical questions, and relevant predictions/opinions from experts.',
  };

  const prompt = `Create a research plan for this query.

Query: "${query}"

Query type: ${triageResult.queryType}
Mode: ${triageResult.mode}
Research type: ${options.researchType}
${researchTypeInstructions[options.researchType]}

Create exactly ${Math.min(triageResult.estimatedQuestions, maxQuestions)} specific research questions (maximum ${maxQuestions}).
Each question should be:
- Specific and searchable
- Focused on one aspect
- Answerable with reliable sources

For each question, specify:
- type: "factual" (concrete facts), "analytical" (comparisons/trends), "speculative" (predictions)
- priority: 1 (highest) to 3 (lowest)
- expectedFactTypes: what kind of facts to look for

Respond in JSON:
{
  "questions": [
    {
      "id": 1,
      "text": "specific question",
      "type": "factual" | "analytical" | "speculative",
      "priority": 1-3,
      "expectedFactTypes": ["dates", "numbers", "events", etc.]
    }
  ],
  "scope": "brief description of research scope",
  "factTypes": ["list of all fact types to look for"]
}`;

  const result = await anthropic.completeJson<{
    questions: Array<{
      id: number;
      text: string;
      type: string;
      priority: number;
      expectedFactTypes: string[];
    }>;
    scope: string;
    factTypes: string[];
  }>(prompt, {
    temperature: 0.3,
    maxTokens,
    requestId,
    defaultValue: {
      questions: [{ id: 1, text: query, type: 'factual', priority: 1, expectedFactTypes: ['facts'] }],
      scope: 'General research',
      factTypes: ['facts'],
    },
  });

  // Записываем расход в бюджет
  if (budget && result.usage) {
    budget.recordUsage('planning', config.claudeModel, result.usage.input, result.usage.output);
  }

  // Преобразуем и валидируем questions — программно обрезаем до maxQuestions
  const questions: ResearchQuestion[] = (result.data.questions || [])
    .slice(0, maxQuestions)
    .map((q, idx) => ({
      id: q.id || idx + 1,
      text: q.text,
      type: (['factual', 'analytical', 'speculative'].includes(q.type) ? q.type : 'factual') as 'factual' | 'analytical' | 'speculative',
      priority: Math.max(1, Math.min(3, q.priority || 1)),
      expectedFactTypes: q.expectedFactTypes || ['facts'],
    }));

  // Если нет вопросов, создаём один по умолчанию
  if (questions.length === 0) {
    questions.push({
      id: 1,
      text: query,
      type: 'factual',
      priority: 1,
      expectedFactTypes: ['facts'],
    });
  }

  // Создаём verification strategy
  const verificationStrategy: Record<string, VerificationRequirement> = {
    factual: {
      minSources: 1,
      requiredSourceTypes: ['authoritative'],
      freshnessRequired: false,
    },
    analytical: {
      minSources: 1,
      requiredSourceTypes: ['any'],
      freshnessRequired: false,
    },
    speculative: {
      minSources: 0,
      requiredSourceTypes: [],
      freshnessRequired: false,
    },
  };

  logger.info('Planning completed', {
    request_id: requestId,
    questions_count: questions.length,
    max_questions: maxQuestions,
    mode: triageResult.mode,
    scope: result.data.scope,
  });

  return {
    questions,
    scope: result.data.scope || 'Research scope',
    factTypes: result.data.factTypes || ['facts'],
    verificationStrategy,
    usage: result.usage,
  };
}
