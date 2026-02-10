/**
 * @file test/preTriage.test.ts
 * @description Unit-тесты для Pre-Triage эвристик
 * @context ТЗ Группа 2: Pre-Triage определяет минимальный (floor) режим до LLM triage
 */

import { preTriage, elevate } from '../src/utils/preTriage';

describe('preTriage', () => {
  it('should return simple for short query', () => {
    const result = preTriage('What is JavaScript?');
    expect(result.floor).toBe('simple');
    expect(result.reasons).toHaveLength(0);
  });

  it('should elevate to standard for long query (50+ words)', () => {
    const longQuery = Array(60).fill('word').join(' ');
    const result = preTriage(longQuery);
    expect(result.floor).toBe('standard');
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('query_length')])
    );
  });

  it('should elevate to deep for very long query (150+ words)', () => {
    const veryLongQuery = Array(160).fill('word').join(' ');
    const result = preTriage(veryLongQuery);
    expect(result.floor).toBe('deep');
  });

  it('should elevate to standard for 3+ questions', () => {
    const result = preTriage('What is A? How does B work? Why is C important?');
    expect(result.floor).toBe('standard');
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('multiple_questions')])
    );
  });

  it('should elevate to deep for 6+ questions', () => {
    const result = preTriage('What is A? What is B? What is C? What is D? What is E? What is F?');
    expect(result.floor).toBe('deep');
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('many_questions')])
    );
  });

  it('should elevate to deep for deep domain keywords', () => {
    const result = preTriage('Provide a systematic review of machine learning approaches');
    expect(result.floor).toBe('deep');
    expect(result.reasons).toContain('deep_domain_keyword_detected');
  });

  it('should elevate to deep for meta-analysis keyword', () => {
    const result = preTriage('Нужен мета-анализ исследований по вакцинации');
    expect(result.floor).toBe('deep');
    expect(result.reasons).toContain('deep_domain_keyword_detected');
  });

  it('should elevate to standard for standard domain keywords', () => {
    const result = preTriage('How does blockchain work?');
    expect(result.floor).toBe('standard');
    expect(result.reasons).toContain('standard_domain_keyword_detected');
  });

  it('should elevate to standard for Russian standard keywords', () => {
    const result = preTriage('Какие преимущества у React перед Vue?');
    expect(result.floor).toBe('standard');
    expect(result.reasons).toContain('standard_domain_keyword_detected');
  });

  it('should elevate for structured input with numbered items', () => {
    const query = '1. First topic\n2. Second topic\n3. Third topic\nAnalyze all of these.';
    const result = preTriage(query);
    expect(result.floor).toBe('standard');
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('structural_blocks')])
    );
  });

  it('should elevate for bullet list items', () => {
    const query = '- First item\n- Second item\n- Third item\nCompare all.';
    const result = preTriage(query);
    expect(result.floor).toBe('standard');
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('structural_blocks')])
    );
  });

  it('should elevate to standard for explicit depth request', () => {
    const result = preTriage('Расскажи подробно про квантовые компьютеры');
    expect(result.floor).toBe('standard');
    expect(result.reasons).toContain('explicit_depth_request');
  });

  it('should elevate to standard for "comprehensive" keyword', () => {
    const result = preTriage('Give a comprehensive overview of AI trends');
    expect(result.floor).toBe('standard');
    expect(result.reasons).toContain('explicit_depth_request');
  });

  it('should combine multiple reasons', () => {
    // Long query + multiple questions + deep keyword
    const query = Array(55).fill('word').join(' ') + '? ' + 'what? why? ' + 'systematic review needed';
    const result = preTriage(query);
    expect(result.floor).toBe('deep');
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('should not elevate for simple factual queries', () => {
    const result = preTriage('Когда основана компания Apple?');
    expect(result.floor).toBe('simple');
    expect(result.reasons).toHaveLength(0);
  });

  it('should handle empty query', () => {
    const result = preTriage('');
    expect(result.floor).toBe('simple');
    expect(result.reasons).toHaveLength(0);
  });

  it('should handle legal domain keywords', () => {
    const result = preTriage('Проведи анализ. Судебная практика по арендным спорам требует внимания');
    expect(result.floor).toBe('deep');
    expect(result.reasons).toContain('deep_domain_keyword_detected');
  });
});

describe('elevate', () => {
  it('should elevate simple to standard', () => {
    expect(elevate('simple', 'standard')).toBe('standard');
  });

  it('should elevate simple to deep', () => {
    expect(elevate('simple', 'deep')).toBe('deep');
  });

  it('should elevate standard to deep', () => {
    expect(elevate('standard', 'deep')).toBe('deep');
  });

  it('should NOT lower deep to standard', () => {
    expect(elevate('deep', 'standard')).toBe('deep');
  });

  it('should NOT lower standard to simple', () => {
    expect(elevate('standard', 'simple')).toBe('standard');
  });

  it('should keep same level', () => {
    expect(elevate('standard', 'standard')).toBe('standard');
    expect(elevate('deep', 'deep')).toBe('deep');
    expect(elevate('simple', 'simple')).toBe('simple');
  });
});
