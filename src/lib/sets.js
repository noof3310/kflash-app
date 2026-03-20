export function buildEnrichedSets(fetchedSets, sessionRows) {
  const setScoreMap = new Map();

  for (const session of sessionRows ?? []) {
    let selectedIds = [];
    try {
      const parsed = JSON.parse(session.selected_set_ids ?? '[]');
      selectedIds = Array.isArray(parsed) ? parsed.map((value) => Number(value)).filter(Boolean) : [];
    } catch {
      selectedIds = [];
    }

    const total = Number(session.total) || 0;
    const score = Number(session.score) || 0;
    const scorePercent = total > 0 ? (score / total) * 100 : 0;

    for (const setId of selectedIds) {
      const current = setScoreMap.get(setId) ?? { quiz_count: 0, total_score_percent: 0 };
      current.quiz_count += 1;
      current.total_score_percent += scorePercent;
      setScoreMap.set(setId, current);
    }
  }

  return (fetchedSets ?? []).map((item) => {
    const scoreStats = setScoreMap.get(item.id);
    const quizCount = Number(scoreStats?.quiz_count) || 0;
    const averageScorePercent =
      quizCount > 0 ? scoreStats.total_score_percent / quizCount : null;

    return {
      ...item,
      card_count: Number(item.card_count) || 0,
      new_card_count: Number(item.new_card_count) || 0,
      due_card_count: Number(item.due_card_count) || 0,
      quiz_count: quizCount,
      average_score_percent: averageScorePercent,
    };
  });
}

export function filterAndSortSets(sets, options = {}) {
  const {
    searchQuery = '',
    setFilter = 'all',
    setSort = 'priority',
    selectedSetIds = [],
    randomFn = Math.random,
  } = options;

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const searchFilteredSets = normalizedQuery
    ? (sets ?? []).filter((item) => item.name.toLowerCase().includes(normalizedQuery))
    : sets ?? [];

  const filterMatchedSets = searchFilteredSets.filter((item) => {
    const averageScorePercent = Number(item.average_score_percent);

    if (setFilter === 'selected') {
      return selectedSetIds.includes(item.id);
    }

    if (setFilter === 'unplayed') {
      return (Number(item.quiz_count) || 0) === 0;
    }

    if (setFilter === 'weak') {
      return (Number(item.quiz_count) || 0) > 0 && averageScorePercent <= 50;
    }

    if (setFilter === 'strong') {
      return (Number(item.quiz_count) || 0) > 0 && averageScorePercent >= 90;
    }

    return true;
  });

  const sortableSets = [...filterMatchedSets];
  if (setSort === 'priority') {
    for (let index = sortableSets.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(randomFn() * (index + 1));
      [sortableSets[index], sortableSets[swapIndex]] = [sortableSets[swapIndex], sortableSets[index]];
    }
  }

  return sortableSets.sort((left, right) => compareSets(left, right, setSort));
}

export function formatSetStats(set) {
  const parts = [`${Number(set.card_count) || 0} cards`];
  const dueCardCount = Number(set.due_card_count) || 0;
  const newCardCount = Number(set.new_card_count) || 0;
  const quizCount = Number(set.quiz_count) || 0;

  if (dueCardCount > 0) {
    parts.push(`${dueCardCount} due`);
  }

  if (newCardCount > 0) {
    parts.push(`${newCardCount} new`);
  }

  if (quizCount > 0) {
    parts.push(`${quizCount} quizzes`);
    parts.push(`${Math.round(Number(set.average_score_percent) || 0)}% avg`);
  } else {
    parts.push('No quiz history');
  }

  return parts.join(' • ');
}

function compareSets(left, right, setSort) {
  const leftAverage = Number.isFinite(Number(left.average_score_percent))
    ? Number(left.average_score_percent)
    : null;
  const rightAverage = Number.isFinite(Number(right.average_score_percent))
    ? Number(right.average_score_percent)
    : null;
  const leftQuizCount = Number(left.quiz_count) || 0;
  const rightQuizCount = Number(right.quiz_count) || 0;
  const leftDueCardCount = Number(left.due_card_count) || 0;
  const rightDueCardCount = Number(right.due_card_count) || 0;
  const leftNewCardCount = Number(left.new_card_count) || 0;
  const rightNewCardCount = Number(right.new_card_count) || 0;

  if (setSort === 'name') {
    return left.name.localeCompare(right.name);
  }

  if (setSort === 'lowest score') {
    if (leftAverage === null && rightAverage !== null) return -1;
    if (leftAverage !== null && rightAverage === null) return 1;
    if (leftAverage !== rightAverage) return (leftAverage ?? 0) - (rightAverage ?? 0);
    if (leftQuizCount !== rightQuizCount) return leftQuizCount - rightQuizCount;
    return 0;
  }

  if (setSort === 'highest score') {
    if (leftAverage === null && rightAverage !== null) return 1;
    if (leftAverage !== null && rightAverage === null) return -1;
    if (leftAverage !== rightAverage) return (rightAverage ?? 0) - (leftAverage ?? 0);
    if (leftQuizCount !== rightQuizCount) return rightQuizCount - leftQuizCount;
    return 0;
  }

  if (leftDueCardCount !== rightDueCardCount) return rightDueCardCount - leftDueCardCount;
  if (leftNewCardCount !== rightNewCardCount) return rightNewCardCount - leftNewCardCount;
  if (leftAverage === null && rightAverage !== null) return -1;
  if (leftAverage !== null && rightAverage === null) return 1;
  if (leftAverage !== rightAverage) return (leftAverage ?? 0) - (rightAverage ?? 0);
  if (leftQuizCount !== rightQuizCount) return leftQuizCount - rightQuizCount;
  return 0;
}
