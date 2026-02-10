/**
 * @file src/types/api.ts
 * @description Типы для API endpoints
 * @context Интерфейсы запросов и ответов API
 */

import { ResearchOptions, ResearchOutput, UsageData, ResearchStatus } from './research';

// ============================================
// UI API Requests
// ============================================

export interface CreateResearchRequest {
  query: string;
  user_id: string;
  options?: Partial<ResearchOptions>;
  session_id?: string;
  shell_id?: string;
  origin_url?: string;
  skip_clarification?: boolean;
}

export interface ClarifyRequest {
  answers: Record<number, string>;
}

export interface HistoryQuery {
  user_id: string;
  limit?: number;
  offset?: number;
}

export interface ExportQuery {
  format: 'markdown' | 'pdf' | 'json';
}

// ============================================
// Internal API Requests
// ============================================

export interface InternalResearchRequest {
  query: string;
  caller_module: string;
  caller_request_id: string;
  options?: {
    mode?: 'simple' | 'standard';
    researchType?: 'facts_only' | 'facts_and_analysis' | 'full';
    confidenceThreshold?: number;
    language?: 'ru' | 'en';
    maxReportLength?: 'short' | 'medium' | 'long';
    context?: string;
  };
}

// ============================================
// API Responses
// ============================================

export interface ApiResponse<T = unknown> {
  status: 'success' | 'error';
  data?: T;
  error_code?: string;
  message?: string;
  request_id?: string;
}

export interface ResearchStatusResponse {
  status: ResearchStatus;
  progress?: number;
  currentPhase?: string;
  result?: ResearchOutput;
  error?: string;
}

export interface HistoryItem {
  id: string;
  query: string;
  status: ResearchStatus;
  quality_score?: number;
  created_at: string;
  completed_at?: string;
}

export interface HistoryResponse {
  items: HistoryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface InternalResearchResponse {
  status: 'success' | 'error';
  research_id: string;
  result: ResearchOutput;
  usage: {
    total_input_tokens: number;
    total_output_tokens: number;
    models_used: Array<{
      model: string;
      provider: string;
      input_tokens: number;
      output_tokens: number;
    }>;
    estimated_cost_usd: number;
  };
  request_id: string;
}

// ============================================
// Balance API
// ============================================

export interface BalanceResponse {
  balance: number;
  currency: string;
  topup_url?: string;
}
