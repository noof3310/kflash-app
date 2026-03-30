export function getSpeechLanguage(text) {
  if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(text)) {
    return 'ko-KR';
  }

  return undefined;
}

export function findSpeechPreviewText(cards) {
  const koreanCard = cards.find((card) => /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(card.front));
  return koreanCard?.front ?? '안녕하세요';
}

export function getThemeColors(theme = 'light') {
  if (theme === 'pink') {
    return {
      screenBackground: '#1a1c26',
      surface: '#242634',
      softSurface: '#2d2f42',
      elevatedSurface: '#303247',
      inputBackground: '#1e202b',
      border: '#494c66',
      primaryText: '#f7eff7',
      secondaryText: '#c7bed1',
      tertiaryText: '#9f93b1',
      primaryButton: '#ff7c8e',
      primaryButtonText: '#1a1c26',
      accentText: '#ff9aa8',
      softAccent: '#3a3150',
      accentBorder: '#9b7bd7',
      heroSurface: '#1e202b',
      heroBorder: '#5d4f7d',
      heroBadgeBackground: '#2d2f42',
      heroBadgeText: '#ff7c8e',
      stickySurface: 'rgba(26, 28, 38, 0.94)',
      modalBackdrop: 'rgba(10, 10, 16, 0.74)',
      dangerSurface: '#432632',
      dangerBorder: '#d06a8d',
      dangerText: '#ffc1cf',
      correctBackground: '#203a37',
      correctBorder: '#5bc7a8',
      correctText: '#b9f4e2',
      warningBackground: '#4a3244',
      warningBorder: '#f0a2c1',
      warningText: '#ffd9ea',
      errorBackground: '#4a2736',
      errorBorder: '#ff7c8e',
      errorText: '#ffd0d8',
    };
  }

  if (theme === 'dark') {
    return {
      screenBackground: '#0d1321',
      surface: '#151d2f',
      softSurface: '#1b2438',
      elevatedSurface: '#1f2940',
      inputBackground: '#121a2b',
      border: '#2c3957',
      primaryText: '#f4f7ff',
      secondaryText: '#9aabc9',
      tertiaryText: '#7485a7',
      primaryButton: '#7c96ff',
      primaryButtonText: '#0d1321',
      accentText: '#b7c5ff',
      softAccent: '#24314f',
      accentBorder: '#4d63a8',
      heroSurface: '#18233a',
      heroBorder: '#314269',
      heroBadgeBackground: '#223252',
      heroBadgeText: '#d8e1ff',
      stickySurface: 'rgba(13, 19, 33, 0.94)',
      modalBackdrop: 'rgba(3, 8, 20, 0.62)',
      dangerSurface: '#361a24',
      dangerBorder: '#8f3650',
      dangerText: '#ffb4c1',
      correctBackground: '#133321',
      correctBorder: '#2d8a57',
      correctText: '#86efac',
      warningBackground: '#3b2f12',
      warningBorder: '#c4931a',
      warningText: '#fde68a',
      errorBackground: '#3a1a22',
      errorBorder: '#c2415a',
      errorText: '#fda4af',
    };
  }

  return {
    screenBackground: '#f5f7fb',
    surface: '#ffffff',
    softSurface: '#f6f8fc',
    elevatedSurface: '#ffffff',
    inputBackground: '#fbfcff',
    border: '#d7dfef',
    primaryText: '#172033',
    secondaryText: '#5f6b85',
    tertiaryText: '#7b89a6',
    primaryButton: '#4461f2',
    primaryButtonText: '#ffffff',
    accentText: '#4461f2',
    softAccent: '#eef2ff',
    accentBorder: '#9fb1ff',
    heroSurface: '#eef3ff',
    heroBorder: '#c7d4ff',
    heroBadgeBackground: '#ffffff',
    heroBadgeText: '#3652d9',
    stickySurface: 'rgba(245, 247, 251, 0.96)',
    modalBackdrop: 'rgba(23, 32, 51, 0.25)',
    dangerSurface: '#fff1f1',
    dangerBorder: '#f3b7b7',
    dangerText: '#b42318',
    correctBackground: '#ecfdf3',
    correctBorder: '#6cd394',
    correctText: '#0f8a4b',
    warningBackground: '#fff8db',
    warningBorder: '#f2cf66',
    warningText: '#9a6700',
    errorBackground: '#fff1f3',
    errorBorder: '#f09aa9',
    errorText: '#c92c4b',
  };
}

export function formatReviewStats(card) {
  const attempts = Number(card.attempt_count) || 0;
  const correct = Number(card.correct_count) || 0;

  if (attempts === 0) {
    return '';
  }

  const accuracy = Math.round((correct / attempts) * 100);
  return `${correct}/${attempts} correct (${accuracy}%)`;
}

export function getAccuracyTone(accuracy, colors) {
  if (!Number.isFinite(accuracy)) {
    return null;
  }

  if (accuracy >= 85) {
    return {
      backgroundColor: colors.correctBackground,
      borderColor: colors.correctBorder,
    };
  }

  if (accuracy <= 50) {
    return {
      backgroundColor: colors.errorBackground,
      borderColor: colors.errorBorder,
    };
  }

  return {
    backgroundColor: colors.warningBackground,
    borderColor: colors.warningBorder,
  };
}

export function getCardReviewTone(card, colors) {
  const attempts = Number(card.attempt_count) || 0;
  const correct = Number(card.correct_count) || 0;

  if (attempts === 0) {
    return null;
  }

  return getAccuracyTone((correct / attempts) * 100, colors);
}
