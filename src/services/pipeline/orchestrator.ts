/**
 * @file src/services/pipeline/orchestrator.ts
 * @description Оркестратор pipeline исследования
 * @context Главный модуль, управляющий всеми фазами исследования
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import config from '../../config';
import { logger, createRequestLogger } from '../../utils/logger';
import { UsageTracker, BillingUsage } from '../../types/billing';
import {
  ResearchResult,
  ResearchOptions,
  ResearchOutput,
  ResearchEvent,
  TriageResult,
  ClarificationResult,
  PlanningResult,
  ResearchQuestionResult,
  VerificationResult,
  Claim,
  Source,
  QualityMetrics,
  UsageData,
  DEFAULT_OPTIONS,
} from '../../types/research';
import { triage } from './triage';
import { checkClarification, applyClarification } from './clarification';
import { planResearch } from './planning';
import { executeResearch } from './research';
import { verifyAllClaims } from './verification';
import { synthesizeOutput } from './output';

export class ResearchOrchestrator extends EventEmitter {
  private requestId: string;
  private researchId: string;
  private log: ReturnType<typeof createRequestLogger>;
  private usageTracker: UsageTracker;
  private aborted: boolean = false;

  constructor(requestId?: string) {
    super();
    this.requestId = requestId || uuidv4();
    this.researchId = uuidv4();
    this.log = createRequestLogger(this.requestId, this.researchId);
    this.usageTracker = new UsageTracker();
  }

  /**
   * Отправляет событие прогресса
   */
  private emitProgress(phase: string, status: string, progress: number, details?: Record<string, unknown>) {
    const event: ResearchEvent = {
      type: 'progress',
      phase,
      status,
      progress,
      details,
    };
    this.emit('event', event);
    this.log.info(`Progress: ${phase} - ${status}`, { progress, ...details });
  }

  /**
   * Отменяет исследование
   */
  abort() {
    this.aborted = true;
    this.log.warn('Research aborted');
  }

  /**
   * Проверяет, не отменено ли исследование
   */
  private checkAborted() {
    if (this.aborted) {
      throw new Error('Research was cancelled');
    }
  }

  /**
   * Запускает полный pipeline исследования
   */
  async execute(
    query: string,
    userId: string,
    inputOptions: Partial<ResearchOptions> = {},
    clarificationAnswers?: Record<number, string>
  ): Promise<ResearchResult> {
    const options: ResearchOptions = { ...DEFAULT_OPTIONS, ...inputOptions };
    const startTime = Date.now();

    this.log.info('Starting research pipeline', {
      query,
      user_id: userId,
      options,
    });

    try {
      // Phase 0: Triage
      this.emitProgress('triage', 'Анализ запроса...', 5);
      this.checkAborted();

      const triageResult = await triage(query, options, this.requestId);
      this.usageTracker.addUsage(
        config.claudeModel,
        triageResult.usage?.input || 0,
        triageResult.usage?.output || 0
      );

      this.emitProgress('triage', 'Анализ завершён', 10, {
        queryType: triageResult.queryType,
        mode: triageResult.mode,
      });

      // Phase 1: Clarification
      this.emitProgress('clarification', 'Проверка ясности запроса...', 12);
      this.checkAborted();

      let clarifiedQuery = query;

      if (!clarificationAnswers) {
        const clarificationResult = await checkClarification(query, this.requestId);
        this.usageTracker.addUsage(
          config.claudeModel,
          clarificationResult.usage?.input || 0,
          clarificationResult.usage?.output || 0
        );

        if (clarificationResult.status === 'needs_clarification') {
          // Требуются уточнения — возвращаем промежуточный результат
          this.log.info('Clarification needed', { questions: clarificationResult.questions });

          const event: ResearchEvent = {
            type: 'clarification_needed',
            questions: clarificationResult.questions || [],
            research_id: this.researchId,
          };
          this.emit('event', event);

          return this.createPendingResult(userId, query, options, 'clarification_needed');
        }
      } else {
        // Применяем ответы на уточняющие вопросы
        const applied = await applyClarification(query, clarificationAnswers, this.requestId);
        clarifiedQuery = applied.clarifiedQuery;
        this.usageTracker.addUsage(
          config.claudeModel,
          applied.usage?.input || 0,
          applied.usage?.output || 0
        );
      }

      this.emitProgress('clarification', 'Запрос понятен', 15);

      // Phase 2: Planning
      this.emitProgress('planning', 'Планирование исследования...', 18);
      this.checkAborted();

      const planningResult = await planResearch(
        clarifiedQuery,
        triageResult,
        options,
        this.requestId
      );
      this.usageTracker.addUsage(
        config.claudeModel,
        planningResult.usage?.input || 0,
        planningResult.usage?.output || 0
      );

      this.emitProgress('planning', `Запланировано ${planningResult.questions.length} вопросов`, 25, {
        questions_count: planningResult.questions.length,
      });

      // Phase 3: Research
      this.emitProgress('research', 'Сбор информации...', 30);
      this.checkAborted();

      const researchResults = await executeResearch(
        planningResult.questions,
        options,
        this.requestId,
        (questionId, total, status) => {
          const progress = 30 + Math.round((questionId / total) * 30);
          this.emitProgress('research', status, progress, { questionId, total });
        }
      );

      // Накапливаем usage от research
      for (const r of researchResults) {
        this.usageTracker.addUsage(
          config.perplexityModel,
          r.tokensUsed.input,
          r.tokensUsed.output
        );
      }

      this.emitProgress('research', 'Информация собрана', 60);

      // Phase 4: Verification
      this.emitProgress('verification', 'Верификация фактов...', 62);
      this.checkAborted();

      const verificationResults = await verifyAllClaims(
        researchResults,
        options,
        this.requestId,
        (current, total, status) => {
          const progress = 62 + Math.round((current / total) * 20);
          this.emitProgress('verification', status, progress, { current, total });
        }
      );

      // Накапливаем usage от verification
      for (const v of verificationResults.allResults) {
        if (v.usage) {
          this.usageTracker.addUsage(
            config.perplexityModel,
            v.usage.input,
            v.usage.output
          );
        }
      }

      this.emitProgress('verification', 'Верификация завершена', 82);

      // Phase 5: Output
      this.emitProgress('output', 'Формирование отчёта...', 85);
      this.checkAborted();

      const output = await synthesizeOutput(
        clarifiedQuery,
        planningResult,
        researchResults,
        verificationResults,
        options,
        this.requestId
      );
      this.usageTracker.addUsage(
        config.claudeModel,
        output.usage?.input || 0,
        output.usage?.output || 0
      );

      this.emitProgress('output', 'Отчёт готов', 100);

      // Формируем финальный результат
      const duration = Date.now() - startTime;
      const usageData = this.calculateUsageData();

      const result: ResearchResult = {
        id: this.researchId,
        user_id: userId,
        query,
        clarifiedQuery: clarifiedQuery !== query ? clarifiedQuery : undefined,
        options,
        status: 'completed',
        progress: 100,
        output,
        usage: usageData,
        createdAt: new Date(startTime).toISOString(),
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };

      // Emit complete event
      const completeEvent: ResearchEvent = {
        type: 'complete',
        research_id: this.researchId,
        result: output,
      };
      this.emit('event', completeEvent);

      this.log.info('Research completed', {
        duration_ms: duration,
        quality_score: output.quality.compositeScore,
        facts_verified: output.quality.facts.verified,
        facts_total: output.quality.facts.total,
      });

      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.log.error('Research failed', {
        error: errorMessage,
        duration_ms: Date.now() - startTime,
      });

      const errorEvent: ResearchEvent = {
        type: 'error',
        error_code: 'RESEARCH_FAILED',
        message: errorMessage,
      };
      this.emit('event', errorEvent);

      return {
        id: this.researchId,
        user_id: userId,
        query,
        options,
        status: 'failed',
        progress: 0,
        error: errorMessage,
        usage: this.calculateUsageData(),
        createdAt: new Date(startTime).toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Создаёт промежуточный результат (pending)
   */
  private createPendingResult(
    userId: string,
    query: string,
    options: ResearchOptions,
    status: 'pending' | 'in_progress' | 'clarification_needed'
  ): ResearchResult {
    return {
      id: this.researchId,
      user_id: userId,
      query,
      options,
      status,
      progress: 0,
      usage: this.calculateUsageData(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Вычисляет итоговые данные об использовании
   */
  private calculateUsageData(): UsageData {
    const usage = this.usageTracker.getUsage();
    const totals = this.usageTracker.getTotalTokens();

    // Примерные цены (USD)
    const prices: Record<string, { input: number; output: number }> = {
      'sonar-pro': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
      'claude-sonnet-4-20250514': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
    };

    let totalCost = 0;
    const byModel: UsageData['byModel'] = [];

    for (const [model, tokens] of Object.entries(usage)) {
      const modelPrices = prices[model] || prices['claude-sonnet-4-20250514'];
      const cost = tokens.inputTokens * modelPrices.input + tokens.outputTokens * modelPrices.output;
      totalCost += cost;

      byModel.push({
        model,
        provider: model.includes('sonar') ? 'perplexity' : 'anthropic',
        input: tokens.inputTokens,
        output: tokens.outputTokens,
        cost,
      });
    }

    return {
      totalInputTokens: totals.input,
      totalOutputTokens: totals.output,
      totalCostUsd: totalCost,
      byModel,
      apiCalls: byModel.length,
    };
  }

  /**
   * Возвращает billing usage для CORE
   */
  getBillingUsage(): BillingUsage {
    return this.usageTracker.toBillingUsage();
  }

  /**
   * Геттеры
   */
  getResearchId(): string {
    return this.researchId;
  }

  getRequestId(): string {
    return this.requestId;
  }
}

export default ResearchOrchestrator;
