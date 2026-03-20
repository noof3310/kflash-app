export function shuffleArray(items) {
  const clone = [...items];
  for (let i = clone.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [clone[i], clone[j]] = [clone[j], clone[i]];
  }
  return clone;
}

export function getStudyPriorityMetrics(card) {
  const attempts = Number(card?.attempt_count) || 0;
  const correct = Number(card?.correct_count) || 0;
  const accuracy = attempts > 0 ? correct / attempts : 0;
  const hasBeenReviewed = Boolean(card?.last_reviewed_at);
  const dueAtMs = card?.next_due_at ? Date.parse(card.next_due_at) : Number.NaN;
  const isDueNow = hasBeenReviewed && Number.isFinite(dueAtMs) ? dueAtMs <= Date.now() : false;

  return {
    attempts,
    accuracy,
    hasBeenReviewed,
    isDueNow,
  };
}

export function getProgressiveLearningWeight(card) {
  const { attempts, accuracy, isDueNow } = getStudyPriorityMetrics(card);

  if (attempts === 0) {
    return 1200;
  }

  if (isDueNow) {
    return 900 + (1 - accuracy) * 100;
  }

  const accuracyWeight = (1 - accuracy) * 100;
  const attemptsWeight = 10 / (1 + attempts);
  return Math.max(0.1, accuracyWeight + attemptsWeight);
}

export function pickWeightedQuizCard(cards) {
  const weightedCards = (cards ?? []).map((card) => ({
    card,
    weight: getProgressiveLearningWeight(card),
  }));
  const totalWeight = weightedCards.reduce((sum, item) => sum + item.weight, 0);

  if (totalWeight <= 0 || weightedCards.length === 0) {
    return cards?.[0];
  }

  let threshold = Math.random() * totalWeight;
  for (const item of weightedCards) {
    threshold -= item.weight;
    if (threshold <= 0) {
      return item.card;
    }
  }

  return weightedCards[weightedCards.length - 1].card;
}

export function buildAdaptiveQuizItem(
  reviewCards,
  allCards,
  answers,
  questionIndex,
  dontKnowOption,
  distractorBiasMap = {},
  quizDirectionMode = 'front-to-back'
) {
  const liveCards = buildLiveReviewCards(reviewCards, answers);
  const lastAnsweredCardId = answers?.length ? answers[answers.length - 1].cardId : null;
  const candidateCards =
    lastAnsweredCardId && liveCards.length > 1
      ? liveCards.filter((card) => card.id !== lastAnsweredCardId)
      : liveCards;
  const question = pickWeightedQuizCard(candidateCards);

  if (!question) {
    return null;
  }

  const config = getQuestionConfig(question, quizDirectionMode);
  const promptText = getQuestionText(question, config.promptField);
  const correctOption = getQuestionText(question, config.answerField);

  return {
    id: question.id,
    instanceId: `${question.id}-${questionIndex}-${Math.random().toString(36).slice(2, 8)}`,
    front: question.front,
    back: question.back,
    promptText,
    promptField: config.promptField,
    correctOption,
    answerField: config.answerField,
    options: buildQuizOptions(question, liveCards, allCards, dontKnowOption, distractorBiasMap, config),
  };
}

export function buildLiveReviewCards(reviewCards, answers) {
  const cardMap = new Map((reviewCards ?? []).map((card) => [card.id, { ...card }]));

  for (const answer of answers ?? []) {
    const currentCard = cardMap.get(answer.cardId);
    if (!currentCard) {
      continue;
    }

    const attempts = Number(currentCard.attempt_count) || 0;
    const correct = Number(currentCard.correct_count) || 0;
    currentCard.attempt_count = attempts + 1;
    currentCard.correct_count = correct + (answer.isCorrect ? 1 : 0);

    const nextProgress = getNextCardProgress(currentCard, answer.isCorrect);
    currentCard.last_reviewed_at = nextProgress.last_reviewed_at;
    currentCard.next_due_at = nextProgress.next_due_at;
    currentCard.correct_streak = nextProgress.correct_streak;
    currentCard.interval_days = nextProgress.interval_days;
  }

  return Array.from(cardMap.values());
}

