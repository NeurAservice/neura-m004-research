/**
 * @file src/routes/research.ts
 * @description Research API endpoints (UI)
 * @context Основные API для UI с биллингом через CORE
 */

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ResearchOrchestrator } from '../services/pipeline';
import { getCoreService } from '../services/core';
import { createResearch, updateResearch, getResearchById, getResearchHistory } from '../storage/researches';
import { ValidationError, NotFoundError, InsufficientBalanceError } from '../types/errors';
import { CreateResearchRequest, ClarifyRequest } from '../types/api';
import { ResearchOptions, DEFAULT_OPTIONS, ResearchEvent } from '../types/research';
import { logger } from '../utils/logger';

const router = Router();

// Хранилище активных orchestrators (для SSE)
const activeOrchestrators = new Map<string, ResearchOrchestrator>();

/**
 * Маппинг UI mode → backend ResearchMode
 * quick (UI "Быстрый") → simple (backend)
 */
const MODE_MAP: Record<string, ResearchOptions['mode']> = {
  simple: 'simple',
  standard: 'standard',
  deep: 'deep',
  quick: 'simple',
  auto: 'auto',
};

/**
 * Маппинг UI researchType → backend ResearchType
 * comparison, trends, how_to — UI-варианты → facts_and_analysis
 */
const RESEARCH_TYPE_MAP: Record<string, ResearchOptions['researchType']> = {
  facts_only: 'facts_only',
  facts_and_analysis: 'facts_and_analysis',
  full: 'full',
  comparison: 'facts_and_analysis',
  trends: 'facts_and_analysis',
  how_to: 'facts_and_analysis',
};

/**
 * Нормализует опции из фронтенда к допустимым бэкенд-значениям
 */
function normalizeResearchOptions(raw: Record<string, unknown>): Partial<ResearchOptions> {
  const result: Partial<ResearchOptions> = {};

  if (raw.mode) {
    result.mode = MODE_MAP[raw.mode as string] || 'auto';
  }
  if (raw.researchType) {
    result.researchType = RESEARCH_TYPE_MAP[raw.researchType as string] || 'facts_and_analysis';
  }
  if (raw.language === 'ru' || raw.language === 'en') {
    result.language = raw.language;
  }
  if (typeof raw.maxReportLength === 'string') {
    const validLengths = ['short', 'medium', 'long'] as const;
    if (validLengths.includes(raw.maxReportLength as any)) {
      result.maxReportLength = raw.maxReportLength as ResearchOptions['maxReportLength'];
    }
  }

  return result;
}

/**
 * POST /api/research
 * Создаёт новое исследование
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.body as CreateResearchRequest;
    const requestId = (req as any).id || uuidv4();

    // Валидация
    if (!body.query || body.query.trim().length === 0) {
      throw new ValidationError('query is required');
    }
    if (!body.user_id) {
      throw new ValidationError('user_id is required');
    }

    const userId = body.user_id;
    const query = body.query.trim();

    // Нормализуем options с валидацией значений
    const rawOptions = body.options || {};
    const normalizedOptions = normalizeResearchOptions(rawOptions);
    const options: ResearchOptions = { ...DEFAULT_OPTIONS, ...normalizedOptions };

    // Сохраняем shell info для биллинга
    const shellId = body.shell_id;
    const originUrl = body.origin_url || req.headers.referer || req.headers.origin as string;

    // Начинаем биллинг
    const coreService = getCoreService();
    const billingResult = await coreService.startBilling({
      userId,
      sessionId: body.session_id,
      requestId,
    });

    if (!billingResult.allowed) {
      throw new InsufficientBalanceError(billingResult.balance || 0);
    }

    // Устанавливаем SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Создаём orchestrator
    const orchestrator = new ResearchOrchestrator(requestId);
    const researchId = orchestrator.getResearchId();
    activeOrchestrators.set(researchId, orchestrator);

    // Подписываемся на события
    orchestrator.on('event', (event: ResearchEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Создаём запись в БД
    createResearch({
      id: researchId,
      user_id: userId,
      session_id: body.session_id,
      query,
      options,
      status: 'in_progress',
      progress: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Запускаем исследование
    try {
      const result = await orchestrator.execute(query, userId, options);

      // Обновляем БД
      updateResearch(researchId, {
        status: result.status,
        progress: result.progress,
        output: result.output,
        usage: result.usage,
        clarifiedQuery: result.clarifiedQuery,
        completedAt: result.completedAt,
      });

      // Завершаем биллинг
      if (result.status === 'completed' && result.usage) {
        await coreService.finishBilling({
          action: 'commit',
          userId,
          usage: orchestrator.getBillingUsage(),
          shellId,
          originUrl,
          requestId,
        });
      } else if (result.status === 'failed') {
        await coreService.finishBilling({
          action: 'rollback',
          userId,
          requestId,
        });
      }
    } catch (error) {
      // Rollback при ошибке
      await coreService.finishBilling({
        action: 'rollback',
        userId,
        requestId,
      });

      updateResearch(researchId, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      const errorEvent: ResearchEvent = {
        type: 'error',
        error_code: 'RESEARCH_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    }

    // Cleanup
    activeOrchestrators.delete(researchId);
    res.end();

  } catch (error) {
    // Если SSE уже начат, завершаем с ошибкой
    if (res.headersSent) {
      const errorEvent: ResearchEvent = {
        type: 'error',
        error_code: 'RESEARCH_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      res.end();
    } else {
      next(error);
    }
  }
});

/**
 * GET /api/research/user/history
 * Получает историю исследований пользователя
 * ВАЖНО: Этот роут должен быть ПЕРЕД роутами с :id, иначе 'user' будет распознан как :id
 */
