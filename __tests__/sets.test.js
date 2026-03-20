import { buildEnrichedSets, filterAndSortSets, formatSetStats } from '../src/lib/sets';

describe('set helpers', () => {
  test('buildEnrichedSets computes average score and quiz counts per set', () => {
    const sets = buildEnrichedSets(
      [
        { id: 1, name: 'Day 01', card_count: 10, new_card_count: 3, due_card_count: 2 },
        { id: 2, name: 'Day 02', card_count: 8, new_card_count: 1, due_card_count: 0 },
      ],
      [
        { selected_set_ids: '[1,2]', score: 8, total: 10 },
        { selected_set_ids: '[1]', score: 5, total: 10 },
      ]
    );

    expect(sets[0].quiz_count).toBe(2);
    expect(sets[0].average_score_percent).toBe(65);
    expect(sets[1].quiz_count).toBe(1);
    expect(sets[1].average_score_percent).toBe(80);
  });

  test('priority sort prefers due cards, then new cards, then weaker scores', () => {
    const sorted = filterAndSortSets(
      [
        { id: 1, name: 'A', due_card_count: 0, new_card_count: 5, average_score_percent: null, quiz_count: 0, card_count: 12 },
        { id: 2, name: 'B', due_card_count: 4, new_card_count: 0, average_score_percent: 92, quiz_count: 4, card_count: 10 },
        { id: 3, name: 'C', due_card_count: 1, new_card_count: 3, average_score_percent: 40, quiz_count: 2, card_count: 9 },
      ],
      { setSort: 'priority', randomFn: () => 0 }
    );

    expect(sorted.map((item) => item.id)).toEqual([2, 3, 1]);
  });

  test('priority sort does not use card count as a tie breaker', () => {
    const sorted = filterAndSortSets(
      [
        { id: 1, name: 'A', due_card_count: 0, new_card_count: 0, average_score_percent: 60, quiz_count: 2, card_count: 30 },
        { id: 2, name: 'B', due_card_count: 0, new_card_count: 0, average_score_percent: 60, quiz_count: 2, card_count: 5 },
      ],
      { setSort: 'priority', randomFn: () => 0 }
    );

    expect(sorted.map((item) => item.id)).toEqual([2, 1]);
  });

  test('filters can isolate weak and selected sets', () => {
    const baseSets = [
      { id: 1, name: 'Weak', due_card_count: 0, new_card_count: 0, average_score_percent: 45, quiz_count: 3, card_count: 10 },
      { id: 2, name: 'Strong', due_card_count: 0, new_card_count: 0, average_score_percent: 95, quiz_count: 5, card_count: 10 },
    ];

    expect(filterAndSortSets(baseSets, { setFilter: 'weak' }).map((item) => item.id)).toEqual([1]);
    expect(
      filterAndSortSets(baseSets, { setFilter: 'selected', selectedSetIds: [2] }).map((item) => item.id)
    ).toEqual([2]);
  });

  test('formatSetStats shows due, new, quizzes and average', () => {
    expect(
      formatSetStats({
        card_count: 24,
        due_card_count: 6,
        new_card_count: 3,
        quiz_count: 5,
        average_score_percent: 62,
      })
    ).toBe('24 cards • 6 due • 3 new • 5 quizzes • 62% avg');
  });
});
