/**
 * @file src/services/pipeline/clarification.ts
 * @description Phase 1: Clarification - проверка и уточнение запроса
 * @context Определяет, нужны ли уточняющие вопросы
 */

import { getAnthropicService } from '../anthropic';
import { logger } from '../../utils/logger';
import { ClarificationResult } from '../../types/research';

interface ClarificationWithUsage extends ClarificationResult {
  usage?: { input: number; output: number };
}

/**
 * Проверяет, нужны ли уточнения
 */
export async function checkClarification(
  query: string,
  requestId?: string
): Promise<ClarificationWithUsage> {
  const anthropic = getAnthropicService();

  const prompt = `Analyze this research query for clarity and completeness.

Query: "${query}"

Determine if the query is clear enough to research, or if clarification is needed.

Reasons for clarification:
- Ambiguous time period (when? which year?)
- Unclear geography/market (which country? which region?)
- Ambiguous terms or acronyms
- Scope too broad (need to narrow down)
- Multiple possible interpretations

If the query is clear and specific enough → status: "ready"
If clarification is needed → status: "needs_clarification" and provide 1-3 specific questions

Respond in JSON:
{
  "status": "ready" | "needs_clarification",
  "questions": ["question 1", "question 2"],
  "reasoning": "why clarification is/isn't needed"
}`;

  const result = await anthropic.completeJson<{
    status: string;
    questions?: string[];
    reasoning: string;
  }>(prompt, {
    temperature: 0.2,
    requestId,
    defaultValue: {
      status: 'ready',
      reasoning: 'Query appears clear',
    },
  });

  const status = result.data.status === 'needs_clarification' ? 'needs_clarification' : 'ready';

  logger.info('Clarification check completed', {
    request_id: requestId,
    status,
    questions_count: result.data.questions?.length || 0,
  });

  return {
    status,
    questions: status === 'needs_clarification' ? result.data.questions : undefined,
    usage: result.usage,
  };
}

/**
 * Применяет ответы на уточняющие вопросы
 */
export async function applyClarification(
  originalQuery: string,
  answers: Record<number, string>,
  requestId?: string
): Promise<{ clarifiedQuery: string; usage?: { input: number; output: number } }> {
  const anthropic = getAnthropicService();

  const answersText = Object.entries(answers)
    .map(([idx, answer]) => `Answer ${parseInt(idx) + 1}: ${answer}`)
    .join('\n');

  const prompt = `Reformulate the research query incorporating the clarification answers.

Original query: "${originalQuery}"

Clarification answers:
${answersText}

Create a new, clear, specific query that incorporates all the clarifications.
The reformulated query should be self-contained and not require the original answers to understand.

Respond in JSON:
{
  "clarifiedQuery": "the new complete query"
}`;

  const result = await anthropic.completeJson<{ clarifiedQuery: string }>(prompt, {
    temperature: 0.2,
    requestId,
    defaultValue: { clarifiedQuery: originalQuery },
  });

  logger.info('Clarification applied', {
    request_id: requestId,
    original_length: originalQuery.length,
    clarified_length: result.data.clarifiedQuery.length,
  });

  return {
    clarifiedQuery: result.data.clarifiedQuery || originalQuery,
    usage: result.usage,
  };
}
