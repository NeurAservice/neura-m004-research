/**
 * @file src/services/budget.ts
 * @description TokenBudgetManager — контроль потребления токенов и стоимости
 * @context Создаётся на каждый research-запрос, передаётся через все фазы pipeline
 * @dependencies config/index.ts
 * @affects Все фазы pipeline: triage, planning, research, verification, output
 */

import { logger } from '../utils/logger';

// ============================================
// Типы
// ============================================

export type BudgetAction = 'proceed' | 'reduce' | 'stop';
export type BudgetStatus = 'normal' | 'warning' | 'critical' | 'stop';
export type BudgetPhase = 'triage' | 'planning' | 'research' | 'verification' | 'output';
export type ResearchModeForBudget = 'simple' | 'standard' | 'deep';

export interface BudgetLimits {
  maxTokens: number;
  maxCostUsd: number;
}

export interface PhaseUsage {
  tokens: number;
  costUsd: number;
  budgetPct: number;
  usedPct: number;
  calls: number;
}

export interface BudgetSnapshot {
  mode: ResearchModeForBudget;
  limits: BudgetLimits;
  consumed: {
    totalTokens: number;
    totalCostUsd: number;
  };
  byPhase: Record<string, PhaseUsage>;
  circuitBreaker: {
    triggered: boolean;
    level?: 'warning' | 'critical' | 'stop';
    triggeredAtPct: number;
  };
  degradations: string[];
}

export interface CircuitBreakerConfig {
  warningPct: number;
  criticalPct: number;
  stopPct: number;
}

// ============================================
// Константы
// ============================================

/** Распределение бюджета по фазам (%) */
const BUDGET_ALLOCATION: Record<ResearchModeForBudget, Record<BudgetPhase, number>> = {
  simple:   { triage: 3,  planning: 12, research: 55, verification: 23, output: 7 },
  standard: { triage: 2,  planning: 10, research: 50, verification: 31, output: 7 },
  deep:     { triage: 1,  planning: 8,  research: 52, verification: 33, output: 6 },
};

/** Потолки токенов на одиночный вызов */
const CALL_TOKEN_CAPS: Record<string, number> = {
  triage: 1000,
  planning: 3000,
  research: 4000,
  claimDecomposition: 3000,
  deepCheck: 500,
  output: 8000,
};

/** Цены моделей за токен (USD) */
const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-20250514': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'gpt-4.1-nano':            { input: 0.1 / 1_000_000, output: 0.4 / 1_000_000 },
  'gpt-4.1-mini':            { input: 0.4 / 1_000_000, output: 1.6 / 1_000_000 },
};

/** Порядок фаз для перетекания бюджета */
const PHASE_ORDER: BudgetPhase[] = ['triage', 'planning', 'research', 'verification', 'output'];

/** Максимальное превышение фазового бюджета (30%) */
const PHASE_OVERSHOOT_FACTOR = 1.3;

/** Порог для reduce (фаза использовала >60% своего бюджета) */
const PHASE_REDUCE_THRESHOLD = 0.6;

// ============================================
// TokenBudgetManager
// ============================================

export class TokenBudgetManager {
  private mode: ResearchModeForBudget;
  private limits: BudgetLimits;
  private circuitBreakerConfig: CircuitBreakerConfig;

  /** Расход по фазам */
  private phaseUsage: Record<BudgetPhase, { tokens: number; costUsd: number; calls: number }>;

  /** Бонусные токены от предыдущих фаз (перетекание) */
  private phaseBonus: Record<BudgetPhase, { tokens: number; costUsd: number }>;

  /** Глобальный статус circuit breaker */
  private cbTriggered: boolean = false;
  private cbLevel?: 'warning' | 'critical' | 'stop';
  private cbTriggeredAtPct: number = 0;

  /** Список применённых деградаций */
  private degradations: Set<string> = new Set();

  /** Текущая активная фаза */
  private currentPhase?: BudgetPhase;

  /** ID запроса для логирования */
  private requestId?: string;

