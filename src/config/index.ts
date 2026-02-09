/**
 * @file src/config/index.ts
 * @description Конфигурация модуля m004 NeurA Research
 * @context Используется всеми компонентами для доступа к настройкам
 */

import dotenv from 'dotenv';
import path from 'path';

// Загружаем .env файл
dotenv.config();

export const config = {
  // Module
  module: {
    id: process.env.MODULE_ID || 'm004',
    version: process.env.MODULE_VERSION || '1.0.0',
    name: process.env.MODULE_NAME || 'NeurA Research',
  },
  port: parseInt(process.env.PORT || '3004', 10),
  env: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',

  // Backwards compatibility
  moduleId: process.env.MODULE_ID || 'm004',
  moduleVersion: process.env.MODULE_VERSION || '1.0.0',
  moduleName: process.env.MODULE_NAME || 'NeurA Research',
  nodeEnv: process.env.NODE_ENV || 'development',

  // CORS
  cors: {
    origins: (process.env.CORS_ORIGINS || '*').split(',').map(o => o.trim()),
  },

  // CORE Integration
  coreApiUrl: process.env.CORE_API_URL || 'http://neura-core:8000',
  coreApiKey: process.env.CORE_API_KEY || '',

  // Internal API
  internalApiKey: process.env.INTERNAL_API_KEY || '',

  // AI Providers
  perplexityApiKey: process.env.PERPLEXITY_API_KEY || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',

  // Models
  perplexityModel: process.env.PERPLEXITY_MODEL || 'sonar-pro',
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
  openaiModelTriage: process.env.OPENAI_MODEL_TRIAGE || 'gpt-4.1-nano',
  openaiModelClaimDecomposition: process.env.OPENAI_MODEL_CLAIM_DECOMPOSITION || 'gpt-4.1-mini',
  openaiModelDeepCheck: process.env.OPENAI_MODEL_DEEP_CHECK || 'gpt-4.1-nano',

  // Storage
  dataPath: process.env.DATA_PATH || path.join(process.cwd(), 'data'),
  retentionDays: parseInt(process.env.RETENTION_DAYS || '7', 10),

  // Quality settings
  defaultConfidenceThreshold: parseFloat(process.env.DEFAULT_CONFIDENCE_THRESHOLD || '0.80'),
  maxQuestionsSimple: parseInt(process.env.MAX_QUESTIONS_SIMPLE || '3', 10),
  maxQuestionsStandard: parseInt(process.env.MAX_QUESTIONS_STANDARD || '5', 10),
  maxQuestionsDeep: parseInt(process.env.MAX_QUESTIONS_DEEP || '10', 10),

  // Budget limits
  budgetSimpleMaxCostUsd: parseFloat(process.env.BUDGET_SIMPLE_MAX_COST_USD || '0.30'),
  budgetSimpleMaxTokens: parseInt(process.env.BUDGET_SIMPLE_MAX_TOKENS || '50000', 10),
  budgetStandardMaxCostUsd: parseFloat(process.env.BUDGET_STANDARD_MAX_COST_USD || '1.00'),
  budgetStandardMaxTokens: parseInt(process.env.BUDGET_STANDARD_MAX_TOKENS || '200000', 10),
  budgetDeepMaxCostUsd: parseFloat(process.env.BUDGET_DEEP_MAX_COST_USD || '5.00'),
  budgetDeepMaxTokens: parseInt(process.env.BUDGET_DEEP_MAX_TOKENS || '500000', 10),

  // Circuit Breaker thresholds (%)
  circuitBreakerWarning: parseInt(process.env.CIRCUIT_BREAKER_WARNING || '70', 10),
  circuitBreakerCritical: parseInt(process.env.CIRCUIT_BREAKER_CRITICAL || '85', 10),
  circuitBreakerStop: parseInt(process.env.CIRCUIT_BREAKER_STOP || '93', 10),

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  logFormat: process.env.LOG_FORMAT || 'json',

  // Paths
  get logsPath() {
    return this.isDev ? path.join(process.cwd(), 'logs') : '/app/logs';
  },
  get databasePath() {
    return path.join(this.dataPath, 'database.sqlite');
  },
};

export default config;

// Re-export domain and prompt configurations
export * from './domains';
export * from './prompts';
