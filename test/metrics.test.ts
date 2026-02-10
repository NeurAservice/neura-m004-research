/**
 * @file test/metrics.test.ts
 * @description Unit tests для compositeScore + grade determination
 * @context Тесты по ТЗ Section 17: 4 кейса для формулы метрик
 */

import { determineGrade, determineFormat } from '../src/services/pipeline/output';

describe('determineGrade', () => {
  it('should return A for score >= 0.85', () => {
    expect(determineGrade(0.85)).toBe('A');
    expect(determineGrade(0.90)).toBe('A');
    expect(determineGrade(1.0)).toBe('A');
  });

  it('should return B for score >= 0.65 and < 0.85', () => {
    expect(determineGrade(0.65)).toBe('B');
    expect(determineGrade(0.75)).toBe('B');
    expect(determineGrade(0.84)).toBe('B');
  });

  it('should return C for score >= 0.40 and < 0.65', () => {
    expect(determineGrade(0.40)).toBe('C');
    expect(determineGrade(0.50)).toBe('C');
    expect(determineGrade(0.64)).toBe('C');
  });

  it('should return F for score < 0.40', () => {
    expect(determineGrade(0.39)).toBe('F');
    expect(determineGrade(0.20)).toBe('F');
    expect(determineGrade(0.0)).toBe('F');
  });
});

describe('determineFormat', () => {
  it('should return narrative for grade A with enough facts (standard mode)', () => {
    expect(determineFormat('A', 10, 'standard')).toBe('narrative');
  });

  it('should downgrade narrative to bullet_list if facts < threshold', () => {
    // standard threshold = 5, 3 facts < 5
    expect(determineFormat('A', 3, 'standard')).toBe('bullet_list');
  });

  it('should return bullet_list for grade C', () => {
    expect(determineFormat('C', 10, 'standard')).toBe('bullet_list');
  });

  it('should return minimal for grade F', () => {
    expect(determineFormat('F', 10, 'standard')).toBe('minimal');
  });

  it('should respect mode thresholds (deep mode needs 10 for narrative)', () => {
    // grade B + deep mode: narrative threshold = 10
    expect(determineFormat('B', 5, 'deep')).toBe('bullet_list');
    expect(determineFormat('B', 10, 'deep')).toBe('narrative');
  });

  it('should apply simple mode threshold (3 facts needed for narrative)', () => {
    expect(determineFormat('A', 2, 'simple')).toBe('bullet_list');
    expect(determineFormat('A', 3, 'simple')).toBe('narrative');
  });
});

describe('compositeScore formula validation', () => {
  /**
   * Ручной расчёт формулы для проверки:
   * compositeScore = verification * 0.45 + citation * 0.30 + authority * 0.15 + (1 - correction) * 0.10
   */

  it('Case 1: Perfect scores → A grade', () => {
    // verification=1.0, citation=1.0, authority=0.9, correction=0.0
    const score = 1.0 * 0.45 + 1.0 * 0.30 + 0.9 * 0.15 + (1 - 0.0) * 0.10;
    // 0.45 + 0.30 + 0.135 + 0.10 = 0.985
    expect(score).toBeCloseTo(0.985, 2);
    expect(determineGrade(score)).toBe('A');
  });

  it('Case 2: Good research, some gaps → B grade', () => {
    // verification=0.7, citation=0.8, authority=0.6, correction=0.1
    const score = 0.7 * 0.45 + 0.8 * 0.30 + 0.6 * 0.15 + (1 - 0.1) * 0.10;
    // 0.315 + 0.24 + 0.09 + 0.09 = 0.735
    expect(score).toBeCloseTo(0.735, 2);
    expect(determineGrade(score)).toBe('B');
  });

  it('Case 3: Mediocre research → C grade', () => {
    // verification=0.4, citation=0.5, authority=0.4, correction=0.3
    const score = 0.4 * 0.45 + 0.5 * 0.30 + 0.4 * 0.15 + (1 - 0.3) * 0.10;
    // 0.18 + 0.15 + 0.06 + 0.07 = 0.46
    expect(score).toBeCloseTo(0.46, 2);
    expect(determineGrade(score)).toBe('C');
  });

  it('Case 4: Poor research → F grade', () => {
    // verification=0.1, citation=0.2, authority=0.3, correction=0.5
    const score = 0.1 * 0.45 + 0.2 * 0.30 + 0.3 * 0.15 + (1 - 0.5) * 0.10;
    // 0.045 + 0.06 + 0.045 + 0.05 = 0.20
    expect(score).toBeCloseTo(0.20, 2);
    expect(determineGrade(score)).toBe('F');
  });
});
