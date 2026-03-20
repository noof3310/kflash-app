import {
  buildLiveReviewCards,
  getCardDifficulty,
  getProgressiveLearningWeight,
  getStudyPriorityMetrics,
  pickDistractorBacks,
  sortCardsForStudy,
} from '../src/lib/quiz';

describe('quiz helpers', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-19T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('study priority marks due cards correctly', () => {
    const dueCard = getStudyPriorityMetrics({
      attempt_count: 4,
      correct_count: 3,
      last_reviewed_at: '2026-03-18T00:00:00.000Z',
      next_due_at: '2026-03-18T12:00:00.000Z',
    });

    const futureCard = getStudyPriorityMetrics({
      attempt_count: 4,
      correct_count: 3,
      last_reviewed_at: '2026-03-18T00:00:00.000Z',
      next_due_at: '2026-03-21T12:00:00.000Z',
    });

    expect(dueCard.isDueNow).toBe(true);
    expect(futureCard.isDueNow).toBe(false);
  });

  test('new cards weigh higher than due cards, and due cards weigh higher than stable cards', () => {
    const newWeight = getProgressiveLearningWeight({
      attempt_count: 0,
      correct_count: 0,
    });
    const dueWeight = getProgressiveLearningWeight({
      attempt_count: 5,
      correct_count: 4,
      last_reviewed_at: '2026-03-18T00:00:00.000Z',
      next_due_at: '2026-03-18T00:00:00.000Z',
    });
    const stableWeight = getProgressiveLearningWeight({
      attempt_count: 5,
      correct_count: 4,
      last_reviewed_at: '2026-03-18T00:00:00.000Z',
      next_due_at: '2026-03-25T00:00:00.000Z',
    });

    expect(newWeight).toBeGreaterThan(dueWeight);
    expect(dueWeight).toBeGreaterThan(stableWeight);
  });

  test('buildLiveReviewCards updates attempts, streak, and due state immediately', () => {
    const [updatedCard] = buildLiveReviewCards(
      [
        {
          id: 1,
          front: '가다',
          back: '(v.) ไป',
          attempt_count: 1,
          correct_count: 1,
          correct_streak: 1,
          interval_days: 1,
          last_reviewed_at: '2026-03-18T00:00:00.000Z',
          next_due_at: '2026-03-20T00:00:00.000Z',
        },
      ],
      [{ cardId: 1, isCorrect: false }]
    );

    expect(updatedCard.attempt_count).toBe(2);
    expect(updatedCard.correct_count).toBe(1);
    expect(updatedCard.correct_streak).toBe(0);
    expect(updatedCard.interval_days).toBe(0);
    expect(updatedCard.next_due_at).toBe('2026-03-19T00:00:00.000Z');
  });

  test('sortCardsForStudy puts new cards first, then due cards, then weaker cards', () => {
    const sorted = sortCardsForStudy([
      {
        id: 3,
        front: 'stable',
        attempt_count: 5,
        correct_count: 5,
        last_reviewed_at: '2026-03-18T00:00:00.000Z',
        next_due_at: '2026-03-25T00:00:00.000Z',
      },
      {
        id: 2,
        front: 'due',
        attempt_count: 5,
        correct_count: 2,
        last_reviewed_at: '2026-03-18T00:00:00.000Z',
        next_due_at: '2026-03-18T00:00:00.000Z',
      },
      {
        id: 1,
        front: 'new',
        attempt_count: 0,
        correct_count: 0,
      },
    ]);

    expect(sorted.map((item) => item.id)).toEqual([1, 2, 3]);
  });

  test('difficulty thresholds match current quiz rules', () => {
    expect(getCardDifficulty({ attempt_count: 0, correct_count: 0 })).toBe('easy');
    expect(getCardDifficulty({ attempt_count: 10, correct_count: 6 })).toBe('normal');
    expect(getCardDifficulty({ attempt_count: 10, correct_count: 9 })).toBe('hard');
  });

  test('distractor soft bias can pull previously missed wrong choices higher', () => {
    const counts = {
      '(v.) มา': 0,
      '(v.) กิน': 0,
    };

    for (let index = 0; index < 200; index += 1) {
      const [option] = pickDistractorBacks(
        { id: 1, back: '(v.) ไป', type: 'v.' },
        [
          { id: 2, back: '(v.) มา', type: 'v.' },
          { id: 3, back: '(v.) กิน', type: 'v.' },
        ],
        1,
        true,
        { 1: { '(v.) กิน': 3 } }
      );

      counts[option] += 1;
    }

    expect(counts['(v.) กิน']).toBeGreaterThan(counts['(v.) มา']);
  });
});
