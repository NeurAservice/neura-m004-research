/**
 * @file src/types/research.ts
 * @description Типы для исследований
 * @context Основные интерфейсы для pipeline исследований
 */

// ============================================
// Базовые типы
// ============================================

export type QueryType = 'factual' | 'analytical' | 'speculative' | 'mixed';
export type ResearchMode = 'simple' | 'standard' | 'deep';
export type ModeSource = 'auto' | 'user';
export type ResearchType = 'facts_only' | 'facts_and_analysis' | 'full';
export type ReportLength = 'short' | 'medium' | 'long';
export type ClaimStatus = 'verified' | 'partially_correct' | 'incorrect' | 'unverifiable' | 'omitted';
export type ClaimType = 'factual' | 'numerical' | 'analytical' | 'speculative';
export type ResearchStatus = 'pending' | 'in_progress' | 'clarification_needed' | 'completed' | 'failed' | 'cancelled';

// ============================================
// Options и настройки
// ============================================

export interface ResearchOptions {
  mode: ResearchMode | 'auto';
  researchType: ResearchType;
  includeUnverified: boolean;
  confidenceThreshold: number;
  language: 'ru' | 'en';
  maxReportLength: ReportLength;
  maxCost?: number; // Пользовательский лимит стоимости (для deep)
}

export const DEFAULT_OPTIONS: ResearchOptions = {
  mode: 'auto',
  researchType: 'facts_and_analysis',
  includeUnverified: false,
  confidenceThreshold: 0.80,
  language: 'ru',
  maxReportLength: 'medium',
};

// ============================================
// Triage (Phase 0)
// ============================================

export interface TriageResult {
  queryType: QueryType;
  mode: ResearchMode;
  modeSource: ModeSource;
  estimatedQuestions: number;
  estimatedCost: { min: number; max: number };
  estimatedDuration: { min: number; max: number }; // секунды
  preTriageFloor: ResearchMode;
  preTriageReasons: string[];
}

// ============================================
// Clarification (Phase 1)
// ============================================

export interface ClarificationResult {
  status: 'ready' | 'needs_clarification';
  questions?: string[];
  clarifiedQuery?: string;
}

// ============================================
// Planning (Phase 2)
// ============================================

export interface ResearchQuestion {
  id: number;
  text: string;
  type: ClaimType;
  priority: number;
  expectedFactTypes: string[];
  topic: string;
}

export interface VerificationRequirement {
  minSources: number;
  requiredSourceTypes: string[];
  freshnessRequired: boolean;
}

export interface PlanningResult {
  questions: ResearchQuestion[];
  scope: string;
  factTypes: string[];
  verificationStrategy: Record<string, VerificationRequirement>;
}

// ============================================
// Research (Phase 3)
// ============================================

export interface Citation {
  url: string;
  title: string;
  snippet: string;
  authorityScore: number;
  date?: string;
  domain: string;
}

export interface ResearchQuestionResult {
  questionId: number;
  response: string;
  citations: Citation[];
  searchResults: Array<{ title: string; url: string; date?: string }>;
  citationMapping: Map<number, number>; // perplexityCitIndex → sourceRegistryId
  tokensUsed: { input: number; output: number; searchContextTokens: number; totalCost: number };
  hasGroundedContent: boolean; // false если citations пустые
}

// ============================================
// Verification (Phase 4)
// ============================================

export interface AtomicClaim {
  id: number;
  text: string;
  type: ClaimType;
  sourceQuestionId: number;
  originalContext: string;
  // Новые поля для numerical claims:
  value?: number;
  unit?: string;
  sourceIndex?: number | null; // индекс [N] из текста Perplexity
  sourceIds: number[]; // IDs из SourceRegistry
}

export interface VerificationResult {
  claimId: number;
  status: ClaimStatus;
  confidence: number;
  correction?: string;
  verificationSources: Citation[];
  explanation?: string;
}

// ============================================
// Output (Phase 5)
// ============================================

export interface Claim {
  id: number;
  text: string;
  type: ClaimType;
  status: ClaimStatus;
  confidence: number;
  correction?: string;
  sourceIds: number[];
  omitReason?: string;
  // Новые поля для numerical claims:
  value?: number;
  unit?: string;
}

