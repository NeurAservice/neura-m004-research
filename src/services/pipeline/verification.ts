/**
 * @file src/services/pipeline/verification.ts
 * @description Phase 4: Verification - верификация фактов
 * @context Проверяет каждый факт через независимый поиск
 */

import { getAnthropicService } from '../anthropic';
import { getPerplexityService } from '../perplexity';
import { logger } from '../../utils/logger';
import {
  ResearchQuestionResult,
  AtomicClaim,
  VerificationResult,
  ResearchOptions,
  Citation,
} from '../../types/research';

interface ExtendedVerificationResult extends VerificationResult {
  usage?: { input: number; output: number };
}

interface VerificationSummary {
  allResults: ExtendedVerificationResult[];
  claims: AtomicClaim[];
  verified: ExtendedVerificationResult[];
  partiallyCorrect: ExtendedVerificationResult[];
  incorrect: ExtendedVerificationResult[];
  unverifiable: ExtendedVerificationResult[];
}

/**
 * Верифицирует все факты из результатов исследования
 */
export async function verifyAllClaims(
  researchResults: ResearchQuestionResult[],
  options: ResearchOptions,
  requestId?: string,
  onProgress?: (current: number, total: number, status: string) => void
): Promise<VerificationSummary> {
  const anthropic = getAnthropicService();
  const perplexity = getPerplexityService();

  // 1. Декомпозиция на атомарные факты
  const allClaims: AtomicClaim[] = [];
  let claimId = 1;

  for (const result of researchResults) {
    if (!result.response) continue;

    const decomposed = await anthropic.decomposeToClaims(result.response, requestId);

    for (const claim of decomposed.claims) {
      allClaims.push({
        id: claimId++,
        text: claim.text,
        type: claim.type,
        sourceQuestionId: result.questionId,
        originalContext: result.response.substring(0, 500),
      });
    }
  }

  logger.info('Claims decomposed', {
    request_id: requestId,
    total_claims: allClaims.length,
    by_type: {
      factual: allClaims.filter(c => c.type === 'factual').length,
      analytical: allClaims.filter(c => c.type === 'analytical').length,
      speculative: allClaims.filter(c => c.type === 'speculative').length,
    },
  });

  // 2. Верификация каждого factual claim
  const results: ExtendedVerificationResult[] = [];
  const claimsToVerify = allClaims.filter(c => c.type === 'factual');

  // Аналитические и speculative claims помечаем без верификации
  for (const claim of allClaims.filter(c => c.type !== 'factual')) {
    results.push({
      claimId: claim.id,
      status: claim.type === 'speculative' ? 'unverifiable' : 'verified',
      confidence: claim.type === 'speculative' ? 0.5 : 0.7,
      verificationSources: [],
      explanation: claim.type === 'speculative'
        ? 'Marked as speculation/opinion'
        : 'Analytical claim - underlying facts should be verified',
    });
  }

  // Верифицируем factual claims
  const concurrency = 2;
  let verified = 0;

  for (let i = 0; i < claimsToVerify.length; i += concurrency) {
    const chunk = claimsToVerify.slice(i, i + concurrency);

    const chunkResults = await Promise.all(
      chunk.map(async (claim) => {
        try {
          onProgress?.(
            verified + 1,
            claimsToVerify.length,
            `Проверяем: ${claim.text.substring(0, 40)}...`
          );

          const verifyResult = await perplexity.verifyFact(claim.text, {
            context: claim.originalContext,
            requestId,
          });

          verified++;

          return {
            claimId: claim.id,
            status: verifyResult.status,
            confidence: verifyResult.confidence,
            correction: verifyResult.correction,
            verificationSources: verifyResult.sources,
            explanation: verifyResult.explanation,
            usage: verifyResult.usage,
          };
        } catch (error) {
          logger.error('Claim verification failed', {
            request_id: requestId,
            claim_id: claim.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });

          verified++;

          return {
            claimId: claim.id,
            status: 'unverifiable' as const,
            confidence: 0.3,
            verificationSources: [],
            explanation: 'Verification failed due to error',
          };
        }
      })
    );

    results.push(...chunkResults);
  }

  // Сортируем результаты по claimId
  results.sort((a, b) => a.claimId - b.claimId);

  // Группируем результаты
  const summary: VerificationSummary = {
    allResults: results,
    claims: allClaims,
    verified: results.filter(r => r.status === 'verified'),
    partiallyCorrect: results.filter(r => r.status === 'partially_correct'),
    incorrect: results.filter(r => r.status === 'incorrect'),
    unverifiable: results.filter(r => r.status === 'unverifiable'),
  };

  logger.info('Verification completed', {
    request_id: requestId,
    total: results.length,
    verified: summary.verified.length,
    partially_correct: summary.partiallyCorrect.length,
    incorrect: summary.incorrect.length,
    unverifiable: summary.unverifiable.length,
  });

  return summary;
}
