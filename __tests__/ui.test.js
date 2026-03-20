import { formatReviewStats, getAccuracyTone, getSpeechLanguage } from '../src/lib/ui';

describe('ui helpers', () => {
  test('formatReviewStats hides empty stats and formats percentages', () => {
    expect(formatReviewStats({ attempt_count: 0, correct_count: 0 })).toBe('');
    expect(formatReviewStats({ attempt_count: 5, correct_count: 4 })).toBe('4/5 correct (80%)');
  });

  test('getSpeechLanguage detects Hangul and leaves non-Hangul generic', () => {
    expect(getSpeechLanguage('안녕하세요')).toBe('ko-KR');
    expect(getSpeechLanguage('hello')).toBeUndefined();
  });

  test('getAccuracyTone uses red/yellow/green thresholds', () => {
    const colors = {
      correctBackground: 'green-bg',
      correctBorder: 'green-border',
      warningBackground: 'yellow-bg',
      warningBorder: 'yellow-border',
      errorBackground: 'red-bg',
      errorBorder: 'red-border',
    };

    expect(getAccuracyTone(95, colors)).toEqual({
      backgroundColor: 'green-bg',
      borderColor: 'green-border',
    });
    expect(getAccuracyTone(70, colors)).toEqual({
      backgroundColor: 'yellow-bg',
      borderColor: 'yellow-border',
    });
    expect(getAccuracyTone(40, colors)).toEqual({
      backgroundColor: 'red-bg',
      borderColor: 'red-border',
    });
  });
});
