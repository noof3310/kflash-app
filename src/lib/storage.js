import { buildEnrichedSets } from './sets';
import { loadAppSettings, migrateDbIfNeeded, saveQuizSession } from './db';

const WEB_STORAGE_KEY = 'flashcards-web-store-v1';

export function createNativeStorage(db) {
  return {
    async getDashboardData() {
      const fetchedSets = await db.getAllAsync(
        `SELECT s.id, s.name, s.created_at,
                COUNT(DISTINCT sc.card_id) AS card_count,
                COALESCE(SUM(CASE WHEN COALESCE(qa_stats.attempt_count, 0) = 0 THEN 1 ELSE 0 END), 0) AS new_card_count,
                COALESCE(SUM(CASE
                  WHEN cp.next_due_at IS NOT NULL AND datetime(cp.next_due_at) <= datetime('now') THEN 1
                  ELSE 0
                END), 0) AS due_card_count
         FROM sets s
         LEFT JOIN set_cards sc ON sc.set_id = s.id
         LEFT JOIN (
           SELECT card_id, COUNT(*) AS attempt_count
           FROM quiz_answers
           GROUP BY card_id
         ) qa_stats ON qa_stats.card_id = sc.card_id
         LEFT JOIN card_progress cp ON cp.card_id = sc.card_id
         GROUP BY s.id, s.name, s.created_at
         ORDER BY s.name COLLATE NOCASE ASC`
      );

      const sessionRows = await db.getAllAsync(
        `SELECT id, score, total, selected_set_ids
         FROM quiz_sessions`
      );

      const cards = await db.getAllAsync(
        `SELECT c.id, c.front, c.type, c.back AS back_text,
                CASE
                  WHEN TRIM(COALESCE(c.type, '')) != '' THEN '(' || TRIM(c.type) || ') ' || c.back
                  ELSE c.back
                END AS back,
                COALESCE(sc_stats.set_count, 0) AS set_count,
                COALESCE(qa_stats.attempt_count, 0) AS attempt_count,
                COALESCE(qa_stats.correct_count, 0) AS correct_count,
                cp.last_reviewed_at,
                cp.next_due_at,
                COALESCE(cp.correct_streak, 0) AS correct_streak,
                COALESCE(cp.interval_days, 0) AS interval_days
         FROM cards c
         LEFT JOIN (
           SELECT card_id, COUNT(DISTINCT set_id) AS set_count
           FROM set_cards
           GROUP BY card_id
         ) sc_stats ON sc_stats.card_id = c.id
         LEFT JOIN (
           SELECT card_id,
                  COUNT(*) AS attempt_count,
                  COALESCE(SUM(is_correct), 0) AS correct_count
           FROM quiz_answers
           GROUP BY card_id
         ) qa_stats ON qa_stats.card_id = c.id
         LEFT JOIN card_progress cp ON cp.card_id = c.id
         ORDER BY c.front COLLATE NOCASE ASC`
      );

      return {
        sets: buildEnrichedSets(fetchedSets, sessionRows),
        cards: cards ?? [],
      };
    },

    async loadSelectedCards(selectedSetIds) {
      if (!selectedSetIds.length) {
        return [];
      }

      const placeholders = selectedSetIds.map(() => '?').join(',');
      return db.getAllAsync(
        `SELECT c.id, c.front, c.type, c.back AS back_text,
                CASE
                  WHEN TRIM(COALESCE(c.type, '')) != '' THEN '(' || TRIM(c.type) || ') ' || c.back
                  ELSE c.back
                END AS back,
                COALESCE(qa_stats.attempt_count, 0) AS attempt_count,
                COALESCE(qa_stats.correct_count, 0) AS correct_count,
                cp.last_reviewed_at,
                cp.next_due_at,
                COALESCE(cp.correct_streak, 0) AS correct_streak,
                COALESCE(cp.interval_days, 0) AS interval_days
         FROM cards c
         INNER JOIN set_cards sc ON sc.card_id = c.id
         LEFT JOIN (
           SELECT card_id,
                  COUNT(*) AS attempt_count,
                  COALESCE(SUM(is_correct), 0) AS correct_count
           FROM quiz_answers
           GROUP BY card_id
         ) qa_stats ON qa_stats.card_id = c.id
         LEFT JOIN card_progress cp ON cp.card_id = c.id
         WHERE sc.set_id IN (${placeholders})
         GROUP BY c.id, c.front, c.type, c.back, qa_stats.attempt_count, qa_stats.correct_count,
                  cp.last_reviewed_at, cp.next_due_at, cp.correct_streak, cp.interval_days
         ORDER BY c.front COLLATE NOCASE ASC`,
        selectedSetIds
      );
    },

    async loadDistractorBiasMap(selectedSetIds) {
      if (!selectedSetIds.length) {
        return {};
      }

      const placeholders = selectedSetIds.map(() => '?').join(',');
      const rows = await db.getAllAsync(
        `SELECT qa.card_id, qa.chosen_back, COUNT(*) AS wrong_count
         FROM quiz_answers qa
         INNER JOIN set_cards sc ON sc.card_id = qa.card_id
         WHERE sc.set_id IN (${placeholders}) AND qa.is_correct = 0
         GROUP BY qa.card_id, qa.chosen_back`,
        selectedSetIds
      );

      return buildDistractorBiasMap(rows);
    },

    importCsvRows(rows) {
      return db.withTransactionAsync(async () => {
        for (const row of rows) {
          let setRecord = await db.getFirstAsync(
            'SELECT id FROM sets WHERE lower(name) = lower(?) LIMIT 1',
            [row.set]
          );

          if (!setRecord) {
            const createSetResult = await db.runAsync('INSERT INTO sets (name) VALUES (?)', [row.set]);
            setRecord = { id: createSetResult.lastInsertRowId };
          }

          let cardRecord = await db.getFirstAsync(
            'SELECT id FROM cards WHERE front = ? AND type = ? AND back = ? LIMIT 1',
            [row.front, row.type, row.back]
          );

          if (!cardRecord) {
            const createCardResult = await db.runAsync(
              'INSERT INTO cards (front, type, back) VALUES (?, ?, ?)',
              [row.front, row.type, row.back]
            );
            cardRecord = { id: createCardResult.lastInsertRowId };
          }

          await db.runAsync(
            'INSERT OR IGNORE INTO set_cards (set_id, card_id) VALUES (?, ?)',
            [setRecord.id, cardRecord.id]
          );
        }
      });
    },

    createSet(name) {
      return db.runAsync('INSERT INTO sets (name) VALUES (?)', [name]);
    },

    saveSetting(key, value) {
      return db.runAsync(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, String(value)]
      );
    },

    loadAppSettings(defaults) {
      return loadAppSettings(db, defaults);
    },

    saveQuizSession(selectedSetIds, answers) {
      return saveQuizSession(db, selectedSetIds, answers);
    },

    async exportLearningProgressRows() {
      const rows = await db.getAllAsync(
        `SELECT c.front,
                c.type,
                c.back,
                COALESCE(GROUP_CONCAT(DISTINCT s.name), '') AS sets,
                COALESCE(qa_stats.attempt_count, 0) AS attempt_count,
                COALESCE(qa_stats.correct_count, 0) AS correct_count,
                cp.last_reviewed_at,
                cp.next_due_at,
                COALESCE(cp.correct_streak, 0) AS correct_streak,
                COALESCE(cp.interval_days, 0) AS interval_days
         FROM cards c
         LEFT JOIN set_cards sc ON sc.card_id = c.id
         LEFT JOIN sets s ON s.id = sc.set_id
         LEFT JOIN (
           SELECT card_id,
                  COUNT(*) AS attempt_count,
                  COALESCE(SUM(is_correct), 0) AS correct_count
           FROM quiz_answers
           GROUP BY card_id
         ) qa_stats ON qa_stats.card_id = c.id
         LEFT JOIN card_progress cp ON cp.card_id = c.id
         GROUP BY c.id, c.front, c.type, c.back, qa_stats.attempt_count, qa_stats.correct_count,
                  cp.last_reviewed_at, cp.next_due_at, cp.correct_streak, cp.interval_days
         ORDER BY c.front COLLATE NOCASE ASC`
      );

      return buildExportRows(rows ?? []);
    },

    async importLearningProgressRows(rows) {
      await db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM quiz_answers');
        await db.runAsync('DELETE FROM quiz_sessions');
        await db.runAsync('DELETE FROM card_progress');

        const importedCards = [];
        const setAccuracyStats = new Map();

        for (const row of rows) {
          const setIds = [];
          for (const setName of row.setNames) {
            let setRecord = await db.getFirstAsync(
              'SELECT id FROM sets WHERE lower(name) = lower(?) LIMIT 1',
              [setName]
            );

            if (!setRecord) {
              const createSetResult = await db.runAsync('INSERT INTO sets (name) VALUES (?)', [setName]);
              setRecord = { id: createSetResult.lastInsertRowId };
            }

            setIds.push(Number(setRecord.id));
          }

          let cardRecord = await db.getFirstAsync(
            'SELECT id FROM cards WHERE front = ? AND type = ? AND back = ? LIMIT 1',
            [row.front, row.type, row.back]
          );

          if (!cardRecord) {
            const createCardResult = await db.runAsync(
              'INSERT INTO cards (front, type, back) VALUES (?, ?, ?)',
              [row.front, row.type, row.back]
            );
            cardRecord = { id: createCardResult.lastInsertRowId };
          }

          for (const setId of setIds) {
            await db.runAsync(
              'INSERT OR IGNORE INTO set_cards (set_id, card_id) VALUES (?, ?)',
              [setId, cardRecord.id]
            );
          }

          importedCards.push({
            ...row,
            cardId: Number(cardRecord.id),
          });

          for (const setId of setIds) {
            const current = setAccuracyStats.get(setId) ?? { attempts: 0, correct: 0 };
            current.attempts += row.attemptCount;
            current.correct += row.correctCount;
            setAccuracyStats.set(setId, current);
          }
        }

        const answersSessionResult = await db.runAsync(
          'INSERT INTO quiz_sessions (score, total, selected_set_ids) VALUES (?, ?, ?)',
          [0, 0, '[]']
        );

        const answersSessionId = Number(answersSessionResult.lastInsertRowId);

        for (const row of importedCards) {
          for (let index = 0; index < row.correctCount; index += 1) {
            await db.runAsync(
              'INSERT INTO quiz_answers (quiz_session_id, card_id, chosen_back, is_correct) VALUES (?, ?, ?, ?)',
              [answersSessionId, row.cardId, row.back, 1]
            );
          }

          for (let index = 0; index < row.incorrectCount; index += 1) {
            await db.runAsync(
              'INSERT INTO quiz_answers (quiz_session_id, card_id, chosen_back, is_correct) VALUES (?, ?, ?, ?)',
              [answersSessionId, row.cardId, '__imported_incorrect__', 0]
            );
          }

          await db.runAsync(
            `INSERT INTO card_progress (card_id, last_reviewed_at, next_due_at, correct_streak, interval_days)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(card_id) DO UPDATE SET
               last_reviewed_at = excluded.last_reviewed_at,
               next_due_at = excluded.next_due_at,
               correct_streak = excluded.correct_streak,
               interval_days = excluded.interval_days`,
            [
              row.cardId,
              row.lastReviewedAt || null,
              row.nextDueAt || null,
              row.correctStreak,
              row.intervalDays,
            ]
          );
        }

        for (const [setId, stats] of setAccuracyStats.entries()) {
          if (!stats.attempts) {
            continue;
          }

          const score = Math.round((stats.correct / stats.attempts) * 100);
          await db.runAsync(
            'INSERT INTO quiz_sessions (score, total, selected_set_ids) VALUES (?, ?, ?)',
            [score, 100, JSON.stringify([setId])]
          );
        }
      });
    },

    clearAllData() {
      return db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM card_progress');
        await db.runAsync('DELETE FROM quiz_answers');
        await db.runAsync('DELETE FROM quiz_sessions');
        await db.runAsync('DELETE FROM set_cards');
        await db.runAsync('DELETE FROM cards');
        await db.runAsync('DELETE FROM sets');
      });
    },

    async resetSchema() {
      await db.execAsync(`
        DROP TABLE IF EXISTS set_cards;
        DROP TABLE IF EXISTS quiz_answers;
        DROP TABLE IF EXISTS quiz_sessions;
        DROP TABLE IF EXISTS card_progress;
        DROP TABLE IF EXISTS cards;
        DROP TABLE IF EXISTS sets;
        DROP TABLE IF EXISTS app_settings;
        PRAGMA user_version = 0;
      `);

      await migrateDbIfNeeded(db);
    },
  };
}

