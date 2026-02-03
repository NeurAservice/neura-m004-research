/**
 * @file src/routes/internal.ts
 * @description Internal API для других модулей (без биллинга)
 * @context Вызовы от m003 и других модулей
 */

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ResearchOrchestrator } from '../services/pipeline';
import { requireInternalAuth } from '../middleware/auth';
import { ValidationError } from '../types/errors';
import { InternalResearchRequest, InternalResearchResponse } from '../types/api';
import { ResearchOptions, DEFAULT_OPTIONS } from '../types/research';
import { logger } from '../utils/logger';

const router = Router();

// Все internal routes требуют аутентификации
router.use(requireInternalAuth);

/**
 * POST /api/internal/research
 * Выполняет исследование для другого модуля (без биллинга)
 */
router.post('/research', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as InternalResearchRequest;
    const requestId = (req.headers['x-request-id'] as string) || (req as any).id || uuidv4();

    // Валидация
    if (!body.query || body.query.trim().length === 0) {
      throw new ValidationError('query is required');
    }
    if (!body.caller_module) {
      throw new ValidationError('caller_module is required');
    }
    if (!body.caller_request_id) {
      throw new ValidationError('caller_request_id is required');
    }

    logger.info('Internal research request', {
      request_id: requestId,
      caller_module: body.caller_module,
      caller_request_id: body.caller_request_id,
      query_length: body.query.length,
    });

    const query = body.query.trim();
    const options: ResearchOptions = {
      ...DEFAULT_OPTIONS,
      mode: body.options?.mode || 'standard',
      researchType: body.options?.researchType || 'facts_and_analysis',
      confidenceThreshold: body.options?.confidenceThreshold || DEFAULT_OPTIONS.confidenceThreshold,
      language: body.options?.language || 'ru',
      maxReportLength: body.options?.maxReportLength || 'medium',
    };

    // Создаём orchestrator (БЕЗ биллинга)
    const orchestrator = new ResearchOrchestrator(requestId);
    const researchId = orchestrator.getResearchId();

    // Выполняем исследование
    const result = await orchestrator.execute(query, body.caller_module, options);

    if (result.status === 'failed') {
      throw new Error(result.error || 'Research failed');
    }

    if (!result.output) {
      throw new Error('Research completed without output');
    }

    // Формируем response с usage для биллинга вызывающего модуля
    const response: InternalResearchResponse = {
      status: 'success',
      research_id: researchId,
      result: result.output,
      usage: {
        total_input_tokens: result.usage?.totalInputTokens || 0,
        total_output_tokens: result.usage?.totalOutputTokens || 0,
        models_used: (result.usage?.byModel || []).map(m => ({
          model: m.model,
          provider: m.provider,
          input_tokens: m.input,
          output_tokens: m.output,
        })),
        estimated_cost_usd: result.usage?.totalCostUsd || 0,
      },
      request_id: requestId,
    };

    logger.info('Internal research completed', {
      request_id: requestId,
      research_id: researchId,
      caller_module: body.caller_module,
      quality_score: result.output.quality.compositeScore,
      total_tokens: response.usage.total_input_tokens + response.usage.total_output_tokens,
    });

    res.json(response);

  } catch (error) {
    logger.error('Internal research failed', {
      request_id: (req as any).id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    next(error);
  }
});

export { router as internalRouter };
export default router;