  constructor(
    mode: ResearchModeForBudget,
    limits: BudgetLimits,
    circuitBreaker: CircuitBreakerConfig,
    requestId?: string
  ) {
    this.mode = mode;
    this.limits = { ...limits };
    this.circuitBreakerConfig = { ...circuitBreaker };
    this.requestId = requestId;

    // Инициализируем расход по фазам
    this.phaseUsage = {
      triage: { tokens: 0, costUsd: 0, calls: 0 },
      planning: { tokens: 0, costUsd: 0, calls: 0 },
      research: { tokens: 0, costUsd: 0, calls: 0 },
      verification: { tokens: 0, costUsd: 0, calls: 0 },
      output: { tokens: 0, costUsd: 0, calls: 0 },
    };

    // Инициализируем бонусы
    this.phaseBonus = {
      triage: { tokens: 0, costUsd: 0 },
      planning: { tokens: 0, costUsd: 0 },
      research: { tokens: 0, costUsd: 0 },
      verification: { tokens: 0, costUsd: 0 },
      output: { tokens: 0, costUsd: 0 },
    };

    logger.info('TokenBudgetManager created', {
      request_id: requestId,
      mode,
      maxTokens: limits.maxTokens,
      maxCostUsd: limits.maxCostUsd,
      allocation: BUDGET_ALLOCATION[mode],
    });
  }

  // ============================================
  // Публичные методы
  // ============================================

  /**
   * Начинает фазу (переносит неиспользованный бюджет от предыдущей)
   */
  startPhase(phase: BudgetPhase): void {
    // Если была предыдущая фаза — перенести остаток
    if (this.currentPhase && this.currentPhase !== phase) {
      this.transferRemainingBudget(this.currentPhase, phase);
    }
    this.currentPhase = phase;

    logger.debug('Budget phase started', {
      request_id: this.requestId,
      phase,
      allocated_tokens: this.getPhaseTokenBudget(phase),
      allocated_cost: this.getPhaseCostBudget(phase),
      total_spent_pct: this.getTotalSpentPct(),
    });
  }

  /**
   * Записывает расход после API-вызова
   * @param phase - Фаза, к которой относится вызов
   * @param model - Модель (для расчёта стоимости)
   * @param inputTokens - Входные токены
   * @param outputTokens - Выходные токены
   * @param directCostUsd - Прямая стоимость (для Perplexity, где cost из response)
   */
  recordUsage(
    phase: BudgetPhase,
    model: string,
    inputTokens: number,
    outputTokens: number,
    directCostUsd?: number
  ): void {
    const tokens = inputTokens + outputTokens;
    const costUsd = directCostUsd ?? this.calculateCost(model, inputTokens, outputTokens);

    this.phaseUsage[phase].tokens += tokens;
    this.phaseUsage[phase].costUsd += costUsd;
    this.phaseUsage[phase].calls += 1;

    // Проверяем circuit breaker
    this.checkCircuitBreaker();

    logger.debug('Budget usage recorded', {
      request_id: this.requestId,
      phase,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      phase_tokens_used: this.phaseUsage[phase].tokens,
      phase_cost_used: this.phaseUsage[phase].costUsd,
      total_spent_pct: this.getTotalSpentPct(),
      status: this.getGlobalStatus(),
    });
  }

  /**
   * Проверяет, может ли фаза продолжать
   * @returns 'proceed' | 'reduce' | 'stop'
   */
  canContinue(phase: BudgetPhase): BudgetAction {
    // STOP: глобальный circuit breaker ≥ STOP
    if (this.cbLevel === 'stop') {
      return 'stop';
    }

    // STOP: фаза превысила 130% своего бюджета
    const phaseUsedPct = this.getPhaseUsedPct(phase);
    if (phaseUsedPct > PHASE_OVERSHOOT_FACTOR) {
      return 'stop';
    }

    // STOP: глобальный CRITICAL (85%) — для research и verification
    if (this.cbLevel === 'critical' && (phase === 'research' || phase === 'verification')) {
      return 'stop';
    }

    // REDUCE: фаза использовала >60% ИЛИ глобальный WARNING
    if (phaseUsedPct > PHASE_REDUCE_THRESHOLD || this.cbLevel === 'warning') {
      return 'reduce';
    }

    return 'proceed';
  }

