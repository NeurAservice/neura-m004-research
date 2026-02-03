/**
 * @file src/services/pipeline/output.ts
 * @description Phase 5: Output - синтез финального отчёта
 * @context Формирует итоговый отчёт из верифицированных фактов
 */

import config from '../../config';
import { getAnthropicService } from '../anthropic';
import { logger } from '../../utils/logger';
import { getAuthorityLabel } from '../../config/authority';
import { round, average } from '../../utils/helpers';
import {
  ResearchOutput,
  ResearchOptions,
  PlanningResult,
  ResearchQuestionResult,
  Claim,
  Source,
  QualityMetrics,
} from '../../types/research';

interface VerificationSummary {
  allResults: Array<{
    claimId: number;
    status: string;
    confidence: number;
    correction?: string;
    verificationSources: Array<{ url: string; title: string; domain: string; authorityScore: number }>;
    explanation?: string;
  }>;
  claims: Array<{
    id: number;
    text: string;
    type: string;
    sourceQuestionId: number;
    originalContext: string;
  }>;
  verified: Array<unknown>;
  partiallyCorrect: Array<unknown>;
  incorrect: Array<unknown>;
  unverifiable: Array<unknown>;
}

interface OutputWithUsage extends ResearchOutput {
  usage?: { input: number; output: number };
}

/**
 * Синтезирует финальный output
 */
export async function synthesizeOutput(
  query: string,
  planningResult: PlanningResult,
  researchResults: ResearchQuestionResult[],
  verificationSummary: VerificationSummary,
  options: ResearchOptions,
  requestId?: string
): Promise<OutputWithUsage> {
  const anthropic = getAnthropicService();

  // 1. Фильтруем claims по confidence threshold
  const threshold = options.confidenceThreshold;
  const allClaims: Claim[] = [];
  const sources: Source[] = [];
  const sourceMap = new Map<string, number>(); // url -> id

  // Собираем все sources
  let sourceId = 1;
  for (const result of verificationSummary.allResults) {
    for (const source of result.verificationSources) {
      if (!sourceMap.has(source.url)) {
        sourceMap.set(source.url, sourceId);
        sources.push({
          id: sourceId,
          url: source.url,
          title: source.title,
          domain: source.domain,
          authority: source.authorityScore,
          usedInClaims: [],
        });
        sourceId++;
      }
    }
  }

  // Также собираем sources из research results
  for (const result of researchResults) {
    for (const citation of result.citations) {
      if (!sourceMap.has(citation.url)) {
        sourceMap.set(citation.url, sourceId);
        sources.push({
          id: sourceId,
          url: citation.url,
          title: citation.title,
          domain: citation.domain,
          authority: citation.authorityScore,
          date: citation.date,
          usedInClaims: [],
        });
        sourceId++;
      }
    }
  }

  // Обрабатываем claims
  let omittedCount = 0;

  for (const verification of verificationSummary.allResults) {
    const originalClaim = verificationSummary.claims.find(c => c.id === verification.claimId);
    if (!originalClaim) continue;

    const sourceIds = verification.verificationSources
      .map(s => sourceMap.get(s.url))
      .filter((id): id is number => id !== undefined);

    // Обновляем usedInClaims в sources
    for (const sid of sourceIds) {
      const source = sources.find(s => s.id === sid);
      if (source) {
        source.usedInClaims.push(verification.claimId);
      }
    }

    const shouldInclude =
      verification.confidence >= threshold ||
      (options.includeUnverified && verification.status === 'unverifiable') ||
      originalClaim.type === 'speculative';

    if (shouldInclude) {
      allClaims.push({
        id: verification.claimId,
        text: verification.correction || originalClaim.text,
        type: originalClaim.type as 'factual' | 'analytical' | 'speculative',
        status: verification.status as Claim['status'],
        confidence: verification.confidence,
        correction: verification.correction,
        sourceIds,
      });
    } else {
      omittedCount++;

      if (options.includeUnverified) {
        allClaims.push({
          id: verification.claimId,
          text: originalClaim.text,
          type: originalClaim.type as 'factual' | 'analytical' | 'speculative',
          status: 'omitted',
          confidence: verification.confidence,
          sourceIds: [],
          omitReason: `Confidence ${(verification.confidence * 100).toFixed(0)}% below threshold ${(threshold * 100).toFixed(0)}%`,
        });
      }
    }
  }

  // 2. Вычисляем метрики качества
  const quality = calculateQualityMetrics(
    verificationSummary,
    allClaims,
    sources,
    omittedCount
  );

  // 3. Генерируем отчёт
  const verifiedClaims = allClaims
    .filter(c => c.status === 'verified' || c.status === 'partially_correct')
    .map(c => ({
      text: c.text,
      confidence: c.confidence,
      sources: c.sourceIds.map(id => `[${id}]`),
    }));

  const questionsWithResponses = planningResult.questions.map(q => {
    const result = researchResults.find(r => r.questionId === q.id);
    return {
      text: q.text,
      response: result?.response || 'No response',
    };
  });

  const reportResult = await anthropic.synthesizeReport(
    {
      query,
      questions: questionsWithResponses,
      verifiedClaims,
      language: options.language,
      maxLength: options.maxReportLength,
    },
    requestId
  );

  // 4. Генерируем disclaimer если много omitted
  const omittedRate = verificationSummary.claims.length > 0
    ? omittedCount / verificationSummary.claims.length
    : 0;

  let disclaimer: string | undefined;
  if (omittedRate > 0.3) {
    disclaimer = options.language === 'ru'
      ? `⚠️ **Примечание:** Часть найденной информации (${(omittedRate * 100).toFixed(0)}%) была исключена из отчёта, так как не удалось подтвердить её достоверность. Отчёт содержит только верифицированные факты.`
      : `⚠️ **Note:** Part of the found information (${(omittedRate * 100).toFixed(0)}%) was excluded from the report as it could not be verified. The report contains only verified facts.`;
  }

  // 5. Добавляем источники к отчёту
  const sourcesSection = formatSourcesSection(sources, options.language);
  const fullReport = `${reportResult.report}\n\n${sourcesSection}`;

  logger.info('Output synthesized', {
    request_id: requestId,
    claims_total: allClaims.length,
    claims_included: allClaims.filter(c => c.status !== 'omitted').length,
    sources_total: sources.length,
    quality_score: quality.compositeScore,
    has_disclaimer: !!disclaimer,
  });

  return {
    report: fullReport,
    summary: reportResult.summary,
    claims: allClaims,
    sources,
    quality,
    metadata: {
      mode: options.mode === 'auto' ? 'standard' : options.mode,
      queryType: 'mixed',
      language: options.language,
      createdAt: new Date().toISOString(),
      pipeline_version: '1.0.0',
    },
    disclaimer,
    usage: reportResult.usage,
  };
}

