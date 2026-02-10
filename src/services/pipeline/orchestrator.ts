/**
 * @file src/services/pipeline/orchestrator.ts
 * @description Оркестратор pipeline исследования с бюджетным контролем и SourceRegistry
 * @context Главный модуль: создаёт TokenBudgetManager + SourceRegistry, передаёт во все фазы,
 *          обрабатывает circuit breaker, формирует partial completion.
 *          Между Phase 4 и Phase 5 выполняется URL-валидация источников.
 * @dependencies services/budget.ts, services/sourceRegistry.ts, все фазы pipeline
 * @affects Весь pipeline, биллинг, метаданные
 */

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import config from '../../config';
import { logger, createRequestLogger } from '../../utils/logger';
import { UsageTracker, BillingUsage } from '../../types/billing';
import { TokenBudgetManager, BudgetSnapshot } from '../budget';
import { SourceRegistry } from '../sourceRegistry';
import {
  ResearchResult,
  ResearchOptions,
  ResearchOutput,
  ResearchEvent,
  ResearchMode,
  TriageResult,
  ClarificationResult,
  PlanningResult,
  ResearchQuestionResult,
  VerificationResult,
  PartialCompletion,
  Claim,
  Source,
  QualityMetrics,
  QualityGateResult,
  UsageData,
  DEFAULT_OPTIONS,
} from '../../types/research';
import { triage } from './triage';
import { checkClarification, applyClarification } from './clarification';
import { planResearch } from './planning';
import { executeResearch } from './research';
import { verifyAllClaims } from './verification';
import { synthesizeOutput } from './output';
import { runQualityGate, downgradeGrade } from './qualityGate';
import { saveResearchStats, ResearchStats } from '../../utils/statsCollector';

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
  private emitProgress(phase: string, message: string, progress: number, details?: Record<string, unknown>) {
    const event: ResearchEvent = {
      type: 'progress',
      phase,
      message,
      progress,
      details,
    };
    this.emit('event', event);
    this.log.info(`Progress: ${phase} - ${message}`, { progress, ...details });
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
   * @param skipClarification - пропустить фазу уточняющих вопросов (для API-вызовов)
   */
  async execute(
    query: string,
    userId: string,
    inputOptions: Partial<ResearchOptions> = {},
    clarificationAnswers?: Record<number, string>,
    skipClarification: boolean = false
  ): Promise<ResearchResult> {
    const options: ResearchOptions = { ...DEFAULT_OPTIONS, ...inputOptions };
    const startTime = Date.now();

    this.log.info('Starting research pipeline', {
      query,
      user_id: userId,
      options,
    });

    try {
      // ═══════════════════════════════════════════════════
      // Phase 0: Triage (определяет mode → создаёт бюджет)
      // ═══════════════════════════════════════════════════
      this.emitProgress('triage', options.language === 'en' ? `Analyzing query: "${query.substring(0, 60)}${query.length > 60 ? '...' : ''}"` : `Анализ запроса: «${query.substring(0, 60)}${query.length > 60 ? '...' : ''}»`, 5);
      this.checkAborted();

      const triageResult = await triage(query, options, this.requestId);

      // Triage теперь использует OpenAI, но для совместимости оставляем addUsage
      if (triageResult.usage) {
        this.usageTracker.addOpenAIUsage(
          config.openaiModelTriage,
          triageResult.usage.input || 0,
          triageResult.usage.output || 0
        );
      }

      const mode: ResearchMode = triageResult.mode;

      this.emitProgress('triage', options.language === 'en' ? `Analysis complete. Mode: ${mode}, type: ${triageResult.queryType}` : `Анализ завершён. Режим: ${mode}, тип: ${triageResult.queryType}`, 10, {
        queryType: triageResult.queryType,
        mode,
        preTriageFloor: triageResult.preTriageFloor,
        preTriageReasons: triageResult.preTriageReasons,
      });

      // ═══════════════════════════════════════════════════
      // Создаём TokenBudgetManager на основе triage result
      // ═══════════════════════════════════════════════════
      // Определяем лимиты бюджета по режиму
      const budgetLimitsMap: Record<string, { maxTokens: number; maxCostUsd: number }> = {
        simple: { maxTokens: config.budgetSimpleMaxTokens, maxCostUsd: config.budgetSimpleMaxCostUsd },
        standard: { maxTokens: config.budgetStandardMaxTokens, maxCostUsd: config.budgetStandardMaxCostUsd },
        deep: { maxTokens: config.budgetDeepMaxTokens, maxCostUsd: config.budgetDeepMaxCostUsd },
      };

      const budget = new TokenBudgetManager(
        mode,
        budgetLimitsMap[mode] || budgetLimitsMap.standard,
        {
          warningPct: config.circuitBreakerWarning,
          criticalPct: config.circuitBreakerCritical,
          stopPct: config.circuitBreakerStop,
        },
        this.requestId
      );

      // Ретроактивно записываем triage usage
      if (triageResult.usage) {
        budget.recordUsage(
          'triage',
          config.openaiModelTriage,
          triageResult.usage.input || 0,
          triageResult.usage.output || 0
        );
      }

      this.log.info('Budget created', {
        mode,
        max_tokens: budget.getSnapshot().limits.maxTokens,
        max_cost_usd: budget.getSnapshot().limits.maxCostUsd,
      });

      // Создаём SourceRegistry для единого реестра источников
      const sourceRegistry = new SourceRegistry(this.requestId);

      this.log.info('SourceRegistry initialized');

      // ═══════════════════════════════════════════════════
      // Phase 1: Clarification (ВНЕ бюджета)
      // ═══════════════════════════════════════════════════
      let clarifiedQuery = query;

      if (skipClarification) {
        this.emitProgress('clarification', 'API-режим: запрос принят как есть', 15);
        this.log.info('Clarification skipped (API mode)', { query_length: query.length });
      } else if (clarificationAnswers) {
        this.emitProgress('clarification', 'Применение уточнений...', 12);
        this.checkAborted();

        const applied = await applyClarification(query, clarificationAnswers, this.requestId);
        clarifiedQuery = applied.clarifiedQuery;
        this.usageTracker.addUsage(
          config.claudeModel,
          applied.usage?.input || 0,
          applied.usage?.output || 0
        );
        this.emitProgress('clarification', 'Уточнения применены', 15);
      } else {
        this.emitProgress('clarification', options.language === 'en' ? 'Checking query clarity...' : 'Проверка ясности запроса...', 12);
        this.checkAborted();

        const clarificationResult = await checkClarification(query, this.requestId);
        this.usageTracker.addUsage(
          config.claudeModel,
          clarificationResult.usage?.input || 0,
          clarificationResult.usage?.output || 0
        );

        if (clarificationResult.status === 'needs_clarification') {
          this.log.info('Clarification needed', { questions: clarificationResult.questions });

          const event: ResearchEvent = {
            type: 'clarification_needed',
            questions: clarificationResult.questions || [],
            research_id: this.researchId,
          };
          this.emit('event', event);

          return this.createPendingResult(userId, query, options, 'clarification_needed');
        }
        this.emitProgress('clarification', options.language === 'en' ? 'Query is clear, proceeding' : 'Запрос понятен, продолжаем', 15);
      }

      // ═══════════════════════════════════════════════════
      // Phase 2: Planning (с бюджетом)
      // ═══════════════════════════════════════════════════
      this.emitProgress('planning', options.language === 'en' ? 'Planning research strategy...' : 'Планирование стратегии исследования...', 18);
      this.checkAborted();

      budget.startPhase('planning');

      const planningResult = await planResearch(
        clarifiedQuery,
        triageResult,
        options,
        this.requestId,
        budget
      );
      this.usageTracker.addUsage(
        config.claudeModel,
        planningResult.usage?.input || 0,
        planningResult.usage?.output || 0
      );

      const plannedQuestions = planningResult.questions.length;

      this.emitProgress('planning', options.language === 'en' ? `Planned ${plannedQuestions} research questions` : `Запланировано ${plannedQuestions} исследовательских вопросов`, 22, {
        questions_count: plannedQuestions,
        mode,
      });

      // ═══════════════════════════════════════════════════
      // Phase 3: Research (с бюджетом и адаптивностью)
      // ═══════════════════════════════════════════════════
      this.emitProgress('research', options.language === 'en' ? 'Starting information gathering...' : 'Начинаем сбор информации...', 28);
      this.checkAborted();

      budget.startPhase('research');

      const researchResults = await executeResearch(
        planningResult.questions,
        options,
        mode,
        sourceRegistry,
        this.requestId,
        budget,
        (questionId, total, status) => {
          const progress = 28 + Math.round((questionId / total) * 35);
          this.emitProgress('research', status, progress, { questionId, total });
        }
      );

      // Накапливаем usage от research (Perplexity с search context tokens)
      for (const r of researchResults) {
        this.usageTracker.addPerplexityUsage(
          config.perplexityModel,
          r.tokensUsed.input,
          r.tokensUsed.output,
          r.tokensUsed.searchContextTokens,
          r.tokensUsed.totalCost
        );
      }

      const coveredQuestions = researchResults.filter(r => r.response && r.response.length > 0).length;

      this.emitProgress('research', options.language === 'en' ? `Collected data: ${coveredQuestions} of ${plannedQuestions} questions covered` : `Данные собраны: ${coveredQuestions} из ${plannedQuestions} вопросов покрыто`, 63, {
        covered: coveredQuestions,
        planned: plannedQuestions,
      });

      // ═══════════════════════════════════════════════════
      // Phase 4: Verification (с бюджетом и деградацией)
      // ═══════════════════════════════════════════════════
      this.emitProgress('verification', options.language === 'en' ? 'Starting fact verification...' : 'Начинаем верификацию фактов...', 65);
      this.checkAborted();

      budget.startPhase('verification');

      const verificationResults = await verifyAllClaims(
        researchResults,
        options,
        mode,
        this.requestId,
        budget,
        sourceRegistry,
        (current, total, status) => {
          const progress = 65 + Math.round((current / total) * 13);
          this.emitProgress('verification', status, progress, { current, total });
        }
      );

      // Verification теперь использует OpenAI, учитываем usage
      // (индивидуальные расходы уже записаны в budget через verification.ts)
      // Для UsageTracker добавляем агрегированный OpenAI usage из верификации
      if (verificationResults.openaiUsage) {
        for (const [model, usage] of Object.entries(verificationResults.openaiUsage)) {
          this.usageTracker.addOpenAIUsage(model, usage.input, usage.output);
        }
      }

      this.emitProgress('verification', options.language === 'en' ? `Verification complete (level: ${verificationResults.verificationLevel})` : `Верификация завершена (уровень: ${verificationResults.verificationLevel === 'full' ? 'полная' : verificationResults.verificationLevel === 'simplified' ? 'упрощённая' : 'пропущена'})`, 78, {
        verification_level: verificationResults.verificationLevel,
      });

      // ═══════════════════════════════════════════════════
      // Phase 4.5: URL Validation (между верификацией и output)
      // ═══════════════════════════════════════════════════
      this.emitProgress('verification', options.language === 'en' ? 'Validating source URLs...' : 'Проверка доступности источников...', 80);

      const urlValidationResults = await sourceRegistry.validateUrls({
        maxConcurrency: config.urlValidationMaxConcurrency,
        timeoutMs: config.urlValidationTimeoutMs,
      });

      this.log.info('URL validation completed', {
        total: urlValidationResults.total,
        available: urlValidationResults.available,
        unavailable: urlValidationResults.unavailable,
      });

      // ═══════════════════════════════════════════════════
      // Phase 5: Output (с partial completion, Source Masking)
      // ═══════════════════════════════════════════════════
      this.emitProgress('output', options.language === 'en' ? 'Generating final report...' : 'Формирование финального отчёта...', 85);
      this.checkAborted();

      budget.startPhase('output');

      // Формируем partial completion
      const budgetSnapshot = budget.getSnapshot();
      const isPartial = coveredQuestions < plannedQuestions ||
        verificationResults.verificationLevel !== 'full' ||
        budgetSnapshot.circuitBreaker.triggered;

      const partialCompletion: PartialCompletion | undefined = isPartial ? {
        isPartial: true,
        coveredQuestions,
        plannedQuestions,
        completedPhases: getCompletedPhases(budgetSnapshot),
        skippedPhases: getSkippedPhases(budgetSnapshot, verificationResults.verificationLevel),
        verificationLevel: verificationResults.verificationLevel,
        circuitBreakerTriggered: budgetSnapshot.circuitBreaker.triggered,
        circuitBreakerLevel: budgetSnapshot.circuitBreaker.level,
      } : undefined;

      const output = await synthesizeOutput(
        clarifiedQuery,
        planningResult,
        researchResults,
        verificationResults,
        options,
        mode,
        sourceRegistry,
        this.requestId,
        partialCompletion,
        budgetSnapshot
      );

      // Определяем модель, использованную для output
      const outputModel = mode === 'simple' ? config.claudeModelSimple : config.claudeModel;

      this.usageTracker.addUsage(
        outputModel,
        output.usage?.input || 0,
        output.usage?.output || 0
      );

      // Записываем output usage в бюджет
      if (output.usage) {
        budget.recordUsage(
          'output',
          outputModel,
          output.usage.input || 0,
          output.usage.output || 0
        );
      }

      // Обновляем budgetMetrics (промежуточный snapshot после output)
      output.budgetMetrics = budget.getSnapshot();

      this.emitProgress('output', options.language === 'en' ? 'Report generated' : 'Отчёт сформирован', 88);

      // ═══════════════════════════════════════════════════
      // Phase 5.5: Quality Gate (standard/deep only)
      // ═══════════════════════════════════════════════════
      let qgResult: QualityGateResult | null = null;

      if (mode !== 'simple') {
        this.emitProgress('quality_check', options.language === 'en' ? 'Checking report quality...' : 'Проверка качества отчёта...', 90);
        this.checkAborted();

        // Собираем verified claims для проверки
        const verifiedClaimsForQG = output.claims
          .filter(c => c.status === 'verified' || c.status === 'partially_correct')
          .map(c => ({
            text: c.text,
            confidence: c.confidence,
            sourceIds: c.sourceIds,
          }));

        qgResult = await runQualityGate(
          output.report,
          verifiedClaimsForQG,
          { mode, requestId: this.requestId, budgetManager: budget }
        );

        // Записываем QG usage в UsageTracker
        if (qgResult?.usage) {
          this.usageTracker.addOpenAIUsage(
            config.qualityGateModel,
            qgResult.usage.input,
            qgResult.usage.output
          );
        }
      }

      // Post-processing: Quality Gate actions
      if (qgResult && !qgResult.passed) {
        const originalGrade = output.grade;
        output.grade = downgradeGrade(originalGrade);

        // Штраф 15% на compositeScore
        output.quality.compositeScore = Math.round(output.quality.compositeScore * 0.85 * 100) / 100;
        output.quality.grade = output.grade;

        // Добавляем предупреждение к отчёту
        const qgWarning = options.language === 'ru'
          ? `> ⚠️ **Проверка качества** обнаружила утверждения, не полностью подтверждённые источниками (${qgResult.unfaithfulStatements.length} шт.). Грейд понижен.\n\n`
          : `> ⚠️ **Quality check** found statements not fully supported by sources (${qgResult.unfaithfulStatements.length}). Grade downgraded.\n\n`;

        output.report = qgWarning + output.report;

        this.log.warn('Quality Gate failed, grade downgraded', {
          original_grade: originalGrade,
          new_grade: output.grade,
          faithfulness_score: qgResult.faithfulnessScore,
          unfaithful_count: qgResult.unfaithfulStatements.length,
        });
      }

      // Persist QG result в output
      output.qualityGate = qgResult ? {
        passed: qgResult.passed,
        faithfulnessScore: qgResult.faithfulnessScore,
        unfaithfulCount: qgResult.unfaithfulStatements.length,
      } : null;

      // ═══════════════════════════════════════════════════
      // Warnings — формирование массива предупреждений
      // ═══════════════════════════════════════════════════
      const warnings: string[] = [];

      if (output.grade === 'F') {
        warnings.push('INSUFFICIENT_DATA');
      }
      if (output.grade === 'C' && mode !== 'deep') {
        warnings.push('SUGGEST_DEEPER_MODE');
      }
      if (qgResult && !qgResult.passed) {
        warnings.push('QUALITY_GATE_FAILED');
      }

      output.warnings = warnings;

      // ═══════════════════════════════════════════════════
      // Числовое логирование — статистика numerical claims
      // ═══════════════════════════════════════════════════
      const numericalClaims = verificationResults.claims.filter(c => c.type === 'numerical');
      if (numericalClaims.length > 0) {
        this.log.info('Numerical claims statistics', {
          total_numerical_claims: numericalClaims.length,
          verified_numerical: numericalClaims.filter(c => {
            const vr = verificationResults.allResults.find(r => r.claimId === c.id);
            return vr && vr.status === 'verified';
          }).length,
        });
      }

      this.emitProgress('quality_check', options.language === 'en' ? 'Quality check complete' : 'Проверка качества завершена', 94);

      // Финально обновляем budgetMetrics (включает QG costs)
      output.budgetMetrics = budget.getSnapshot();

      this.emitProgress('output', options.language === 'en' ? 'Report ready!' : 'Отчёт готов!', 100);

      // ═══════════════════════════════════════════════════
      // Формируем финальный результат
      // ═══════════════════════════════════════════════════
      const duration = Date.now() - startTime;
      const usageData = this.calculateUsageData(budget);

      // Логируем итого бюджета
      const finalSnapshot = budget.getSnapshot();
      this.log.info('Budget summary', {
        mode,
        used_tokens: finalSnapshot.consumed.totalTokens,
        max_tokens: finalSnapshot.limits.maxTokens,
        used_cost_usd: finalSnapshot.consumed.totalCostUsd,
        max_cost_usd: finalSnapshot.limits.maxCostUsd,
        circuit_breaker_triggered: finalSnapshot.circuitBreaker.triggered,
        degradations: finalSnapshot.degradations,
      });

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

      // Emit completed event
      const completeEvent: ResearchEvent = {
        type: 'completed',
        research_id: this.researchId,
        result: output,
        quality: output.quality,
      };
      this.emit('event', completeEvent);

      this.log.info('Research completed', {
        duration_ms: duration,
        mode,
        quality_score: output.quality.compositeScore,
        grade: output.grade,
        facts_verified: output.quality.facts.verified,
        facts_total: output.quality.facts.total,
        sources_total: sourceRegistry.getCount(),
        is_partial: isPartial,
        verification_level: verificationResults.verificationLevel,
        quality_gate_passed: qgResult?.passed ?? null,
        faithfulness_score: qgResult?.faithfulnessScore ?? null,
        warnings: output.warnings,
      });

      // ═══════════════════════════════════════════════════
      // Автосбор статистики (fire-and-forget)
      // ═══════════════════════════════════════════════════
      saveResearchStats({
        timestamp: new Date().toISOString(),
        requestId: this.requestId,
        mode,
        queryWordCount: query.split(/\s+/).length,
        preTriageFloor: triageResult.preTriageFloor,
        finalMode: mode,
        totalClaims: verificationResults.claims.length,
        verifiedClaims: verificationResults.verified.length,
        partiallyCorrectClaims: verificationResults.partiallyCorrect.length,
        omittedClaims: verificationResults.claims.length - verificationResults.verified.length - verificationResults.partiallyCorrect.length - verificationResults.incorrect.length - verificationResults.unverifiable.length,
        numericalClaims: verificationResults.claims.filter(c => c.type === 'numerical').length,
        sourcesTotal: sourceRegistry.getAllSources().length,
        sourcesAvailable: sourceRegistry.getAllSources().filter(s => s.status === 'available' || s.status === 'unchecked').length,
        compositeScore: output.quality.compositeScore,
        grade: output.grade,
        qualityGatePassed: qgResult?.passed ?? null,
        faithfulnessScore: qgResult?.faithfulnessScore ?? null,
        totalCostUsd: finalSnapshot.consumed.totalCostUsd,
        durationMs: duration,
        verificationLevel: verificationResults.verificationLevel,
        goldenSet: this.requestId.startsWith('gs-'),
      }).catch(() => {}); // Игнорируем ошибки

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
  private calculateUsageData(budget?: TokenBudgetManager): UsageData {
    const usage = this.usageTracker.getUsage();
    const perplexityUsage = this.usageTracker.getPerplexityUsage();
    const openaiUsage = this.usageTracker.getOpenAIUsage();
    const stats = this.usageTracker.getTotalStats();

    // Цены (USD за токен)
    const prices: Record<string, { input: number; output: number }> = {
      'claude-sonnet-4-20250514': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
      'claude-haiku-4-5-20251001': { input: 1 / 1_000_000, output: 5 / 1_000_000 },
      'gpt-4.1-nano': { input: 0.1 / 1_000_000, output: 0.4 / 1_000_000 },
      'gpt-4.1-mini': { input: 0.4 / 1_000_000, output: 1.6 / 1_000_000 },
    };

    let totalCost = 0;
    const byModel: UsageData['byModel'] = [];

    // Claude usage
    for (const [model, tokens] of Object.entries(usage)) {
      const modelPrices = prices[model] || prices['claude-sonnet-4-20250514'];
      const cost = tokens.inputTokens * modelPrices.input + tokens.outputTokens * modelPrices.output;
      totalCost += cost;

      byModel.push({
        model,
        provider: 'anthropic',
        input: tokens.inputTokens,
        output: tokens.outputTokens,
        cost,
      });
    }

    // OpenAI usage
    for (const [model, tokens] of Object.entries(openaiUsage)) {
      const modelPrices = prices[model] || prices['gpt-4.1-nano'];
      const cost = tokens.inputTokens * modelPrices.input + tokens.outputTokens * modelPrices.output;
      totalCost += cost;

      byModel.push({
        model,
        provider: 'openai',
        input: tokens.inputTokens,
        output: tokens.outputTokens,
        cost,
      });
    }

    // Perplexity usage (с search context tokens)
    for (const [model, tokens] of Object.entries(perplexityUsage)) {
      totalCost += tokens.totalCost;

      byModel.push({
        model,
        provider: 'perplexity',
        input: tokens.inputTokens,
        output: tokens.outputTokens,
        cost: tokens.totalCost,
      });
    }

    // Логируем суммарную статистику
    this.log.info('Research usage summary', {
      total_input_tokens: stats.input,
      total_output_tokens: stats.output,
      perplexity_search_context_tokens: stats.searchContextTokens,
      perplexity_cost_usd: stats.perplexityCost,
      perplexity_requests: stats.perplexityRequests,
      openai_cost_usd: stats.openaiCost,
      total_cost_usd: totalCost,
      by_model: byModel,
      budget_used_pct: budget ? (() => { const s = budget.getSnapshot(); return s.limits.maxTokens > 0 ? (s.consumed.totalTokens / s.limits.maxTokens) * 100 : 0; })() : undefined,
    });

    return {
      totalInputTokens: stats.input,
      totalOutputTokens: stats.output,
      totalCostUsd: totalCost,
      byModel,
      apiCalls: stats.perplexityRequests +
        byModel.filter(m => m.provider === 'anthropic').length +
        byModel.filter(m => m.provider === 'openai').length,
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

/**
 * Определяет завершённые фазы по snapshot бюджета
 */
function getCompletedPhases(snapshot: BudgetSnapshot): string[] {
  const completed: string[] = ['triage', 'clarification', 'planning'];
  if (snapshot.byPhase) {
    if (snapshot.byPhase.research && snapshot.byPhase.research.calls > 0) completed.push('research');
    if (snapshot.byPhase.verification && snapshot.byPhase.verification.calls > 0) completed.push('verification');
    if (snapshot.byPhase.output && snapshot.byPhase.output.calls > 0) completed.push('output');
  }
  return completed;
}

/**
 * Определяет пропущенные фазы
 */
function getSkippedPhases(
  snapshot: BudgetSnapshot,
  verificationLevel: 'full' | 'simplified' | 'skipped'
): string[] {
  const skipped: string[] = [];
  if (verificationLevel === 'skipped') skipped.push('verification');
  if (verificationLevel === 'simplified') skipped.push('deep_check');
  return skipped;
}