  /**
   * Вычисляет max_tokens для следующего API-вызова
   * @param callType - Тип вызова (triage, planning, research, claimDecomposition, deepCheck, output)
   */
  getMaxTokensForCall(callType: string): number {
    const phase = this.callTypeToPhase(callType);
    const cap = CALL_TOKEN_CAPS[callType] || 4000;
    const phaseRemaining = this.getPhaseRemainingTokens(phase);
    const globalRemaining = this.getGlobalRemainingTokens();

    return Math.max(100, Math.min(cap, phaseRemaining, globalRemaining));
  }

  /**
   * Возвращает глобальный статус бюджета
   */
  getGlobalStatus(): BudgetStatus {
    if (this.cbLevel) return this.cbLevel;
    return 'normal';
  }

  /**
   * Возвращает процент использования общего бюджета
   */
  getTotalSpentPct(): number {
    const tokensPct = this.getTotalTokensSpent() / this.limits.maxTokens;
    const costPct = this.getTotalCostSpent() / this.limits.maxCostUsd;
    return Math.max(tokensPct, costPct);
  }

  /**
   * Возвращает суммарный расход токенов
   */
  getTotalTokensSpent(): number {
    return Object.values(this.phaseUsage).reduce((sum, p) => sum + p.tokens, 0);
  }

  /**
   * Возвращает суммарный расход в USD
   */
  getTotalCostSpent(): number {
    return Object.values(this.phaseUsage).reduce((sum, p) => sum + p.costUsd, 0);
  }

  /**
   * Добавляет деградацию в список
   */
  addDegradation(degradation: string): void {
    this.degradations.add(degradation);
    logger.info('Budget degradation applied', {
      request_id: this.requestId,
      degradation,
      total_spent_pct: this.getTotalSpentPct(),
    });
  }

  /**
   * Возвращает полный snapshot бюджета для метрик
   */
  getSnapshot(): BudgetSnapshot {
    const byPhase: Record<string, PhaseUsage> = {};

    for (const phase of PHASE_ORDER) {
      const allocation = BUDGET_ALLOCATION[this.mode][phase];
      const usage = this.phaseUsage[phase];
      const budgetTokens = this.getPhaseTokenBudget(phase);

      byPhase[phase] = {
        tokens: usage.tokens,
        costUsd: usage.costUsd,
        budgetPct: allocation,
        usedPct: budgetTokens > 0 ? usage.tokens / budgetTokens : 0,
        calls: usage.calls,
      };
    }

    return {
      mode: this.mode,
      limits: { ...this.limits },
      consumed: {
        totalTokens: this.getTotalTokensSpent(),
        totalCostUsd: this.getTotalCostSpent(),
      },
      byPhase,
      circuitBreaker: {
        triggered: this.cbTriggered,
        level: this.cbLevel,
        triggeredAtPct: this.cbTriggeredAtPct,
      },
      degradations: Array.from(this.degradations),
    };
  }

  /**
   * Возвращает режим бюджета
   */
  getMode(): ResearchModeForBudget {
    return this.mode;
  }

  // ============================================
  // Приватные методы
  // ============================================