export function createWebStorage() {
  return {
    async getDashboardData() {
      const store = readWebStore();
      return {
        sets: buildEnrichedSets(buildFetchedSets(store), store.quizSessions),
        cards: buildCardRows(store),
      };
    },

    async loadSelectedCards(selectedSetIds) {
      const store = readWebStore();
      return buildSelectedCards(store, selectedSetIds);
    },

    async loadDistractorBiasMap(selectedSetIds) {
      const store = readWebStore();
      const selectedCardIds = new Set(getSelectedCardIds(store, selectedSetIds));
      const rows = store.quizAnswers
        .filter((answer) => !answer.is_correct && selectedCardIds.has(answer.card_id))
        .reduce((accumulator, answer) => {
          const key = `${answer.card_id}::${answer.chosen_back}`;
          const current = accumulator.get(key) ?? {
            card_id: answer.card_id,
            chosen_back: answer.chosen_back,
            wrong_count: 0,
          };
          current.wrong_count += 1;
          accumulator.set(key, current);
          return accumulator;
        }, new Map());

      return buildDistractorBiasMap(Array.from(rows.values()));
    },

    async importCsvRows(rows) {
      const store = readWebStore();

      for (const row of rows) {
        let setRecord = store.sets.find((item) => item.name.toLowerCase() === row.set.toLowerCase());
        if (!setRecord) {
          setRecord = {
            id: store.nextIds.set++,
            name: row.set,
            created_at: nowIso(),
          };
          store.sets.push(setRecord);
        }

        let cardRecord = store.cards.find(
          (item) => item.front === row.front && item.type === row.type && item.back === row.back
        );
        if (!cardRecord) {
          cardRecord = {
            id: store.nextIds.card++,
            front: row.front,
            type: row.type,
            back: row.back,
            created_at: nowIso(),
          };
          store.cards.push(cardRecord);
        }

        const exists = store.setCards.some(
          (item) => item.set_id === setRecord.id && item.card_id === cardRecord.id
        );
        if (!exists) {
          store.setCards.push({
            set_id: setRecord.id,
            card_id: cardRecord.id,
          });
        }
      }

      writeWebStore(store);
    },

    async createSet(name) {
      const store = readWebStore();
      if (store.sets.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('duplicate');
      }

      store.sets.push({
        id: store.nextIds.set++,
        name,
        created_at: nowIso(),
      });
      writeWebStore(store);
    },

    async saveSetting(key, value) {
      const store = readWebStore();
      store.appSettings[key] = String(value);
      writeWebStore(store);
    },

    async loadAppSettings(defaults) {
      const store = readWebStore();
      return {
        rate: Number(store.appSettings.tts_rate) || defaults.rate,
        pitch: Number(store.appSettings.tts_pitch) || defaults.pitch,
        theme: store.appSettings.theme || defaults.theme,
      };
    },

    async saveQuizSession(selectedSetIds, answers) {
      const store = readWebStore();
      const score = answers.filter((item) => item.isCorrect).length;
      const sessionId = store.nextIds.quizSession++;

      store.quizSessions.push({
        id: sessionId,
        started_at: nowIso(),
        score,
        total: answers.length,
        selected_set_ids: JSON.stringify(selectedSetIds),
      });

      for (const answer of answers) {
        store.quizAnswers.push({
          id: store.nextIds.quizAnswer++,
          quiz_session_id: sessionId,
          card_id: answer.cardId,
          chosen_back: answer.chosenBack,
          is_correct: answer.isCorrect ? 1 : 0,
        });
      }

      updateWebCardProgress(store, answers);
      writeWebStore(store);
    },

    async exportLearningProgressRows() {
      const store = readWebStore();
      return buildExportRows(buildExportRowsFromStore(store));
    },

    async importLearningProgressRows(rows) {
      const store = readWebStore();
      store.quizSessions = [];
      store.quizAnswers = [];
      store.cardProgress = [];

      const setAccuracyStats = new Map();
      const importedCards = [];

      for (const row of rows) {
        const setIds = [];
        for (const setName of row.setNames) {
          let setRecord = store.sets.find((item) => item.name.toLowerCase() === setName.toLowerCase());
          if (!setRecord) {
            setRecord = {
              id: store.nextIds.set++,
              name: setName,
              created_at: nowIso(),
            };
            store.sets.push(setRecord);
          }

          setIds.push(setRecord.id);
        }

        let cardRecord = store.cards.find(
          (item) => item.front === row.front && item.type === row.type && item.back === row.back
        );
        if (!cardRecord) {
          cardRecord = {
            id: store.nextIds.card++,
            front: row.front,
            type: row.type,
            back: row.back,
            created_at: nowIso(),
          };
          store.cards.push(cardRecord);
        }

        for (const setId of setIds) {
          const exists = store.setCards.some(
            (item) => item.set_id === setId && item.card_id === cardRecord.id
          );
          if (!exists) {
            store.setCards.push({
              set_id: setId,
              card_id: cardRecord.id,
            });
          }
        }

        importedCards.push({
          ...row,
          cardId: cardRecord.id,
        });

        for (const setId of setIds) {
          const current = setAccuracyStats.get(setId) ?? { attempts: 0, correct: 0 };
          current.attempts += row.attemptCount;
          current.correct += row.correctCount;
          setAccuracyStats.set(setId, current);
        }
      }

      const answersSessionId = store.nextIds.quizSession++;
      store.quizSessions.push({
        id: answersSessionId,
        started_at: nowIso(),
        score: 0,
        total: 0,
        selected_set_ids: '[]',
      });

      for (const row of importedCards) {
        for (let index = 0; index < row.correctCount; index += 1) {
          store.quizAnswers.push({
            id: store.nextIds.quizAnswer++,
            quiz_session_id: answersSessionId,
            card_id: row.cardId,
            chosen_back: row.back,
            is_correct: 1,
          });
        }

        for (let index = 0; index < row.incorrectCount; index += 1) {
          store.quizAnswers.push({
            id: store.nextIds.quizAnswer++,
            quiz_session_id: answersSessionId,
            card_id: row.cardId,
            chosen_back: '__imported_incorrect__',
            is_correct: 0,
          });
        }

        store.cardProgress.push({
          card_id: row.cardId,
          last_reviewed_at: row.lastReviewedAt || null,
          next_due_at: row.nextDueAt || null,
          correct_streak: row.correctStreak,
          interval_days: row.intervalDays,
        });
      }

      for (const [setId, stats] of setAccuracyStats.entries()) {
        if (!stats.attempts) {
          continue;
        }

        store.quizSessions.push({
          id: store.nextIds.quizSession++,
          started_at: nowIso(),
          score: Math.round((stats.correct / stats.attempts) * 100),
          total: 100,
          selected_set_ids: JSON.stringify([setId]),
        });
      }

      writeWebStore(store);
    },

    async clearAllData() {
      const store = readWebStore();
      store.sets = [];
      store.cards = [];
      store.setCards = [];
      store.quizSessions = [];
      store.quizAnswers = [];
      store.cardProgress = [];
      store.nextIds = getInitialWebStore().nextIds;
      writeWebStore(store);
    },

    async resetSchema() {
      writeWebStore(getInitialWebStore());
    },
  };
}