/**
 * Вычисляет метрики качества
 */
function calculateQualityMetrics(
  verificationSummary: VerificationSummary,
  claims: Claim[],
  sources: Source[],
  omittedCount: number
): QualityMetrics {
  const totalClaims = verificationSummary.claims.length;
  const verifiedCount = verificationSummary.verified.length;
  const partiallyCorrectCount = verificationSummary.partiallyCorrect.length;
  const incorrectCount = verificationSummary.incorrect.length;
  const unverifiableCount = verificationSummary.unverifiable.length;

  // Verification pass rate
  const verificationPassRate = totalClaims > 0
    ? (verifiedCount + partiallyCorrectCount) / totalClaims
    : 0;

  // Citation coverage (% claims with sources)
  const claimsWithSources = claims.filter(c => c.sourceIds.length > 0).length;
  const citationCoverage = claims.length > 0 ? claimsWithSources / claims.length : 0;

  // Average source authority
  const authorityScores = sources.map(s => s.authority);
  const sourceAuthorityScore = authorityScores.length > 0 ? average(authorityScores) : 0;

  // Correction rate (how many needed corrections)
  const correctedCount = verificationSummary.allResults.filter(r => r.correction).length;
  const correctionRate = totalClaims > 0 ? correctedCount / totalClaims : 0;

  // Composite score
  const compositeScore = round(
    verificationPassRate * 0.4 +
    citationCoverage * 0.25 +
    sourceAuthorityScore * 0.25 +
    (1 - correctionRate) * 0.1,
    2
  );

  return {
    compositeScore,
    verificationPassRate: round(verificationPassRate, 2),
    citationCoverage: round(citationCoverage, 2),
    sourceAuthorityScore: round(sourceAuthorityScore, 2),
    correctionRate: round(correctionRate, 2),
    facts: {
      total: totalClaims,
      verified: verifiedCount,
      partiallyCorrect: partiallyCorrectCount,
      unverified: unverifiableCount,
      omitted: omittedCount,
    },
  };
}

/**
 * Форматирует раздел источников
 */
function formatSourcesSection(sources: Source[], language: 'ru' | 'en'): string {
  if (sources.length === 0) return '';

  const header = language === 'ru' ? '## Источники' : '## Sources';
  const sortedSources = [...sources].sort((a, b) => b.authority - a.authority);

  const sourceLines = sortedSources.map(s => {
    const stars = getAuthorityLabel(s.authority);
    return `[${s.id}] [${s.title}](${s.url}) — ${s.domain} ${stars}`;
  });

  return `${header}\n\n${sourceLines.join('\n')}`;
}