  /**
   * Вычисляет стоимость вызова по модели и токенам
   */
  private calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const prices = MODEL_PRICES[model];
    if (!prices) {
      // Fallback — цена Claude Sonnet
      const fallback = MODEL_PRICES['claude-sonnet-4-20250514'];
      return inputTokens * fallback.input + outputTokens * fallback.output;
    }
    return inputTokens * prices.input + outputTokens * prices.output;
  }

  /**
   * Возвращает токеновый бюджет фазы (базовый + бонус)
   */
  private getPhaseTokenBudget(phase: BudgetPhase): number {
    const pct = BUDGET_ALLOCATION[this.mode][phase] / 100;
    const base = this.limits.maxTokens * pct;
    const bonus = this.phaseBonus[phase].tokens;
    return base + bonus;
  }

  /**
   * Возвращает долларовый бюджет фазы (базовый + бонус)
   */
  private getPhaseCostBudget(phase: BudgetPhase): number {
    const pct = BUDGET_ALLOCATION[this.mode][phase] / 100;
    const base = this.limits.maxCostUsd * pct;
    const bonus = this.phaseBonus[phase].costUsd;
    return base + bonus;
  }

  /**
   * Возвращает процент использования фазового бюджета (максимум из tokens и cost)
   */
  private getPhaseUsedPct(phase: BudgetPhase): number {
    const tokenBudget = this.getPhaseTokenBudget(phase);
    const costBudget = this.getPhaseCostBudget(phase);

    const tokenPct = tokenBudget > 0 ? this.phaseUsage[phase].tokens / tokenBudget : 0;
    const costPct = costBudget > 0 ? this.phaseUsage[phase].costUsd / costBudget : 0;

    return Math.max(tokenPct, costPct);
  }

  /**
   * Возвращает оставшиеся токены в фазе (с учётом 130% overshoot)
   */
  private getPhaseRemainingTokens(phase: BudgetPhase): number {
    const budget = this.getPhaseTokenBudget(phase) * PHASE_OVERSHOOT_FACTOR;
    return Math.max(0, budget - this.phaseUsage[phase].tokens);
  }

  /**
   * Возвращает оставшиеся токены глобально
   */
  private getGlobalRemainingTokens(): number {
    return Math.max(0, this.limits.maxTokens - this.getTotalTokensSpent());
  }

  /**
   * Переносит остаток бюджета от завершённой фазы к следующей
   */
  private transferRemainingBudget(fromPhase: BudgetPhase, toPhase: BudgetPhase): void {
    const tokenBudget = this.getPhaseTokenBudget(fromPhase);
    const costBudget = this.getPhaseCostBudget(fromPhase);
    const tokensUsed = this.phaseUsage[fromPhase].tokens;
    const costUsed = this.phaseUsage[fromPhase].costUsd;

    const tokensSaved = Math.max(0, tokenBudget - tokensUsed);
    const costSaved = Math.max(0, costBudget - costUsed);

    if (tokensSaved > 0 || costSaved > 0) {
      this.phaseBonus[toPhase].tokens += tokensSaved;
      this.phaseBonus[toPhase].costUsd += costSaved;

      logger.debug('Budget transferred between phases', {
        request_id: this.requestId,
        from: fromPhase,
        to: toPhase,
        tokens_saved: tokensSaved,
        cost_saved: costSaved,
      });
    }
  }

  /**
   * Проверяет глобальные пороги circuit breaker
   */
  private checkCircuitBreaker(): void {
    const spentPct = this.getTotalSpentPct() * 100;

    if (spentPct >= this.circuitBreakerConfig.stopPct && this.cbLevel !== 'stop') {
      this.cbTriggered = true;
      this.cbLevel = 'stop';
      this.cbTriggeredAtPct = spentPct;
      logger.warn('Circuit breaker STOP triggered', {
        request_id: this.requestId,
        spent_pct: spentPct,
        threshold: this.circuitBreakerConfig.stopPct,
      });
    } else if (spentPct >= this.circuitBreakerConfig.criticalPct && this.cbLevel !== 'stop' && this.cbLevel !== 'critical') {
      this.cbTriggered = true;
      this.cbLevel = 'critical';
      this.cbTriggeredAtPct = spentPct;
      logger.warn('Circuit breaker CRITICAL triggered', {
        request_id: this.requestId,
        spent_pct: spentPct,
        threshold: this.circuitBreakerConfig.criticalPct,
      });
    } else if (spentPct >= this.circuitBreakerConfig.warningPct && !this.cbLevel) {
      this.cbTriggered = true;
      this.cbLevel = 'warning';
      this.cbTriggeredAtPct = spentPct;
      logger.warn('Circuit breaker WARNING triggered', {
        request_id: this.requestId,
        spent_pct: spentPct,
        threshold: this.circuitBreakerConfig.warningPct,
      });
    }
  }

  /**
   * Маппинг типа вызова на фазу
   */
  private callTypeToPhase(callType: string): BudgetPhase {
    switch (callType) {
      case 'triage': return 'triage';
      case 'planning': return 'planning';
      case 'research': return 'research';
      case 'claimDecomposition':
      case 'deepCheck':
        return 'verification';
      case 'output': return 'output';
      default: return 'research';
    }
  }
}

export default TokenBudgetManager;