export function buildQuizOptions(
  question,
  reviewCards,
  allCards,
  dontKnowOption,
  distractorBiasMap = {},
  questionConfig = getQuestionConfig(question, 'front-to-back')
) {
  const distractorCount = questionConfig.totalChoices - 2;
  const optionSource = questionConfig.optionSource === 'review' ? reviewCards : allCards;
  const distractors = pickDistractorOptions(
    question,
    optionSource,
    questionConfig.answerField,
    distractorCount,
    questionConfig.preferSameType,
    distractorBiasMap
  );

  return [dontKnowOption, ...shuffleArray([getQuestionText(question, questionConfig.answerField), ...distractors])];
}

export function getCardDifficulty(card) {
  const { accuracy } = getStudyPriorityMetrics(card);

  if (accuracy > 0.9) {
    return 'perfection';
  }

  if (accuracy > 0.7) {
    return 'hard';
  }

  if (accuracy > 0.5) {
    return 'normal';
  }

  return 'easy';
}

export function pickDistractorBacks(
  question,
  sourceCards,
  distractorCount,
  preferSameType,
  distractorBiasMap = {}
) {
  return pickDistractorOptions(
    question,
    sourceCards,
    'back',
    distractorCount,
    preferSameType,
    distractorBiasMap
  );
}

function pickDistractorOptions(
  question,
  sourceCards,
  answerField,
  distractorCount,
  preferSameType,
  distractorBiasMap = {}
) {
  const uniqueOptions = [];
  const seenOptions = new Set([getQuestionText(question, answerField)]);
  const candidateCards = shuffleArray(sourceCards ?? []).filter((card) => card.id !== question.id);
  const questionBiasMap = distractorBiasMap?.[question.id] ?? {};

  while (candidateCards.length > 0 && uniqueOptions.length < distractorCount) {
    const weightedCandidates = candidateCards
      .filter((card) => !seenOptions.has(getQuestionText(card, answerField)))
      .map((card) => ({
        card,
        weight: getDistractorWeight(
          card,
          question,
          answerField,
          preferSameType,
          questionBiasMap
        ),
      }));

    if (!weightedCandidates.length) {
      break;
    }

    const pickedCard = pickWeightedCardByWeight(weightedCandidates);
    if (!pickedCard) {
      break;
    }

    const optionText = getQuestionText(pickedCard, answerField);
    seenOptions.add(optionText);
    uniqueOptions.push(optionText);
  }

  return uniqueOptions;
}

function getDistractorWeight(card, question, answerField, preferSameType, questionBiasMap) {
  const sameTypeWeight = preferSameType && question.type && card.type === question.type ? 4 : 1;
  const wrongCount = Number(questionBiasMap?.[getQuestionText(card, answerField)]) || 0;
  const softBiasBonus = Math.min(3, wrongCount) * 0.75;

  return sameTypeWeight + softBiasBonus;
}

export function pickWeightedCardByWeight(weightedCards) {
  const totalWeight = weightedCards.reduce((sum, item) => sum + item.weight, 0);

  if (totalWeight <= 0 || weightedCards.length === 0) {
    return weightedCards[0]?.card;
  }

  let threshold = Math.random() * totalWeight;
  for (const item of weightedCards) {
    threshold -= item.weight;
    if (threshold <= 0) {
      return item.card;
    }
  }

  return weightedCards[weightedCards.length - 1].card;
}