router.get('/user/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.query.user_id as string;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    if (!userId) {
      throw new ValidationError('user_id is required');
    }

    const history = getResearchHistory(userId, limit, offset);

    res.json({
      status: 'success',
      data: {
        items: history.items.map(r => ({
          id: r.id,
          query: r.query,
          status: r.status,
          quality_score: r.output?.quality?.compositeScore,
          created_at: r.createdAt,
          completed_at: r.completedAt,
        })),
        total: history.total,
        limit,
        offset,
      },
    });

  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/research/:id/clarify
 * Отвечает на уточняющие вопросы
 */
router.post('/:id/clarify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const body = req.body as ClarifyRequest;

    if (!body.answers || Object.keys(body.answers).length === 0) {
      throw new ValidationError('answers is required');
    }

    const research = getResearchById(id);
    if (!research) {
      throw new NotFoundError('Research');
    }

    if (research.status !== 'clarification_needed') {
      throw new ValidationError('Research is not awaiting clarification');
    }

    // Продолжаем исследование с ответами
    const requestId = (req as any).id || uuidv4();
    const orchestrator = new ResearchOrchestrator(requestId);

    // SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    orchestrator.on('event', (event: ResearchEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    try {
      const result = await orchestrator.execute(
        research.query,
        research.user_id,
        research.options,
        body.answers
      );

      updateResearch(id, {
        status: result.status,
        progress: result.progress,
        output: result.output,
        usage: result.usage,
        clarifiedQuery: result.clarifiedQuery,
        completedAt: result.completedAt,
      });

    } catch (error) {
      updateResearch(id, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      const errorEvent: ResearchEvent = {
        type: 'error',
        error_code: 'RESEARCH_FAILED',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
    }

    res.end();

  } catch (error) {
    if (res.headersSent) {
      res.end();
    } else {
      next(error);
    }
  }
});

/**
 * GET /api/research/:id
 * Получает результат исследования
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const research = getResearchById(id);
    if (!research) {
      throw new NotFoundError('Research');
    }

    res.json({
      status: 'success',
      data: {
        id: research.id,
        query: research.query,
        status: research.status,
        progress: research.progress,
        result: research.output,
        error: research.error,
        created_at: research.createdAt,
        completed_at: research.completedAt,
      },
    });

  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/research/:id/status
 * Проверяет статус исследования
 */
router.get('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const research = getResearchById(id);
    if (!research) {
      throw new NotFoundError('Research');
    }

    res.json({
      status: 'success',
      data: {
        status: research.status,
        progress: research.progress,
        currentPhase: research.currentPhase,
      },
    });

  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/research/:id/export
 * Экспортирует исследование
 */
router.get('/:id/export', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const format = (req.query.format as string) || 'markdown';

    const research = getResearchById(id);
    if (!research) {
      throw new NotFoundError('Research');
    }

    if (research.status !== 'completed' || !research.output) {
      throw new ValidationError('Research is not completed');
    }

    switch (format) {
      case 'markdown':
        res.setHeader('Content-Type', 'text/markdown');
        res.setHeader('Content-Disposition', `attachment; filename="research-${id}.md"`);
        res.send(research.output.report);
        break;

      case 'json':
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="research-${id}.json"`);
        res.json({
          id: research.id,
          query: research.query,
          ...research.output,
        });
        break;

      case 'pdf':
        // PDF генерация отложена
        throw new ValidationError('PDF export is not yet implemented');

      default:
        throw new ValidationError('Invalid format. Supported: markdown, json');
    }

  } catch (error) {
    next(error);
  }
});

export { router as researchRouter };
export default router;