function buildFetchedSets(store) {
  const attemptCountByCardId = new Map();
  for (const answer of store.quizAnswers) {
    const current = attemptCountByCardId.get(answer.card_id) ?? 0;
    attemptCountByCardId.set(answer.card_id, current + 1);
  }

  const progressByCardId = new Map(store.cardProgress.map((item) => [item.card_id, item]));

  return store.sets
    .map((set) => {
      const cardIds = store.setCards
        .filter((item) => item.set_id === set.id)
        .map((item) => item.card_id);

      const newCardCount = cardIds.filter((cardId) => (attemptCountByCardId.get(cardId) ?? 0) === 0).length;
      const dueCardCount = cardIds.filter((cardId) => {
        const progress = progressByCardId.get(cardId);
        if (!progress?.next_due_at) {
          return false;
        }

        const dueAt = Date.parse(progress.next_due_at);
        return Number.isFinite(dueAt) && dueAt <= Date.now();
      }).length;

      return {
        id: set.id,
        name: set.name,
        created_at: set.created_at,
        card_count: cardIds.length,
        new_card_count: newCardCount,
        due_card_count: dueCardCount,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function buildCardRows(store) {
  const setCountByCardId = new Map();
  for (const relation of store.setCards) {
    const current = setCountByCardId.get(relation.card_id) ?? 0;
    setCountByCardId.set(relation.card_id, current + 1);
  }

  const statsByCardId = getAnswerStatsByCardId(store.quizAnswers);
  const progressByCardId = new Map(store.cardProgress.map((item) => [item.card_id, item]));

  return [...store.cards]
    .map((card) => {
      const stats = statsByCardId.get(card.id) ?? { attempt_count: 0, correct_count: 0 };
      const progress = progressByCardId.get(card.id) ?? {};

      return {
        id: card.id,
        front: card.front,
        type: card.type,
        back_text: card.back,
        back: formatCardBack(card.type, card.back),
        set_count: setCountByCardId.get(card.id) ?? 0,
        attempt_count: stats.attempt_count,
        correct_count: stats.correct_count,
        last_reviewed_at: progress.last_reviewed_at ?? null,
        next_due_at: progress.next_due_at ?? null,
        correct_streak: Number(progress.correct_streak) || 0,
        interval_days: Number(progress.interval_days) || 0,
      };
    })
    .sort((left, right) => left.front.localeCompare(right.front));
}

function buildSelectedCards(store, selectedSetIds) {
  if (!selectedSetIds.length) {
    return [];
  }

  const selectedCardIds = new Set(getSelectedCardIds(store, selectedSetIds));
  const statsByCardId = getAnswerStatsByCardId(store.quizAnswers);
  const progressByCardId = new Map(store.cardProgress.map((item) => [item.card_id, item]));

  return store.cards
    .filter((card) => selectedCardIds.has(card.id))
    .map((card) => {
      const stats = statsByCardId.get(card.id) ?? { attempt_count: 0, correct_count: 0 };
      const progress = progressByCardId.get(card.id) ?? {};

      return {
        id: card.id,
        front: card.front,
        type: card.type,
        back_text: card.back,
        back: formatCardBack(card.type, card.back),
        attempt_count: stats.attempt_count,
        correct_count: stats.correct_count,
        last_reviewed_at: progress.last_reviewed_at ?? null,
        next_due_at: progress.next_due_at ?? null,
        correct_streak: Number(progress.correct_streak) || 0,
        interval_days: Number(progress.interval_days) || 0,
      };
    })
    .sort((left, right) => left.front.localeCompare(right.front));
}

function getSelectedCardIds(store, selectedSetIds) {
  const selectedSetIdSet = new Set(selectedSetIds.map(Number));
  return Array.from(
    new Set(
      store.setCards
        .filter((item) => selectedSetIdSet.has(Number(item.set_id)))
        .map((item) => Number(item.card_id))
    )
  );
}

function getAnswerStatsByCardId(quizAnswers) {
  const statsByCardId = new Map();

  for (const answer of quizAnswers) {
    const current = statsByCardId.get(answer.card_id) ?? { attempt_count: 0, correct_count: 0 };
    current.attempt_count += 1;
    current.correct_count += Number(answer.is_correct) ? 1 : 0;
    statsByCardId.set(answer.card_id, current);
  }

  return statsByCardId;
}

function updateWebCardProgress(store, answers) {
  const progressByCardId = new Map(store.cardProgress.map((item) => [item.card_id, item]));

  for (const answer of answers) {
    const nextProgress = getNextCardProgress(progressByCardId.get(answer.cardId), answer.isCorrect);
    progressByCardId.set(answer.cardId, {
      card_id: answer.cardId,
      ...nextProgress,
    });
  }

  store.cardProgress = Array.from(progressByCardId.values());
}

function buildDistractorBiasMap(rows) {
  return (rows ?? []).reduce((map, row) => {
    const cardId = Number(row.card_id);
    if (!map[cardId]) {
      map[cardId] = {};
    }

    map[cardId][row.chosen_back] = Number(row.wrong_count) || 0;
    return map;
  }, {});
}

function buildExportRows(rows) {
  return rows.map((row) => {
    const attempts = Number(row.attempt_count) || 0;
    const correct = Number(row.correct_count) || 0;
    const accuracyPercent = attempts > 0 ? Math.round((correct / attempts) * 100) : '';

    return {
      front: row.front,
      type: row.type,
      back: row.back,
      sets: row.sets || '',
      attempt_count: attempts,
      correct_count: correct,
      accuracy_percent: accuracyPercent,
      last_reviewed_at: row.last_reviewed_at || '',
      next_due_at: row.next_due_at || '',
      correct_streak: Number(row.correct_streak) || 0,
      interval_days: Number(row.interval_days) || 0,
    };
  });
}

function buildExportRowsFromStore(store) {
  const statsByCardId = getAnswerStatsByCardId(store.quizAnswers);
  const progressByCardId = new Map(store.cardProgress.map((item) => [item.card_id, item]));
  const setNamesById = new Map(store.sets.map((set) => [set.id, set.name]));
  const setNamesByCardId = new Map();

  for (const relation of store.setCards) {
    const current = setNamesByCardId.get(relation.card_id) ?? [];
    const setName = setNamesById.get(relation.set_id);
    if (setName && !current.includes(setName)) {
      current.push(setName);
    }
    setNamesByCardId.set(relation.card_id, current);
  }

  return [...store.cards]
    .map((card) => {
      const stats = statsByCardId.get(card.id) ?? { attempt_count: 0, correct_count: 0 };
      const progress = progressByCardId.get(card.id) ?? {};

      return {
        front: card.front,
        type: card.type,
        back: card.back,
        sets: (setNamesByCardId.get(card.id) ?? []).sort((left, right) => left.localeCompare(right)).join(' | '),
        attempt_count: stats.attempt_count,
        correct_count: stats.correct_count,
        last_reviewed_at: progress.last_reviewed_at ?? '',
        next_due_at: progress.next_due_at ?? '',
        correct_streak: Number(progress.correct_streak) || 0,
        interval_days: Number(progress.interval_days) || 0,
      };
    })
    .sort((left, right) => left.front.localeCompare(right.front));
}

function formatCardBack(type, back) {
  return type?.trim() ? `(${type.trim()}) ${back}` : back;
}

function readWebStore() {
  if (typeof localStorage === 'undefined') {
    return getInitialWebStore();
  }

  try {
    const raw = localStorage.getItem(WEB_STORAGE_KEY);
    if (!raw) {
      const initial = getInitialWebStore();
      localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(initial));
      return initial;
    }

    return normalizeWebStore(JSON.parse(raw));
  } catch {
    return getInitialWebStore();
  }
}

function writeWebStore(store) {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(normalizeWebStore(store)));
}

function normalizeWebStore(store = {}) {
  const initial = getInitialWebStore();
  return {
    version: 1,
    nextIds: {
      set: Number(store?.nextIds?.set) || initial.nextIds.set,
      card: Number(store?.nextIds?.card) || initial.nextIds.card,
      quizSession: Number(store?.nextIds?.quizSession) || initial.nextIds.quizSession,
      quizAnswer: Number(store?.nextIds?.quizAnswer) || initial.nextIds.quizAnswer,
    },
    appSettings: { ...(store.appSettings ?? {}) },
    sets: Array.isArray(store.sets) ? store.sets : [],
    cards: Array.isArray(store.cards) ? store.cards : [],
    setCards: Array.isArray(store.setCards) ? store.setCards : [],
    quizSessions: Array.isArray(store.quizSessions) ? store.quizSessions : [],
    quizAnswers: Array.isArray(store.quizAnswers) ? store.quizAnswers : [],
    cardProgress: Array.isArray(store.cardProgress) ? store.cardProgress : [],
  };
}

function getInitialWebStore() {
  return {
    version: 1,
    nextIds: {
      set: 1,
      card: 1,
      quizSession: 1,
      quizAnswer: 1,
    },
    appSettings: {},
    sets: [],
    cards: [],
    setCards: [],
    quizSessions: [],
    quizAnswers: [],
    cardProgress: [],
  };
}

function nowIso() {
  return new Date().toISOString();
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
