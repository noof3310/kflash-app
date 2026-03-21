export async function migrateDbIfNeeded(db) {
  const DATABASE_VERSION = 2;
  const versionRow = await db.getFirstAsync('PRAGMA user_version');
  const currentVersion = versionRow?.user_version ?? 0;

  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `);

  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sets (
      id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY NOT NULL,
      front TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '',
      back TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(front, type, back)
    );

    CREATE TABLE IF NOT EXISTS card_progress (
      card_id INTEGER PRIMARY KEY NOT NULL,
      last_reviewed_at TEXT,
      next_due_at TEXT,
      correct_streak INTEGER NOT NULL DEFAULT 0,
      interval_days INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
    );
  `);

  if (currentVersion === 0) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS sets (
        id INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY NOT NULL,
        front TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT '',
        back TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(front, type, back)
      );

      CREATE TABLE IF NOT EXISTS set_cards (
        set_id INTEGER NOT NULL,
        card_id INTEGER NOT NULL,
        PRIMARY KEY (set_id, card_id),
        FOREIGN KEY (set_id) REFERENCES sets(id) ON DELETE CASCADE,
        FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS quiz_sessions (
        id INTEGER PRIMARY KEY NOT NULL,
        started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        score INTEGER NOT NULL,
        total INTEGER NOT NULL,
        selected_set_ids TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS quiz_answers (
        id INTEGER PRIMARY KEY NOT NULL,
        quiz_session_id INTEGER NOT NULL,
        card_id INTEGER NOT NULL,
        chosen_back TEXT NOT NULL,
        is_correct INTEGER NOT NULL,
        FOREIGN KEY (quiz_session_id) REFERENCES quiz_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS card_progress (
        card_id INTEGER PRIMARY KEY NOT NULL,
        last_reviewed_at TEXT,
        next_due_at TEXT,
        correct_streak INTEGER NOT NULL DEFAULT 0,
        interval_days INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (card_id) REFERENCES cards(id) ON DELETE CASCADE
      );
    `);
  }

  await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
}

export async function saveQuizSession(db, selectedSetIds, answers) {
  const score = answers.filter((item) => item.isCorrect).length;
  const sessionResult = await db.runAsync(
    'INSERT INTO quiz_sessions (score, total, selected_set_ids) VALUES (?, ?, ?)',
    [score, answers.length, JSON.stringify(selectedSetIds)]
  );

  const sessionId = sessionResult.lastInsertRowId;
  for (const answer of answers) {
    await db.runAsync(
      'INSERT INTO quiz_answers (quiz_session_id, card_id, chosen_back, is_correct) VALUES (?, ?, ?, ?)',
      [sessionId, answer.cardId, answer.chosenBack, answer.isCorrect ? 1 : 0]
    );
  }

  await updateCardProgress(db, answers);
}

export async function loadAppSettings(db, defaults) {
  const rows = await db.getAllAsync(
    'SELECT key, value FROM app_settings WHERE key IN (?, ?, ?, ?)',
    ['tts_rate', 'tts_pitch', 'theme', 'tts_voice']
  );

  const settingsMap = Object.fromEntries((rows ?? []).map((row) => [row.key, row.value]));

  return {
    rate: Number(settingsMap.tts_rate) || defaults.rate,
    pitch: Number(settingsMap.tts_pitch) || defaults.pitch,
    theme: settingsMap.theme || defaults.theme,
    voice: settingsMap.tts_voice || defaults.voice,
  };
}

async function updateCardProgress(db, answers) {
  if (!answers?.length) {
    return;
  }

  const uniqueCardIds = [...new Set(answers.map((answer) => answer.cardId))];
  const placeholders = uniqueCardIds.map(() => '?').join(',');
  const existingRows = await db.getAllAsync(
    `SELECT card_id, last_reviewed_at, next_due_at, correct_streak, interval_days
        FROM card_progress
     WHERE card_id IN (${placeholders})`,
    uniqueCardIds
  );

  const progressMap = new Map(
    (existingRows ?? []).map((row) => [
      row.card_id,
      {
        last_reviewed_at: row.last_reviewed_at,
        next_due_at: row.next_due_at,
        correct_streak: Number(row.correct_streak) || 0,
        interval_days: Number(row.interval_days) || 0,
      },
    ])
  );

  for (const answer of answers) {
    const nextProgress = getNextCardProgress(progressMap.get(answer.cardId), answer.isCorrect);
    progressMap.set(answer.cardId, nextProgress);
  }

  for (const [cardId, progress] of progressMap.entries()) {
    await db.runAsync(
      `INSERT INTO card_progress (card_id, last_reviewed_at, next_due_at, correct_streak, interval_days)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET
         last_reviewed_at = excluded.last_reviewed_at,
         next_due_at = excluded.next_due_at,
         correct_streak = excluded.correct_streak,
         interval_days = excluded.interval_days`,
      [
        cardId,
        progress.last_reviewed_at,
        progress.next_due_at,
        progress.correct_streak,
        progress.interval_days,
      ]
    );
  }
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