export interface Source {
  id: number;
  url: string;
  title: string;
  domain: string;
  authority: number;
  date?: string;
  usedInClaims: number[];
  isAvailable?: boolean;
}

export interface QualityMetrics {
  compositeScore: number;
  grade: 'A' | 'B' | 'C' | 'F';
  verificationPassRate: number;
  omissionRate: number;
  citationCoverage: number;
  sourceAuthorityScore: number;
  correctionRate: number;
  facts: {
    total: number;
    verified: number;
    partiallyCorrect: number;
    unverified: number;
    omitted: number;
    numerical: number;
  };
  sourcesCount: number;
}

export interface UsageData {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byModel: Array<{
    model: string;
    provider: string;
    input: number;
    output: number;
    cost: number;
  }>;
  apiCalls: number;
}

export interface ResearchMetadata {
  mode: ResearchMode;
  queryType: QueryType;
  language: string;
  createdAt: string;
  completedAt?: string;
  duration_ms?: number;
  pipeline_version: string;
}

export interface PartialCompletion {
  isPartial: boolean;
  coveredQuestions: number;
  plannedQuestions: number;
  completedPhases: string[];
  skippedPhases: string[];
  verificationLevel: 'full' | 'simplified' | 'skipped';
  circuitBreakerTriggered: boolean;
  circuitBreakerLevel?: 'warning' | 'critical' | 'stop';
}

export interface BudgetMetrics {
  mode: ResearchMode;
  limits: { maxTokens: number; maxCostUsd: number };
  consumed: { totalTokens: number; totalCostUsd: number };
  byPhase: Record<string, {
    tokens: number;
    costUsd: number;
    budgetPct: number;
    usedPct: number;
  }>;
  circuitBreaker: {
    triggered: boolean;
    level?: 'warning' | 'critical' | 'stop';
    triggeredAtPct: number;
  };
  degradations: string[];
}

// ============================================
// Quality Gate (Phase 5.5)
// ============================================

export interface QualityGateResult {
  passed: boolean;
  faithfulnessScore: number; // 0.0 — 1.0
  unfaithfulStatements: Array<{
    text: string;   // Фрагмент отчёта
    reason: string; // Почему не faithful
  }>;
  usage: { input: number; output: number };
}

export interface QualityGateSummary {
  passed: boolean;
  faithfulnessScore: number;
  unfaithfulCount: number;
}

export interface ResearchOutput {
  report: string;
  summary: string;
  claims: Claim[];
  sources: Source[];
  quality: QualityMetrics;
  metadata: ResearchMetadata;
  disclaimer?: string;
  partialCompletion?: PartialCompletion;
  budgetMetrics?: BudgetMetrics;
  grade: 'A' | 'B' | 'C' | 'F';
  warnings: string[];                     // Массив предупреждений для фронтенда
  qualityGate: QualityGateSummary | null;  // Результат Quality Gate
}

// ============================================
// Full Research Result
// ============================================

export interface ResearchResult {
  id: string;
  user_id: string;
  session_id?: string;
  query: string;
  clarifiedQuery?: string;
  options: ResearchOptions;
  status: ResearchStatus;
  progress: number;
  currentPhase?: string;

  // Результат (заполняется по завершении)
  output?: ResearchOutput;

  // Usage для биллинга
  usage?: UsageData;

  // Ошибка (если failed)
  error?: string;

  // Timestamps
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

// ============================================
// Progress Events (SSE)
// ============================================

export interface ProgressEvent {
  type: 'progress';
  phase: string;
  message: string;  // текстовое сообщение о прогрессе
  progress: number;
  details?: Record<string, unknown>;
}

export interface ClarificationEvent {
  type: 'clarification_needed';
  questions: string[];
  research_id: string;
}

export interface CompleteEvent {
  type: 'completed';
  research_id: string;
  result: ResearchOutput;
  quality?: QualityMetrics;
}

export interface ErrorEvent {
  type: 'error';
  error_code: string;
  message: string;
}

export type ResearchEvent = ProgressEvent | ClarificationEvent | CompleteEvent | ErrorEvent;