export function sortCardsForStudy(cards) {
  return shuffleArray(cards ?? []).sort((left, right) => {
    const {
      attempts: leftAttempts,
      accuracy: leftAccuracy,
      isDueNow: leftIsDueNow,
    } = getStudyPriorityMetrics(left);
    const {
      attempts: rightAttempts,
      accuracy: rightAccuracy,
      isDueNow: rightIsDueNow,
    } = getStudyPriorityMetrics(right);
    const leftZeroPlay = leftAttempts === 0 ? 0 : 1;
    const rightZeroPlay = rightAttempts === 0 ? 0 : 1;

    if (leftZeroPlay !== rightZeroPlay) {
      return leftZeroPlay - rightZeroPlay;
    }

    if (leftZeroPlay === 1 && leftIsDueNow !== rightIsDueNow) {
      return leftIsDueNow ? -1 : 1;
    }

    if (leftAccuracy !== rightAccuracy) {
      return leftAccuracy - rightAccuracy;
    }

    if (leftAttempts !== rightAttempts) {
      return leftAttempts - rightAttempts;
    }

    return 0;
  });
}

function getNextCardProgress(previousProgress, isCorrect) {
  const now = new Date();
  const baseProgress = previousProgress ?? {
    correct_streak: 0,
    interval_days: 0,
  };

  if (!isCorrect) {
    return {
      last_reviewed_at: now.toISOString(),
      next_due_at: now.toISOString(),
      correct_streak: 0,
      interval_days: 0,
    };
  }

  const nextStreak = (Number(baseProgress.correct_streak) || 0) + 1;
  const nextIntervalDays = getNextIntervalDays(nextStreak, Number(baseProgress.interval_days) || 0);
  const nextDueDate = new Date(now);
  nextDueDate.setDate(nextDueDate.getDate() + nextIntervalDays);

  return {
    last_reviewed_at: now.toISOString(),
    next_due_at: nextDueDate.toISOString(),
    correct_streak: nextStreak,
    interval_days: nextIntervalDays,
  };
}

function getNextIntervalDays(streak, previousIntervalDays) {
  if (streak <= 1) {
    return 1;
  }

  if (streak === 2) {
    return 3;
  }

  if (streak === 3) {
    return 7;
  }

  return Math.min(60, Math.max(14, previousIntervalDays * 2));
}

function getQuestionConfig(card, quizDirectionMode) {
  const difficulty = getCardDifficulty(card);

  if (quizDirectionMode === 'back-to-front') {
    return getBackToFrontConfig(difficulty);
  }

  if (quizDirectionMode === 'mixed') {
    return getMixedConfig(difficulty);
  }

  return getFrontToBackConfig(difficulty);
}

function getFrontToBackConfig(difficulty) {
  if (difficulty === 'easy') {
    return {
      promptField: 'front',
      answerField: 'back',
      optionSource: 'review',
      preferSameType: false,
      totalChoices: 5,
    };
  }

  return {
    promptField: 'front',
    answerField: 'back',
    optionSource: 'all',
    preferSameType: true,
    totalChoices: difficulty === 'normal' ? 5 : 7,
  };
}

function getBackToFrontConfig(difficulty) {
  if (difficulty === 'easy' || difficulty === 'normal') {
    return {
      promptField: 'back',
      answerField: 'front',
      optionSource: 'review',
      preferSameType: false,
      totalChoices: 5,
    };
  }

  return {
    promptField: 'back',
    answerField: 'front',
    optionSource: 'all',
    preferSameType: true,
    totalChoices: difficulty === 'hard' ? 5 : 7,
  };
}

function getMixedConfig(difficulty) {
  if (difficulty === 'easy') {
    return getFrontToBackConfig('easy');
  }

  if (difficulty === 'normal') {
    return Math.random() < 0.5
      ? getFrontToBackConfig('normal')
      : getBackToFrontConfig('normal');
  }

  if (difficulty === 'hard') {
    return Math.random() < 0.5
      ? getFrontToBackConfig('hard')
      : getBackToFrontConfig('hard');
  }

  return Math.random() < 0.5
    ? getFrontToBackConfig('perfection')
    : getBackToFrontConfig('perfection');
}

function getQuestionText(card, field) {
  return field === 'front' ? card.front : card.back;
}
