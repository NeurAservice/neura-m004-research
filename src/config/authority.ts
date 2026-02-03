/**
 * @file src/config/authority.ts
 * @description Source Authority Scoring - оценка авторитетности источников
 * @context Используется при верификации фактов для оценки надёжности источников
 */

/**
 * Карта авторитетности источников по доменам
 * Tier 1: 0.90-1.00 - Высшая авторитетность
 * Tier 2: 0.70-0.90 - Высокая авторитетность
 * Tier 3: 0.50-0.70 - Средняя авторитетность
 * Tier 4: 0.30-0.50 - Низкая авторитетность
 */
export const AUTHORITY_SCORES: Record<string, number> = {
  // Tier 1: Highest (0.90-1.00) - Официальные и академические
  '.gov': 0.95,
  '.gov.ru': 0.95,
  '.edu': 0.90,
  'nature.com': 1.00,
  'science.org': 1.00,
  'pubmed.ncbi.nlm.nih.gov': 0.95,
  'arxiv.org': 0.90,
  'scholar.google.com': 0.90,
  'ieee.org': 0.90,
  'who.int': 0.95,
  'un.org': 0.95,
  'worldbank.org': 0.90,
  'imf.org': 0.90,
  'oecd.org': 0.90,

  // Tier 2: High (0.70-0.90) - Авторитетные СМИ и бизнес
  'reuters.com': 0.85,
  'bloomberg.com': 0.85,
  'wsj.com': 0.85,
  'nytimes.com': 0.80,
  'ft.com': 0.85,
  'economist.com': 0.85,
  'bbc.com': 0.80,
  'bbc.co.uk': 0.80,
  'theguardian.com': 0.75,
  'forbes.com': 0.75,
  'cnbc.com': 0.75,
  'techcrunch.com': 0.70,
  'wired.com': 0.70,
  'arstechnica.com': 0.70,

  // Российские авторитетные источники
  'tass.ru': 0.80,
  'ria.ru': 0.75,
  'interfax.ru': 0.80,
  'vedomosti.ru': 0.75,
  'kommersant.ru': 0.75,
  'rbc.ru': 0.70,

  // Официальные сайты компаний (Tier 2)
  'apple.com': 0.90,
  'google.com': 0.90,
  'microsoft.com': 0.90,
  'tesla.com': 0.90,
  'amazon.com': 0.85,

  // Tier 3: Medium (0.50-0.70) - Энциклопедии и справочники
  'wikipedia.org': 0.65,
  'britannica.com': 0.75,
  'investopedia.com': 0.70,
  'statista.com': 0.70,
  'crunchbase.com': 0.65,

  // Tier 4: Low (0.30-0.50) - UGC и форумы
  'medium.com': 0.50,
  'reddit.com': 0.40,
  'quora.com': 0.35,
  'stackoverflow.com': 0.55,
  'habr.com': 0.55,
  'vc.ru': 0.50,

  // Default
  'default': 0.30,
};

/**
 * Получить оценку авторитетности для URL
 */
export function getAuthorityScore(url: string): number {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();

    // Убираем www. если есть
    const domain = hostname.replace(/^www\./, '');

    // Проверяем точное совпадение
    if (AUTHORITY_SCORES[domain] !== undefined) {
      return AUTHORITY_SCORES[domain];
    }

    // Проверяем по суффиксу (.gov, .edu, etc.)
    for (const [pattern, score] of Object.entries(AUTHORITY_SCORES)) {
      if (pattern.startsWith('.') && domain.endsWith(pattern)) {
        return score;
      }
    }

    // Проверяем частичное совпадение (например, subdomain.nature.com)
    for (const [pattern, score] of Object.entries(AUTHORITY_SCORES)) {
      if (!pattern.startsWith('.') && domain.includes(pattern)) {
        return score;
      }
    }

    return AUTHORITY_SCORES['default'];
  } catch {
    return AUTHORITY_SCORES['default'];
  }
}

/**
 * Получить tier авторитетности
 */
export function getAuthorityTier(score: number): 'tier1_high' | 'tier2_established' | 'tier3_medium' | 'tier4_low' {
  if (score >= 0.90) return 'tier1_high';
  if (score >= 0.70) return 'tier2_established';
  if (score >= 0.50) return 'tier3_medium';
  return 'tier4_low';
}

/**
 * Получить человекочитаемое описание авторитетности
 */
export function getAuthorityLabel(score: number): string {
  if (score >= 0.90) return '★★★★★';
  if (score >= 0.80) return '★★★★☆';
  if (score >= 0.70) return '★★★☆☆';
  if (score >= 0.50) return '★★☆☆☆';
  return '★☆☆☆☆';
}
