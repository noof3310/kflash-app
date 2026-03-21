import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Easing,
  LayoutAnimation,
  Modal,
  Platform,
  Pressable as RNPressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { setAudioModeAsync, useAudioPlayer } from './src/lib/audio';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import Papa from 'papaparse';
import { SQLiteProvider, useSQLiteContext } from './src/lib/nativeSqliteProvider';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { migrateDbIfNeeded } from './src/lib/db';
import {
  buildAdaptiveQuizItem,
  buildLiveReviewCards,
  sortCardsForStudy,
} from './src/lib/quiz';
import { filterAndSortSets, formatSetStats } from './src/lib/sets';
import { createNativeStorage, createWebStorage } from './src/lib/storage';
import {
  findSpeechPreviewText,
  formatReviewStats,
  getAccuracyTone,
  getCardReviewTone,
  getSpeechLanguage,
  getThemeColors,
} from './src/lib/ui';
import {
  getTtsProviderStatus,
  loadTtsVoices,
  speakWithTts,
  stopTtsPlayback,
  TTS_PROVIDER_OPTIONS,
  TTS_PROVIDER_SYSTEM,
} from './src/lib/tts';

const DB_NAME = 'flashcards.db';
const QUIZ_SIZE_OPTIONS = [10, 20, 30];
const TTS_RATE_OPTIONS = [0.3, 0.6, 0.9];
const TTS_PITCH_OPTIONS = [0.8, 1.0, 1.2];
const DEFAULT_TTS_RATE = 0.9;
const DEFAULT_TTS_PITCH = 1.0;
const DEFAULT_TTS_VOICE = '';
const DEFAULT_TTS_PROVIDER = TTS_PROVIDER_SYSTEM;
const DEFAULT_THEME = 'light';
const QUIZ_FEEDBACK_DELAY_MS = 900;
const QUIZ_CORRECT_SOUND_DURATION_MS = 600;
const QUIZ_WRONG_SOUND_DURATION_MS = 750;
const QUIZ_FEEDBACK_FOLLOWUP_SPEECH_DELAY_MS = 0;
const QUIZ_NEXT_FRONT_AUTOPLAY_DELAY_MS = 500;
const QUIZ_POST_ANSWER_SPEECH_BUFFER_MS = 400;
const QUIZ_DONT_KNOW_OPTION = "I don't know the answer";
const HOME_SET_PREVIEW_COUNT = 8;
const SET_FILTER_OPTIONS = ['all', 'selected', 'unplayed', 'weak', 'strong'];
const SET_SORT_OPTIONS = ['priority', 'name', 'lowest score', 'highest score'];
const QUIZ_DIRECTION_OPTIONS = [
  { value: 'front-to-back', label: 'Front -> Back' },
  { value: 'back-to-front', label: 'Back -> Front' },
];
const DEBUG_UNLOCK_TAP_COUNT = 7;
const DEBUG_UNLOCK_WINDOW_MS = 1800;
const EXAMPLE_CSV_TEXT = `front,type,back,set
은 / 는,marker,topic marker,Example
가다,v.,ไป,Example
오다,v.,มา,Example
하다,v.,ทำ,Example
먹다,v.,กิน,Example
보다,v.,ดู / เห็น,Example
오늘,n.,วันนี้,Example
지금,adv.,ตอนนี้,Example
집,n.,บ้าน,Example
학교,n.,โรงเรียน,Example
친구,n.,เพื่อน,Example
사람,n.,คน,Example
여기,adv.,ที่นี่,Example
저기,adv.,ตรงนั้น / ที่นั่น,Example`;
const CORRECT_SOUND = require('./assets/sounds/correct.wav');
const WRONG_SOUND = require('./assets/sounds/wrong.wav');
const AnimatedScrollView = Animated.createAnimatedComponent(ScrollView);
const AnimatedPressableBase = Animated.createAnimatedComponent(RNPressable);

function Pressable({ style, onPressIn, onPressOut, pressScale = 0.982, ...props }) {
  const scale = useRef(new Animated.Value(1)).current;

  const animatePressIn = useCallback(() => {
    scale.stopAnimation();
    Animated.timing(scale, {
      toValue: pressScale,
      duration: 55,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [pressScale, scale]);

  const animatePressOut = useCallback(() => {
    scale.stopAnimation();
    Animated.sequence([
      Animated.timing(scale, {
        toValue: 1.012,
        duration: 65,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: 1,
        duration: 80,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [scale]);

  return (
    <AnimatedPressableBase
      {...props}
      style={[style, { transform: [{ scale }] }]}
      onPressIn={(event) => {
        animatePressIn();
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        animatePressOut();
        onPressOut?.(event);
      }}
    />
  );
}

export default function App() {
  if (Platform.OS === 'web') {
    return (
      <SafeAreaProvider>
        <AppErrorBoundary>
          <WebAppShell />
        </AppErrorBoundary>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SQLiteProvider databaseName={DB_NAME} onInit={migrateDbIfNeeded}>
        <AppErrorBoundary>
          <NativeAppShell />
        </AppErrorBoundary>
      </SQLiteProvider>
    </SafeAreaProvider>
  );
}

function WebAppShell() {
  const storage = useMemo(() => createWebStorage(), []);
  return <AppShell storage={storage} />;
}

function NativeAppShell() {
  const db = useSQLiteContext();
  const storage = useMemo(() => createNativeStorage(db), [db]);
  return <AppShell storage={storage} />;
}

function AppShell({ storage }) {
  const [screen, setScreen] = useState('home');
  const [sets, setSets] = useState([]);
  const [cards, setCards] = useState([]);
  const [selectedSetIds, setSelectedSetIds] = useState([]);
  const [reviewCards, setReviewCards] = useState([]);
  const [distractorBiasMap, setDistractorBiasMap] = useState({});
  const [quizSize, setQuizSize] = useState(10);
  const [quizSizeInput, setQuizSizeInput] = useState('10');
  const [quizTargetCount, setQuizTargetCount] = useState(0);
  const [quizDirectionMode, setQuizDirectionMode] = useState('front-to-back');
  const [quizItems, setQuizItems] = useState([]);
  const [quizIndex, setQuizIndex] = useState(0);
  const [answers, setAnswers] = useState([]);
  const [quizFeedback, setQuizFeedback] = useState(null);
  const [importing, setImporting] = useState(false);
  const [setSearchQuery, setSetSearchQuery] = useState('');
  const [setFilter, setSetFilter] = useState('all');
  const [setSort, setSetSort] = useState('priority');
  const [showAllSets, setShowAllSets] = useState(false);
  const [ttsRate, setTtsRate] = useState(DEFAULT_TTS_RATE);
  const [ttsPitch, setTtsPitch] = useState(DEFAULT_TTS_PITCH);
  const [ttsVoice, setTtsVoice] = useState(DEFAULT_TTS_VOICE);
  const [ttsProvider, setTtsProvider] = useState(DEFAULT_TTS_PROVIDER);
  const [theme, setTheme] = useState(DEFAULT_THEME);
  const [reviewScreenKey, setReviewScreenKey] = useState(0);
  const [debugCountryFilter, setDebugCountryFilter] = useState('all');
  const [debugInfo, setDebugInfo] = useState({
    loading: false,
    error: '',
    voices: [],
    effectiveProvider: DEFAULT_TTS_PROVIDER,
    providerMessage: '',
    fallback: false,
  });
  const feedbackTimeoutRef = useRef(null);
  const feedbackSoundRequestRef = useRef(0);
  const nextPromptAutoplayDelayRef = useRef(0);
  const debugUnlockTapCountRef = useRef(0);
  const debugUnlockTimerRef = useRef(null);
  const reviewScrollRef = useRef(null);
  const screenOpacity = useRef(new Animated.Value(0)).current;
  const screenTranslateY = useRef(new Animated.Value(18)).current;
  const heroFloat = useRef(new Animated.Value(10)).current;
  const correctPlayer = useAudioPlayer(CORRECT_SOUND);
  const wrongPlayer = useAudioPlayer(WRONG_SOUND);
  const scrollReviewToTop = useCallback(() => {
    const scrollTarget = reviewScrollRef.current?.getNode?.() ?? reviewScrollRef.current;
    scrollTarget?.scrollTo?.({ y: 0, animated: false });
  }, []);

  const refreshAll = useCallback(async () => {
    const dashboardData = await storage.getDashboardData();
    setSets(dashboardData.sets ?? []);
    setCards(dashboardData.cards ?? []);
  }, [storage]);

  const loadDebugInfo = useCallback(async () => {
    setDebugInfo((prev) => ({ ...prev, loading: true, error: '' }));

    try {
      const voiceResult = await loadTtsVoices({ provider: ttsProvider });
      setDebugInfo({
        loading: false,
        error: '',
        voices: Array.isArray(voiceResult.voices) ? voiceResult.voices : [],
        effectiveProvider: voiceResult.effectiveProvider,
        providerMessage: voiceResult.message || '',
        fallback: Boolean(voiceResult.fallback),
      });
    } catch (error) {
      setDebugInfo({
        loading: false,
        error: error?.message ?? 'Could not load available voices.',
        voices: [],
        effectiveProvider: getTtsProviderStatus(ttsProvider).effectiveProvider,
        providerMessage: '',
        fallback: false,
      });
    }
  }, [ttsProvider]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    storage.loadAppSettings({
      rate: DEFAULT_TTS_RATE,
      pitch: DEFAULT_TTS_PITCH,
      voice: DEFAULT_TTS_VOICE,
      provider: DEFAULT_TTS_PROVIDER,
      theme: DEFAULT_THEME,
    }).then((settings) => {
      setTtsRate(settings.rate);
      setTtsPitch(settings.pitch);
      setTtsVoice(settings.voice || DEFAULT_TTS_VOICE);
      setTtsProvider(settings.provider || DEFAULT_TTS_PROVIDER);
      setTheme(settings.theme);
    });
  }, [storage]);

  useEffect(() => {
    return () => {
      if (debugUnlockTimerRef.current) {
        clearTimeout(debugUnlockTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
  }, []);

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
    }).catch(() => {});
  }, []);

  useEffect(() => () => {
    if (feedbackTimeoutRef.current) {
      clearTimeout(feedbackTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    screenOpacity.setValue(0);
    screenTranslateY.setValue(18);

    Animated.parallel([
      Animated.timing(screenOpacity, {
        toValue: 1,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(screenTranslateY, {
        toValue: 0,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [screen, screenOpacity, screenTranslateY]);

  useEffect(() => {
    if (screen !== 'home') {
      return undefined;
    }

    heroFloat.setValue(10);
    Animated.spring(heroFloat, {
      toValue: 0,
      damping: 14,
      stiffness: 120,
      mass: 0.9,
      useNativeDriver: true,
    }).start();

    return undefined;
  }, [heroFloat, screen, selectedSetIds.length]);

  useLayoutEffect(() => {
    if (screen !== 'review') {
      return undefined;
    }

    const frameId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollReviewToTop();
      });
    });

    return () => cancelAnimationFrame(frameId);
  }, [reviewCards.length, screen, scrollReviewToTop]);

  const totalCards = cards.length;
  const totalSets = sets.length;
  const hasSelectedSets = selectedSetIds.length > 0;
  const normalizedSetSearchQuery = setSearchQuery.trim().toLowerCase();
  const selectedSets = useMemo(
    () => sets.filter((item) => selectedSetIds.includes(item.id)),
    [selectedSetIds, sets]
  );
  const filteredSets = useMemo(() => {
    return filterAndSortSets(sets, {
      searchQuery: normalizedSetSearchQuery,
      selectedSetIds,
      setFilter,
      setSort,
    });
  }, [normalizedSetSearchQuery, selectedSetIds, setFilter, setSort, sets]);
  const visibleSets = useMemo(() => {
    if (showAllSets || normalizedSetSearchQuery) {
      return filteredSets;
    }

    return filteredSets.slice(0, HOME_SET_PREVIEW_COUNT);
  }, [filteredSets, normalizedSetSearchQuery, showAllSets]);
  const hasMoreSetsToShow = !normalizedSetSearchQuery && filteredSets.length > HOME_SET_PREVIEW_COUNT;
  const prioritizedCards = useMemo(() => sortCardsForStudy(cards), [cards]);
  const visibleCards = useMemo(() => prioritizedCards.slice(0, 30), [prioritizedCards]);
  const prioritizedReviewCards = useMemo(() => sortCardsForStudy(reviewCards), [reviewCards]);
  const selectedSetSummary = useMemo(
    () =>
      selectedSets.reduce(
        (summary, item) => ({
          cardCount: summary.cardCount + (Number(item.card_count) || 0),
          dueCount: summary.dueCount + (Number(item.due_card_count) || 0),
          newCount: summary.newCount + (Number(item.new_card_count) || 0),
        }),
        { cardCount: 0, dueCount: 0, newCount: 0 }
      ),
    [selectedSets]
  );
  const debugCountryOptions = useMemo(() => {
    const countryCodes = Array.from(
      new Set(
        (debugInfo.voices ?? [])
          .map((voice) => getVoiceCountryCode(voice))
          .filter(Boolean)
      )
    ).sort((left, right) => left.localeCompare(right));

    return [{ value: 'all', label: 'All countries' }].concat(
      countryCodes.map((code) => ({
        value: code,
        label: formatVoiceCountryLabel(code),
      }))
    );
  }, [debugInfo.voices]);
  const filteredDebugVoices = useMemo(() => {
    if (debugCountryFilter === 'all') {
      return debugInfo.voices;
    }

    return (debugInfo.voices ?? []).filter(
      (voice) => getVoiceCountryCode(voice) === debugCountryFilter
    );
  }, [debugCountryFilter, debugInfo.voices]);
  const reviewSummary = useMemo(
    () => ({
      newCount: reviewCards.filter((item) => (Number(item.attempt_count) || 0) === 0).length,
      weakCount: reviewCards.filter((item) => {
        const accuracy = getCardAccuracyPercent(item);
        return accuracy !== null && accuracy <= 50;
      }).length,
      strongCount: reviewCards.filter((item) => {
        const accuracy = getCardAccuracyPercent(item);
        return accuracy !== null && accuracy >= 90;
      }).length,
    }),
    [reviewCards]
  );
  const resultCards = useMemo(() => {
    const liveReviewCards = buildLiveReviewCards(reviewCards, answers);
    const liveCardMap = new Map((liveReviewCards ?? []).map((card) => [card.id, card]));

    const enrichedAnswers = (answers ?? []).map((answer) => {
      const liveCard = liveCardMap.get(answer.cardId);

      return {
        ...answer,
        id: answer.cardId,
        back: answer.back,
        attempt_count: Number(liveCard?.attempt_count) || 0,
        correct_count: Number(liveCard?.correct_count) || 0,
        last_reviewed_at: liveCard?.last_reviewed_at ?? null,
        next_due_at: liveCard?.next_due_at ?? null,
        correct_streak: Number(liveCard?.correct_streak) || 0,
        interval_days: Number(liveCard?.interval_days) || 0,
      };
    });

    return [...enrichedAnswers].sort((left, right) => {
      if (left.isCorrect !== right.isCorrect) {
        return left.isCorrect ? 1 : -1;
      }

      const leftAttempts = Number(left.attempt_count) || 0;
      const rightAttempts = Number(right.attempt_count) || 0;
      const leftCorrect = Number(left.correct_count) || 0;
      const rightCorrect = Number(right.correct_count) || 0;
      const leftAccuracy = leftAttempts > 0 ? leftCorrect / leftAttempts : 1;
      const rightAccuracy = rightAttempts > 0 ? rightCorrect / rightAttempts : 1;

      if (leftAccuracy !== rightAccuracy) {
        return leftAccuracy - rightAccuracy;
      }

      return left.front.localeCompare(right.front);
    });
  }, [answers, reviewCards]);
  const resultSummary = useMemo(
    () => ({
      incorrectCount: answers.filter((item) => !item.isCorrect).length,
      strongCount: resultCards.filter((item) => {
        const accuracy = getCardAccuracyPercent(item);
        return accuracy !== null && accuracy >= 90;
      }).length,
      weakCount: resultCards.filter((item) => {
        const accuracy = getCardAccuracyPercent(item);
        return accuracy !== null && accuracy <= 50;
      }).length,
    }),
    [answers, resultCards]
  );
  const isDarkMode = theme === 'dark';
  const colors = useMemo(() => getThemeColors(isDarkMode), [isDarkMode]);
  const statusBarStyle = isDarkMode ? 'light' : 'dark';
  const currentTtsProviderStatus = useMemo(
    () => getTtsProviderStatus(ttsProvider),
    [ttsProvider]
  );

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') {
      return undefined;
    }

    const { documentElement, body } = document;
    const root = document.getElementById('root');
    const previousHtmlBackground = documentElement.style.backgroundColor;
    const previousHtmlColorScheme = documentElement.style.colorScheme;
    const previousBodyBackground = body.style.backgroundColor;
    const previousBodyOverscroll = body.style.overscrollBehaviorY;
    const previousRootBackground = root?.style.backgroundColor ?? '';
    const previousRootOverscroll = root?.style.overscrollBehaviorY ?? '';

    documentElement.style.backgroundColor = colors.screenBackground;
    documentElement.style.colorScheme = isDarkMode ? 'dark' : 'light';
    body.style.backgroundColor = colors.screenBackground;
    body.style.overscrollBehaviorY = 'none';

    if (root) {
      root.style.backgroundColor = colors.screenBackground;
      root.style.overscrollBehaviorY = 'none';
    }

    let themeColorMeta = document.querySelector('meta[name="theme-color"]');
    let createdThemeColorMeta = false;
    if (!themeColorMeta) {
      themeColorMeta = document.createElement('meta');
      themeColorMeta.setAttribute('name', 'theme-color');
      document.head.appendChild(themeColorMeta);
      createdThemeColorMeta = true;
    }
    const previousThemeColor = themeColorMeta.getAttribute('content');
    themeColorMeta.setAttribute('content', colors.screenBackground);

    return () => {
      documentElement.style.backgroundColor = previousHtmlBackground;
      documentElement.style.colorScheme = previousHtmlColorScheme;
      body.style.backgroundColor = previousBodyBackground;
      body.style.overscrollBehaviorY = previousBodyOverscroll;

      if (root) {
        root.style.backgroundColor = previousRootBackground;
        root.style.overscrollBehaviorY = previousRootOverscroll;
      }

      if (themeColorMeta) {
        if (previousThemeColor) {
          themeColorMeta.setAttribute('content', previousThemeColor);
        } else if (createdThemeColorMeta) {
          themeColorMeta.remove();
        } else {
          themeColorMeta.removeAttribute('content');
        }
      }
    };
  }, [colors.screenBackground, isDarkMode]);

  useEffect(() => {
    if (screen !== 'debug') {
      return undefined;
    }

    loadDebugInfo();
    return undefined;
  }, [loadDebugInfo, screen]);

  useEffect(() => {
    if (debugCountryFilter === 'all') {
      return undefined;
    }

    if (!debugCountryOptions.some((option) => option.value === debugCountryFilter)) {
      setDebugCountryFilter('all');
    }

    return undefined;
  }, [debugCountryFilter, debugCountryOptions]);
  const animatedScreenStyle = {
    opacity: screenOpacity,
    transform: [{ translateY: screenTranslateY }],
  };
  const animatedFooterStyle = {
    opacity: screenOpacity,
    transform: [
      {
        translateY: screenTranslateY.interpolate({
          inputRange: [0, 18],
          outputRange: [0, 10],
        }),
      },
    ],
  };
  const animatedHeroStyle = {
    transform: [{ translateY: heroFloat }],
  };
  const isFrontToBackEnabled =
    quizDirectionMode === 'front-to-back' || quizDirectionMode === 'mixed';
  const isBackToFrontEnabled =
    quizDirectionMode === 'back-to-front' || quizDirectionMode === 'mixed';

  useEffect(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }, [answers.length, filteredSets.length, quizFeedback, reviewCards.length, selectedSetIds.length, showAllSets]);

  const toggleQuizDirection = useCallback((direction) => {
    setQuizDirectionMode((currentMode) => {
      const nextFrontToBackEnabled =
        direction === 'front-to-back' ? !isModeEnabled(currentMode, 'front-to-back') : isModeEnabled(currentMode, 'front-to-back');
      const nextBackToFrontEnabled =
        direction === 'back-to-front' ? !isModeEnabled(currentMode, 'back-to-front') : isModeEnabled(currentMode, 'back-to-front');

      if (nextFrontToBackEnabled && nextBackToFrontEnabled) {
        return 'mixed';
      }

      if (nextFrontToBackEnabled) {
        return 'front-to-back';
      }

      if (nextBackToFrontEnabled) {
        return 'back-to-front';
      }

      return currentMode;
    });
  }, []);

  const startQuiz = useCallback(async () => {
    const rawRows = reviewCards;

    if (!rawRows || rawRows.length < 4) {
      showAlert(
        'Not enough cards',
        'You need at least 4 unique cards across the selected sets for multiple choice.'
      );
      return;
    }

    const requestedSize = Number.parseInt(quizSizeInput, 10);
    if (!Number.isFinite(requestedSize) || requestedSize <= 0) {
      showAlert('Invalid quiz size', 'Enter a number greater than 0.');
      return;
    }

    const firstQuizItem = buildAdaptiveQuizItem(
      rawRows,
      cards,
      [],
      0,
      QUIZ_DONT_KNOW_OPTION,
      distractorBiasMap,
      quizDirectionMode
    );

    setQuizTargetCount(requestedSize);
    setQuizItems(firstQuizItem ? [firstQuizItem] : []);
    setQuizIndex(0);
    setAnswers([]);
    setQuizFeedback(null);
    if (feedbackTimeoutRef.current) {
      clearTimeout(feedbackTimeoutRef.current);
    }
    setScreen('quiz');
  }, [cards, distractorBiasMap, quizDirectionMode, quizSizeInput, reviewCards]);

  const currentItem = quizItems[quizIndex];
  const progressText = quizTargetCount ? `${Math.min(quizIndex + 1, quizTargetCount)} / ${quizTargetCount}` : '0 / 0';

  useEffect(() => {
    if (screen !== 'quiz' || currentItem?.promptField !== 'front' || !currentItem?.promptText) {
      return undefined;
    }

    const delayMs = nextPromptAutoplayDelayRef.current;
    nextPromptAutoplayDelayRef.current = 0;
    const timeoutId = setTimeout(() => {
      speakFrontText(currentItem.promptText);
    }, delayMs);

    return () => clearTimeout(timeoutId);
  }, [currentItem?.promptField, currentItem?.promptText, screen, ttsPitch, ttsRate]);

  const prepareNextQuestionAutoplay = (previousItem, nextItem) => {
    nextPromptAutoplayDelayRef.current =
      previousItem?.promptField === 'back' && nextItem?.promptField === 'front'
        ? QUIZ_NEXT_FRONT_AUTOPLAY_DELAY_MS
        : 0;
  };

  const handleAnswer = async (option) => {
    if (!currentItem || quizFeedback) {
      return;
    }

    const isCorrect = option === currentItem.correctOption;
    const nextAnswers = [
      ...answers,
      {
        quizItemInstanceId: currentItem.instanceId,
        cardId: currentItem.id,
        front: currentItem.front,
        back: currentItem.back,
        promptText: currentItem.promptText,
        promptField: currentItem.promptField,
        correctOption: currentItem.correctOption,
        chosenBack: option,
        isCorrect,
      },
    ];

    setAnswers(nextAnswers);
    setQuizFeedback({
      chosenBack: option,
      isCorrect,
      correctOption: currentItem.correctOption,
    });
    requestAnimationFrame(() => {
      playPostAnswerAudio(currentItem, isCorrect).catch(() => {});
    });

    if (isCorrect) {
      const nextAdvanceDelay = getQuizAdvanceDelayMs(currentItem, ttsRate);
      feedbackTimeoutRef.current = setTimeout(async () => {
        setQuizFeedback(null);

        if (quizIndex + 1 < quizTargetCount) {
          const nextQuizItem = buildAdaptiveQuizItem(
            reviewCards,
            cards,
            nextAnswers,
            quizIndex + 1,
            QUIZ_DONT_KNOW_OPTION,
            distractorBiasMap,
            quizDirectionMode
          );
          if (nextQuizItem) {
            prepareNextQuestionAutoplay(currentItem, nextQuizItem);
            setQuizItems((prev) => [...prev, nextQuizItem]);
          }
          setQuizIndex((prev) => prev + 1);
          return;
        }

        await storage.saveQuizSession(selectedSetIds, nextAnswers);
        setScreen('results');
      }, nextAdvanceDelay);
    }
  };

  const correctCount = answers.filter((item) => item.isCorrect).length;

  const loadSelectedCards = useCallback(async () => {
    return storage.loadSelectedCards(selectedSetIds);
  }, [selectedSetIds, storage]);

  const loadDistractorBiasMap = useCallback(async () => {
    return storage.loadDistractorBiasMap(selectedSetIds);
  }, [selectedSetIds, storage]);

  const openReviewScreen = useCallback(async () => {
    if (selectedSetIds.length === 0) {
      showAlert('Choose at least one set', 'Pick one or more sets before continuing.');
      return;
    }

    const [rows, nextDistractorBiasMap] = await Promise.all([
      loadSelectedCards(),
      loadDistractorBiasMap(),
    ]);
    if (!rows?.length) {
      showAlert('No cards found', 'The selected sets do not contain any cards yet.');
      return;
    }

    setReviewCards(rows);
    setDistractorBiasMap(nextDistractorBiasMap);
    setReviewScreenKey((prev) => prev + 1);
    setScreen('review');
  }, [loadDistractorBiasMap, loadSelectedCards, selectedSetIds.length]);

  const handleImportCsv = async () => {
    try {
      setImporting(true);
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'public.comma-separated-values-text'],
        multiple: false,
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        return;
      }

      const asset = result.assets?.[0];
      if (!asset) {
        throw new Error('Could not read the selected file.');
      }

      const csvText = await readImportedText(asset);
      const rows = parseImportCsvRows(csvText);

      await storage.importCsvRows(rows);

      await refreshAll();
      showAlert('Import complete', `Loaded ${rows.length} cards from CSV.`);
    } catch (error) {
      showAlert('Import failed', error?.message ?? 'Something went sideways while importing.');
    } finally {
      setImporting(false);
    }
  };

  const handleImportExampleSet = async () => {
    try {
      const rows = parseImportCsvRows(EXAMPLE_CSV_TEXT);
      await storage.importCsvRows(rows);
      await refreshAll();
      showAlert('Example set ready', `Loaded ${rows.length} cards into the Example set.`);
    } catch (error) {
      showAlert('Could not load example set', error?.message ?? 'Something went wrong while loading the example set.');
    }
  };

  const handleExportLearningProgress = async () => {
    try {
      const rows = await storage.exportLearningProgressRows();

      if (!rows.length) {
        showAlert('Nothing to export', 'There is no learning progress to export yet.');
        return;
      }

      const csvText = Papa.unparse(rows);
      const filename = `learning-progress-${new Date().toISOString().slice(0, 10)}.csv`;

      if (Platform.OS === 'web') {
        downloadCsvOnWeb(filename, csvText);
        showAlert('Export ready', 'Your learning progress CSV has been downloaded.');
        return;
      }

      const documentDirectory = FileSystem.documentDirectory || FileSystem.cacheDirectory;
      if (!documentDirectory) {
        throw new Error('No writable export directory is available on this device.');
      }

      const fileUri = `${documentDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(fileUri, csvText);
      showAlert('Export saved', `Learning progress exported to:\n\n${fileUri}`);
    } catch (error) {
      showAlert('Export failed', error?.message ?? 'Could not export learning progress.');
    }
  };

  const handleImportLearningProgress = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/csv', 'text/comma-separated-values', 'public.comma-separated-values-text'],
        multiple: false,
        copyToCacheDirectory: true,
      });

      if (result.canceled) {
        return;
      }

      const asset = result.assets?.[0];
      if (!asset) {
        throw new Error('Could not read the selected backup file.');
      }

      const csvText = await readImportedText(asset);
      const parsed = Papa.parse(csvText, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => header.trim().toLowerCase(),
      });

      if (parsed.errors?.length) {
        throw new Error(parsed.errors[0].message);
      }

      const rows = normalizeImportedLearningProgressRows(parsed.data ?? []);
      if (!rows.length) {
        throw new Error(
          'Backup has no usable rows. Required columns: front, type, back, sets, attempt_count, correct_count'
        );
      }

      showConfirm({
        title: 'Import learning progress?',
        message:
          'This will replace current learning progress stats on this device with the backup file. Cards and sets from the backup will be merged in.',
        confirmText: 'Import backup',
        destructive: true,
        onConfirm: async () => {
          try {
            await storage.importLearningProgressRows(rows);
            await refreshAll();
            setQuizFeedback(null);
            setReviewCards([]);
            setDistractorBiasMap({});
            setQuizItems([]);
            setQuizIndex(0);
            setAnswers([]);
            setQuizTargetCount(0);
            setScreen('home');
            showAlert('Import complete', `Restored learning progress for ${rows.length} cards.`);
          } catch (error) {
            showAlert('Import failed', error?.message ?? 'Could not import learning progress.');
          }
        },
      });
    } catch (error) {
      showAlert('Import failed', error?.message ?? 'Could not import learning progress.');
    }
  };

  const toggleSetSelection = (setId) => {
    setSelectedSetIds((prev) =>
      prev.includes(setId) ? prev.filter((id) => id !== setId) : [...prev, setId]
    );
  };

  const speakText = useCallback(
    (text, overrides = {}) => {
      const language = overrides.language ?? getSpeechLanguage(text);

      return speakWithTts({
        provider: overrides.provider ?? ttsProvider,
        text,
        rate: overrides.rate ?? ttsRate,
        pitch: overrides.pitch ?? ttsPitch,
        language,
        voice: (overrides.voice ?? ttsVoice) || undefined,
      });
    },
    [ttsPitch, ttsProvider, ttsRate, ttsVoice]
  );

  const speakFrontText = useCallback(
    (text) => {
      speakText(text);
    },
    [speakText]
  );

  const previewVoice = useCallback(
    (voice) => {
      const language = String(voice?.language || voice?.lang || '').toLowerCase();
      let sampleText = 'Flash card preview';

      if (language.startsWith('ko')) {
        sampleText = findSpeechPreviewText(cards);
      } else if (language.startsWith('th')) {
        sampleText = 'สวัสดี นี่คือเสียงตัวอย่าง';
      } else if (language.startsWith('ja')) {
        sampleText = 'こんにちは これはサンプルです';
      } else if (language.startsWith('zh')) {
        sampleText = '你好 这是示例语音';
      } else if (language.startsWith('es')) {
        sampleText = 'Hola, esta es una voz de muestra';
      }

      speakText(sampleText, {
        language: voice?.language || voice?.lang || undefined,
        voice: voice?.identifier || voice?.voiceURI || undefined,
      });
    },
    [cards, speakText]
  );

  const playFeedbackSound = async (isCorrect) => {
    const requestId = feedbackSoundRequestRef.current + 1;
    feedbackSoundRequestRef.current = requestId;

    await stopTtsPlayback();

    try {
      correctPlayer.pause();
      wrongPlayer.pause();

      if (Platform.OS !== 'web') {
        await wait(40);
      }
      if (feedbackSoundRequestRef.current !== requestId) {
        return null;
      }

      const player = isCorrect ? correctPlayer : wrongPlayer;
      player.seekTo(0);
      player.play();
      return requestId;
    } catch (error) {
      await speakWithTts({
        provider: TTS_PROVIDER_SYSTEM,
        text: isCorrect ? 'Correct' : 'Incorrect',
        rate: 0.95,
        pitch: isCorrect ? 1.0 : 0.85,
      });
      return requestId;
    }
  };

  const playPostAnswerAudio = async (quizItem, isCorrect) => {
    const requestId = await playFeedbackSound(isCorrect);
    if (!requestId || quizItem?.promptField !== 'back') {
      return;
    }

    await wait(getPostFeedbackSpeechDelayMs(isCorrect));
    if (feedbackSoundRequestRef.current !== requestId) {
      return;
    }

    speakFrontText(quizItem.front);
  };

  const updateSpeechSetting = useCallback(
    async (key, value, setter) => {
      setter(value);

      try {
        await storage.saveSetting(key, value);
      } catch (error) {
        showAlert('Could not save setting', 'The speech setting could not be saved.');
      }
    },
    [storage]
  );

  const clearAllData = useCallback(() => {
    showConfirm({
      title: 'Clear all data?',
      message: 'This will remove all sets, cards, and quiz history. Speech settings will be kept.',
      confirmText: 'Clear everything',
      destructive: true,
      onConfirm: async () => {
        try {
          if (feedbackTimeoutRef.current) {
            clearTimeout(feedbackTimeoutRef.current);
          }

          await storage.clearAllData();

          setSelectedSetIds([]);
          setDistractorBiasMap({});
          setReviewCards([]);
          setQuizTargetCount(0);
          setQuizItems([]);
          setQuizIndex(0);
          setAnswers([]);
          setQuizFeedback(null);
          setScreen('home');
          await refreshAll();
          showAlert('Data cleared', 'All flash card data has been removed.');
        } catch (error) {
          showAlert('Could not clear data', 'Something went wrong while deleting your data.');
        }
      },
    });
  }, [refreshAll, storage]);

  const resetDatabaseSchema = useCallback(() => {
    showConfirm({
      title: 'Reset DB schema?',
      message: 'This will delete all data and rebuild the local database structure from scratch.',
      confirmText: 'Reset schema',
      destructive: true,
      onConfirm: async () => {
        try {
          if (feedbackTimeoutRef.current) {
            clearTimeout(feedbackTimeoutRef.current);
          }

          await storage.resetSchema();

          setSelectedSetIds([]);
          setDistractorBiasMap({});
          setReviewCards([]);
          setQuizTargetCount(0);
          setQuizItems([]);
          setQuizIndex(0);
          setAnswers([]);
          setQuizFeedback(null);
          setTheme(DEFAULT_THEME);
          setTtsRate(DEFAULT_TTS_RATE);
          setTtsPitch(DEFAULT_TTS_PITCH);
          setTtsVoice(DEFAULT_TTS_VOICE);
          setTtsProvider(DEFAULT_TTS_PROVIDER);
          setScreen('home');
          await refreshAll();
          showAlert('Schema reset', 'The local database has been rebuilt.');
        } catch (error) {
          showAlert('Could not reset schema', 'Something went wrong while rebuilding the database.');
        }
      },
    });
  }, [refreshAll, storage]);

  const updateTheme = useCallback(
    async (nextTheme) => {
      setTheme(nextTheme);

      try {
        await storage.saveSetting('theme', nextTheme);
      } catch (error) {
        showAlert('Could not save setting', 'The theme setting could not be saved.');
      }
    },
    [storage]
  );

  const goHome = async () => {
    if (feedbackTimeoutRef.current) {
      clearTimeout(feedbackTimeoutRef.current);
    }
    await stopTtsPlayback();
    await refreshAll();
    setSetSearchQuery('');
    setShowAllSets(false);
    setQuizFeedback(null);
    setDistractorBiasMap({});
    setReviewCards([]);
    setQuizTargetCount(0);
    setScreen('home');
  };

  const goToReview = useCallback(async () => {
    if (feedbackTimeoutRef.current) {
      clearTimeout(feedbackTimeoutRef.current);
    }

    if (selectedSetIds.length === 0) {
      await refreshAll();
      setQuizFeedback(null);
      setDistractorBiasMap({});
      setReviewCards([]);
      setScreen('home');
      return;
    }

    const [rows, nextDistractorBiasMap] = await Promise.all([
      loadSelectedCards(),
      loadDistractorBiasMap(),
    ]);
    setQuizFeedback(null);
    setDistractorBiasMap(nextDistractorBiasMap);
    setReviewCards(rows ?? []);
    setReviewScreenKey((prev) => prev + 1);
    setScreen('review');
  }, [loadDistractorBiasMap, loadSelectedCards, refreshAll, selectedSetIds.length]);

  const handleDebugUnlockTap = useCallback(() => {
    debugUnlockTapCountRef.current += 1;

    if (debugUnlockTimerRef.current) {
      clearTimeout(debugUnlockTimerRef.current);
    }

    if (debugUnlockTapCountRef.current >= DEBUG_UNLOCK_TAP_COUNT) {
      debugUnlockTapCountRef.current = 0;
      setScreen('debug');
      return;
    }

    debugUnlockTimerRef.current = setTimeout(() => {
      debugUnlockTapCountRef.current = 0;
    }, DEBUG_UNLOCK_WINDOW_MS);
  }, []);

  if (screen === 'review') {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.screenBackground }]}>
        <StatusBar style={statusBarStyle} />
        <AnimatedScrollView
          key={`review-${reviewScreenKey}`}
          ref={reviewScrollRef}
          style={animatedScreenStyle}
          contentContainerStyle={[styles.container, styles.containerWithFooter]}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={scrollReviewToTop}
          contentOffset={{ x: 0, y: 0 }}
        >
          <View style={styles.quizHeaderRow}>
            <Pressable
              style={[styles.secondaryButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={goHome}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.primaryText }]}>Back</Text>
            </Pressable>
            <Text style={[styles.progressText, { color: colors.secondaryText }]}>
              {reviewCards.length} cards
            </Text>
          </View>

          <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Review selected cards</Text>
            <Text style={[styles.mutedText, { color: colors.secondaryText }]}>
              Scan through the selected cards before choosing how many quiz questions you want.
            </Text>
            <View style={styles.summaryPillRow}>
              <View style={[styles.summaryPill, { backgroundColor: colors.softAccent, borderColor: colors.accentBorder }]}>
                <Text style={[styles.summaryPillValue, { color: colors.accentText }]}>{selectedSetIds.length}</Text>
                <Text style={[styles.summaryPillLabel, { color: colors.secondaryText }]}>Sets</Text>
              </View>
              <View style={[styles.summaryPill, { backgroundColor: colors.softAccent, borderColor: colors.accentBorder }]}>
                <Text style={[styles.summaryPillValue, { color: colors.accentText }]}>{reviewSummary.newCount}</Text>
                <Text style={[styles.summaryPillLabel, { color: colors.secondaryText }]}>New</Text>
              </View>
              <View style={[styles.summaryPill, { backgroundColor: colors.softAccent, borderColor: colors.accentBorder }]}>
                <Text style={[styles.summaryPillValue, { color: colors.accentText }]}>{reviewSummary.weakCount}</Text>
                <Text style={[styles.summaryPillLabel, { color: colors.secondaryText }]}>Weak</Text>
              </View>
            </View>
          </View>

          <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Quiz size</Text>
            <View style={styles.quizSizeRow}>
              {QUIZ_SIZE_OPTIONS.map((size) => {
                const active = quizSize === size;
                return (
                  <Pressable
                    key={size}
                    style={[
                      styles.quizSizeChip,
                      { borderColor: colors.border },
                      active && { backgroundColor: colors.primaryText, borderColor: colors.primaryText },
                    ]}
                    onPress={() => {
                      setQuizSize(size);
                      setQuizSizeInput(String(size));
                    }}
                  >
                    <Text style={[styles.quizSizeText, { color: active ? colors.surface : colors.primaryText }]}>{size}</Text>
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              value={quizSizeInput}
              onChangeText={(value) => {
                const sanitized = value.replace(/[^0-9]/g, '');
                setQuizSizeInput(sanitized);
                if (sanitized) {
                  setQuizSize(Number.parseInt(sanitized, 10));
                }
              }}
              keyboardType="number-pad"
              placeholder="Custom number of questions"
              placeholderTextColor={colors.secondaryText}
              style={[
                styles.input,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.inputBackground,
                  color: colors.primaryText,
                },
              ]}
            />
          </View>

          <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Quiz direction</Text>
            <View style={styles.filterRow}>
              {QUIZ_DIRECTION_OPTIONS.map((option) => {
                const active = isModeEnabled(quizDirectionMode, option.value);
                return (
                  <Pressable
                    key={option.value}
                    style={[
                      styles.filterChip,
                      { backgroundColor: colors.softSurface, borderColor: colors.border },
                      active && { backgroundColor: colors.primaryText, borderColor: colors.primaryText },
                    ]}
                    onPress={() => toggleQuizDirection(option.value)}
                  >
                    <Text style={[styles.filterChipText, { color: active ? colors.surface : colors.primaryText }]}>
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[styles.mutedText, { color: colors.secondaryText }]}>
              {isFrontToBackEnabled && isBackToFrontEnabled
                ? 'Both directions selected'
                : isFrontToBackEnabled
                  ? 'Front -> Back only'
                  : 'Back -> Front only'}
            </Text>
          </View>

          <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Cards in selected sets</Text>
            {prioritizedReviewCards.map((item) => (
              <View
                key={item.id}
                style={[
                  styles.cardRow,
                  { backgroundColor: colors.elevatedSurface, borderColor: colors.border },
                  getCardReviewTone(item, colors),
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cardFront, { color: colors.primaryText }]}>{item.front}</Text>
                  <Text style={[styles.cardBack, { color: colors.secondaryText }]}>{item.back}</Text>
                  {formatReviewStats(item) ? (
                    <Text style={[styles.reviewStatText, { color: colors.secondaryText }]}>
                      {formatReviewStats(item)}
                    </Text>
                  ) : null}
                </View>
                <Pressable
                  style={[styles.listenMiniButton, { backgroundColor: colors.softAccent }]}
                  onPress={() => speakFrontText(item.front)}
                >
                  <Text style={styles.listenMiniText}>🔊</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </AnimatedScrollView>

        <Animated.View style={[styles.stickyFooter, animatedFooterStyle, { backgroundColor: colors.stickySurface, borderColor: colors.border }]}>
          <Pressable style={[styles.primaryButton, { backgroundColor: colors.primaryButton }]} onPress={startQuiz}>
            <Text style={[styles.primaryButtonText, { color: colors.primaryButtonText }]}>Start quiz</Text>
          </Pressable>
        </Animated.View>
      </SafeAreaView>
    );
  }

  if (screen === 'quiz' && currentItem) {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.screenBackground }]}>
        <StatusBar style={statusBarStyle} />
        <Animated.View
          style={[
            styles.container,
            styles.quizScreenContainer,
            animatedScreenStyle,
            quizFeedback && !quizFeedback.isCorrect && styles.containerWithFooter,
          ]}
        >
          <View style={styles.quizHeaderRow}>
            <Pressable style={[styles.secondaryButton, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={goHome}>
              <Text style={[styles.secondaryButtonText, { color: colors.primaryText }]}>Back</Text>
            </Pressable>
            <Text style={[styles.progressText, { color: colors.secondaryText }]}>{progressText}</Text>
          </View>

          <View style={[styles.quizCard, styles.quizCardCompact, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.quizLabel, { color: colors.secondaryText }]}>
              {currentItem.promptField === 'front' ? 'What matches this card?' : 'Which word matches this meaning?'}
            </Text>
            <Text
              numberOfLines={2}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
              style={[styles.frontText, { color: colors.primaryText }]}
            >
              {currentItem.promptText}
            </Text>
            {currentItem.promptField === 'front' ? (
              <Pressable
                style={[styles.listenMiniButton, { backgroundColor: colors.softAccent }]}
                onPress={() => speakFrontText(currentItem.promptText)}
              >
                <Text style={styles.listenMiniText}>🔊</Text>
              </Pressable>
            ) : null}
          </View>

          <ScrollView
            style={styles.quizOptionsScroll}
            contentContainerStyle={[styles.optionsContainer, styles.optionsContainerCompact]}
            showsVerticalScrollIndicator={false}
          >
            {currentItem.options.map((option, optionIndex) => (
              <Pressable
                key={`${currentItem.instanceId}-${optionIndex}-${option}`}
                style={[
                  styles.optionButton,
                  styles.optionButtonCompact,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  quizFeedback?.chosenBack === option &&
                    (quizFeedback.isCorrect
                      ? { backgroundColor: colors.correctBackground, borderColor: colors.correctBorder }
                      : { backgroundColor: colors.errorBackground, borderColor: colors.errorBorder }),
                  !quizFeedback?.isCorrect &&
                    quizFeedback?.correctOption === option && {
                      backgroundColor: colors.correctBackground,
                      borderColor: colors.correctBorder,
                    },
                ]}
                onPress={() => handleAnswer(option)}
              >
                <View style={styles.optionContentRow}>
                  <Text
                    numberOfLines={2}
                    style={[
                      styles.optionText,
                      styles.optionTextCompact,
                      styles.optionTextWrap,
                      { color: colors.primaryText },
                    ]}
                  >
                    {option}
                  </Text>
                  {currentItem.promptField === 'back' && option !== QUIZ_DONT_KNOW_OPTION ? (
                    <Pressable
                      style={[styles.optionSoundButton, { backgroundColor: colors.softAccent, borderColor: colors.border }]}
                      onPress={(event) => {
                        event?.stopPropagation?.();
                        speakFrontText(option);
                      }}
                    >
                      <Text style={styles.optionSoundText}>🔊</Text>
                    </Pressable>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </Animated.View>

        {quizFeedback && !quizFeedback.isCorrect ? (
          <Animated.View style={[styles.stickyFooter, animatedFooterStyle, { backgroundColor: colors.stickySurface, borderColor: colors.border }]}>
            <View
              style={[
                styles.feedbackCard,
                styles.feedbackStickyCard,
                {
                  backgroundColor: colors.errorBackground,
                  borderColor: colors.errorBorder,
                },
              ]}
            >
              <Text style={[styles.feedbackTitle, { color: colors.errorText }]}>Incorrect</Text>
              <Text style={[styles.feedbackDetail, { color: colors.primaryText }]}>
                Correct answer: {quizFeedback.correctOption}
              </Text>
              <Pressable
                style={[styles.feedbackConfirmButton, { backgroundColor: colors.primaryButton }]}
                onPress={async () => {
                  const finalAnswers = [
                    ...answers,
                    {
                      quizItemInstanceId: currentItem.instanceId,
                      cardId: currentItem.id,
                      front: currentItem.front,
                      back: currentItem.back,
                      promptText: currentItem.promptText,
                      promptField: currentItem.promptField,
                      correctOption: currentItem.correctOption,
                      chosenBack: quizFeedback.chosenBack,
                      isCorrect: false,
                    },
                  ];

                  setQuizFeedback(null);

                  if (quizIndex + 1 < quizTargetCount) {
                    const nextQuizItem = buildAdaptiveQuizItem(
                      reviewCards,
                      cards,
                      finalAnswers,
                      quizIndex + 1,
                      QUIZ_DONT_KNOW_OPTION,
                      distractorBiasMap,
                      quizDirectionMode
                  );
                  if (nextQuizItem) {
                    prepareNextQuestionAutoplay(currentItem, nextQuizItem);
                    setQuizItems((prev) => [...prev, nextQuizItem]);
                  }
                    setQuizIndex((prev) => prev + 1);
                    return;
                  }

                  await storage.saveQuizSession(selectedSetIds, finalAnswers);
                  setScreen('results');
                }}
              >
                <Text style={[styles.feedbackConfirmText, { color: colors.primaryButtonText }]}>Confirm and continue</Text>
              </Pressable>
            </View>
          </Animated.View>
        ) : null}
      </SafeAreaView>
    );
  }

  if (screen === 'results') {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.screenBackground }]}>
        <StatusBar style={statusBarStyle} />
        <AnimatedScrollView
          style={animatedScreenStyle}
          contentContainerStyle={[styles.container, styles.containerWithFooter]}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.title, { color: colors.primaryText }]}>Results</Text>
          <Text style={[styles.scoreText, { color: colors.primaryText }]}>
            {correctCount} / {answers.length} correct
          </Text>

          <View style={[styles.resultHeroCard, { backgroundColor: colors.heroSurface, borderColor: colors.heroBorder }]}>
            <Text style={[styles.resultHeroTitle, { color: colors.primaryText }]}>
              {answers.length > 0 ? `${Math.round((correctCount / answers.length) * 100)}% score` : '0% score'}
            </Text>
            <View style={styles.summaryPillRow}>
              <View style={[styles.summaryPill, { backgroundColor: colors.heroBadgeBackground, borderColor: colors.heroBorder }]}>
                <Text style={[styles.summaryPillValue, { color: colors.heroBadgeText }]}>{resultSummary.incorrectCount}</Text>
                <Text style={[styles.summaryPillLabel, { color: colors.secondaryText }]}>Incorrect</Text>
              </View>
              <View style={[styles.summaryPill, { backgroundColor: colors.heroBadgeBackground, borderColor: colors.heroBorder }]}>
                <Text style={[styles.summaryPillValue, { color: colors.heroBadgeText }]}>{resultSummary.weakCount}</Text>
                <Text style={[styles.summaryPillLabel, { color: colors.secondaryText }]}>Need work</Text>
              </View>
              <View style={[styles.summaryPill, { backgroundColor: colors.heroBadgeBackground, borderColor: colors.heroBorder }]}>
                <Text style={[styles.summaryPillValue, { color: colors.heroBadgeText }]}>{resultSummary.strongCount}</Text>
                <Text style={[styles.summaryPillLabel, { color: colors.secondaryText }]}>Strong</Text>
              </View>
            </View>
          </View>

          <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Quiz summary</Text>
            {resultCards.map((item) => (
              <View
                key={item.quizItemInstanceId}
                style={[
                  styles.cardRow,
                  { backgroundColor: colors.elevatedSurface, borderColor: colors.border },
                  getCardReviewTone(item, colors),
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.resultWord, { color: colors.primaryText }]}>{item.promptText}</Text>
                  <Text
                    style={[
                      styles.resultStatus,
                      { color: item.isCorrect ? colors.correctText : colors.errorText },
                    ]}
                  >
                    {item.isCorrect ? 'Correct' : 'Incorrect'}
                  </Text>
                  <Text style={[styles.resultDetail, { color: colors.secondaryText }]}>
                    {item.correctOption}
                  </Text>
                  {formatReviewStats(item) ? (
                    <Text style={[styles.reviewStatText, { color: colors.secondaryText }]}>
                      {formatReviewStats(item)}
                    </Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
        </AnimatedScrollView>

        <Animated.View style={[styles.stickyFooter, animatedFooterStyle, { backgroundColor: colors.stickySurface, borderColor: colors.border }]}>
          <Pressable style={[styles.primaryButton, { backgroundColor: colors.primaryButton }]} onPress={goToReview}>
            <Text style={[styles.primaryButtonText, { color: colors.primaryButtonText }]}>Back to review</Text>
          </Pressable>
        </Animated.View>
      </SafeAreaView>
    );
  }

  if (screen === 'debug') {
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.screenBackground }]}>
        <StatusBar style={statusBarStyle} />
        <AnimatedScrollView
          style={animatedScreenStyle}
          contentContainerStyle={styles.container}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.quizHeaderRow}>
            <Pressable
              style={[styles.secondaryButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={goHome}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.primaryText }]}>Back</Text>
            </Pressable>
            <Pressable
              style={[styles.secondaryButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={loadDebugInfo}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.primaryText }]}>Refresh</Text>
            </Pressable>
          </View>

          <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Speech debug</Text>
            <Text style={[styles.mutedText, { color: colors.secondaryText }]}>
              Hidden screen for checking what TTS voices the current browser or device exposes to the app.
            </Text>
            <View style={styles.debugInfoList}>
              <Text style={[styles.debugInfoText, { color: colors.primaryText }]}>Platform: {Platform.OS}</Text>
              <Text style={[styles.debugInfoText, { color: colors.primaryText }]}>Theme: {theme}</Text>
              <Text style={[styles.debugInfoText, { color: colors.primaryText }]}>Provider: {ttsProvider}</Text>
              <Text style={[styles.debugInfoText, { color: colors.primaryText }]}>
                Effective provider: {debugInfo.effectiveProvider}
              </Text>
              <Text style={[styles.debugInfoText, { color: colors.primaryText }]}>TTS rate: {ttsRate}</Text>
              <Text style={[styles.debugInfoText, { color: colors.primaryText }]}>TTS pitch: {ttsPitch}</Text>
              <Text style={[styles.debugInfoText, { color: colors.primaryText }]}>
                Selected voice: {ttsVoice || 'System default'}
              </Text>
              <Text style={[styles.debugInfoText, { color: colors.primaryText }]}>
                Voices shown: {filteredDebugVoices.length} / {debugInfo.voices.length}
              </Text>
              {Platform.OS === 'web' && typeof navigator !== 'undefined' ? (
                <Text style={[styles.debugInfoText, styles.debugInfoMono, { color: colors.secondaryText }]}>
                  UA: {navigator.userAgent}
                </Text>
              ) : null}
            </View>
            {debugInfo.providerMessage ? (
              <Text style={[styles.mutedText, { color: colors.secondaryText }]}>
                {debugInfo.providerMessage}
              </Text>
            ) : null}
          </View>

          {debugInfo.loading ? (
            <Text style={[styles.mutedText, { color: colors.secondaryText }]}>Loading voices...</Text>
          ) : null}
          {debugInfo.error ? (
            <View style={[styles.sectionCard, { backgroundColor: colors.errorBackground, borderColor: colors.errorBorder }]}>
              <Text style={[styles.feedbackTitle, { color: colors.errorText }]}>Voice load failed</Text>
              <Text style={[styles.mutedText, { color: colors.primaryText }]}>{debugInfo.error}</Text>
            </View>
          ) : null}

          <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Available voices</Text>
            <View style={styles.sortSection}>
              <Text style={[styles.settingsLabel, { color: colors.primaryText }]}>Filter by country</Text>
              <View style={styles.filterRow}>
                {debugCountryOptions.map((option) => {
                  const active = debugCountryFilter === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      style={[
                        styles.filterChip,
                        { backgroundColor: colors.softSurface, borderColor: colors.border },
                        active && { backgroundColor: colors.primaryText, borderColor: colors.primaryText },
                      ]}
                      onPress={() => setDebugCountryFilter(option.value)}
                    >
                      <Text style={[styles.filterChipText, { color: active ? colors.surface : colors.primaryText }]}>
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <Pressable
              style={[
                styles.secondaryButton,
                styles.debugVoiceActionButton,
                {
                  backgroundColor: !ttsVoice ? colors.primaryButton : colors.surface,
                  borderColor: !ttsVoice ? colors.primaryButton : colors.border,
                },
              ]}
              onPress={() => updateSpeechSetting('tts_voice', DEFAULT_TTS_VOICE, setTtsVoice)}
            >
              <Text
                style={[
                  styles.secondaryButtonText,
                  { color: !ttsVoice ? colors.primaryButtonText : colors.primaryText },
                ]}
              >
                Use system default voice
              </Text>
            </Pressable>
            {filteredDebugVoices.length === 0 && !debugInfo.loading ? (
              <Text style={[styles.mutedText, { color: colors.secondaryText }]}>
                {debugInfo.voices.length === 0
                  ? 'No voices reported by this environment.'
                  : 'No voices match the selected country filter.'}
              </Text>
            ) : (
              filteredDebugVoices.map((voice, index) => (
                <View
                  key={`${voice.identifier ?? voice.voiceURI ?? voice.name ?? 'voice'}-${index}`}
                  style={[
                    styles.debugVoiceRow,
                    { backgroundColor: colors.elevatedSurface, borderColor: colors.border },
                  ]}
                >
                  <Text style={[styles.debugVoiceName, { color: colors.primaryText }]}>
                    {voice.name || voice.identifier || `Voice ${index + 1}`}
                  </Text>
                  <Text style={[styles.debugVoiceMeta, { color: colors.secondaryText }]}>
                    {(voice.language || voice.lang || 'unknown language') +
                      ' • ' +
                      (voice.identifier || voice.voiceURI || 'no id')}
                  </Text>
                  <Text style={[styles.debugVoiceMeta, styles.debugInfoMono, { color: colors.secondaryText }]}>
                    {`default=${String(Boolean(voice.isDefault))} • local=${String(
                      voice.localService ?? true
                    )} • quality=${voice.quality ?? 'n/a'}`}
                  </Text>
                  <View style={styles.debugVoiceActionsRow}>
                    <Pressable
                      style={[
                        styles.secondaryButton,
                        styles.debugVoiceActionButton,
                        { backgroundColor: colors.surface, borderColor: colors.border },
                      ]}
                      onPress={() => previewVoice(voice)}
                    >
                      <Text style={[styles.secondaryButtonText, { color: colors.primaryText }]}>Preview voice</Text>
                    </Pressable>
                    <Pressable
                      style={[
                        styles.secondaryButton,
                        styles.debugVoiceActionButton,
                        {
                          backgroundColor:
                            ttsVoice === (voice.identifier || voice.voiceURI || '') ? colors.primaryButton : colors.surface,
                          borderColor:
                            ttsVoice === (voice.identifier || voice.voiceURI || '') ? colors.primaryButton : colors.border,
                        },
                      ]}
                      onPress={() =>
                        updateSpeechSetting(
                          'tts_voice',
                          voice.identifier || voice.voiceURI || '',
                          setTtsVoice
                        )
                      }
                    >
                      <Text
                        style={[
                          styles.secondaryButtonText,
                          {
                            color:
                              ttsVoice === (voice.identifier || voice.voiceURI || '')
                                ? colors.primaryButtonText
                                : colors.primaryText,
                          },
                        ]}
                      >
                        {ttsVoice === (voice.identifier || voice.voiceURI || '') ? 'Selected voice' : 'Use this voice'}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ))
            )}
          </View>
        </AnimatedScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.screenBackground }]}>
      <StatusBar style={statusBarStyle} />
    <AnimatedScrollView
      style={animatedScreenStyle}
      contentContainerStyle={[styles.container, styles.containerWithFooter]}
      showsVerticalScrollIndicator={false}
    >
      <Animated.View style={[styles.heroCard, animatedHeroStyle, { backgroundColor: colors.heroSurface, borderColor: colors.heroBorder }]}>
        <View style={[styles.heroOrb, styles.heroOrbLarge, { backgroundColor: colors.heroBadgeBackground }]} />
        <View style={[styles.heroOrb, styles.heroOrbSmall, { backgroundColor: colors.softAccent }]} />
        <Pressable
          style={[styles.heroBadge, { backgroundColor: colors.heroBadgeBackground }]}
          onPress={handleDebugUnlockTap}
        >
          <Text style={[styles.heroBadgeText, { color: colors.heroBadgeText }]}>Study Flow</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.primaryText }]}>Flash Cards</Text>
        <Text style={[styles.subtitle, { color: colors.secondaryText }]}>
          Build soft little study decks, review what matters, and let the quiz adapt as you learn.
        </Text>
        <View style={styles.summaryPillRow}>
          <View style={[styles.summaryPill, { backgroundColor: colors.heroBadgeBackground, borderColor: colors.heroBorder }]}>
            <Text style={[styles.summaryPillValue, { color: colors.heroBadgeText }]}>{selectedSets.length}</Text>
            <Text style={[styles.summaryPillLabel, { color: colors.secondaryText }]}>Selected sets</Text>
          </View>
          <View style={[styles.summaryPill, { backgroundColor: colors.heroBadgeBackground, borderColor: colors.heroBorder }]}>
            <Text style={[styles.summaryPillValue, { color: colors.heroBadgeText }]}>{selectedSetSummary.dueCount}</Text>
            <Text style={[styles.summaryPillLabel, { color: colors.secondaryText }]}>Due cards</Text>
          </View>
          <View style={[styles.summaryPill, { backgroundColor: colors.heroBadgeBackground, borderColor: colors.heroBorder }]}>
            <Text style={[styles.summaryPillValue, { color: colors.heroBadgeText }]}>{selectedSetSummary.newCount}</Text>
            <Text style={[styles.summaryPillLabel, { color: colors.secondaryText }]}>New cards</Text>
          </View>
        </View>
      </Animated.View>

      <View style={[styles.sectionCard, styles.compactSectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Appearance</Text>
        <View style={styles.quizSizeRow}>
          {['light', 'dark'].map((value) => {
            const active = theme === value;
            return (
              <Pressable
                key={value}
                style={[
                  styles.quizSizeChip,
                  { borderColor: colors.border },
                  active && { backgroundColor: colors.primaryText, borderColor: colors.primaryText },
                ]}
                onPress={() => updateTheme(value)}
              >
                <Text
                  style={[
                    styles.quizSizeText,
                    { color: active ? colors.surface : colors.primaryText },
                  ]}
                >
                  {value === 'light' ? 'Light' : 'Dark'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.statsRow}>
        <View style={[styles.statCard, { backgroundColor: colors.elevatedSurface, borderColor: colors.border }]}>
          <Text style={[styles.statValue, { color: colors.primaryText }]}>{totalSets}</Text>
          <Text style={[styles.statLabel, { color: colors.secondaryText }]}>Sets</Text>
        </View>
        <View style={[styles.statCard, { backgroundColor: colors.elevatedSurface, borderColor: colors.border }]}>
          <Text style={[styles.statValue, { color: colors.primaryText }]}>{totalCards}</Text>
          <Text style={[styles.statLabel, { color: colors.secondaryText }]}>Cards</Text>
        </View>
      </View>

      <View style={[styles.sectionCard, styles.compactSectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Import vocabulary</Text>
        <Text style={[styles.mutedText, { color: colors.secondaryText }]}>
          CSV must use exactly these columns: <Text style={[styles.inlineCodeText, { color: colors.primaryText }]}>front,type,back,set</Text>.
          Each row becomes one card, and the <Text style={[styles.inlineCodeText, { color: colors.primaryText }]}>set</Text> value controls which set it appears in.
        </Text>
        <Text style={[styles.mutedText, { color: colors.secondaryText }]}>
          Use short type values like <Text style={[styles.inlineCodeText, { color: colors.primaryText }]}>marker</Text>, <Text style={[styles.inlineCodeText, { color: colors.primaryText }]}>v.</Text>, <Text style={[styles.inlineCodeText, { color: colors.primaryText }]}>n.</Text>, or <Text style={[styles.inlineCodeText, { color: colors.primaryText }]}>adv.</Text>.
        </Text>
        <View style={[styles.csvExampleCard, { backgroundColor: colors.inputBackground, borderColor: colors.border }]}>
          <Text style={[styles.csvExampleText, { color: colors.primaryText }]}>
            {'front,type,back,set\n은 / 는,marker,topic marker,Example\n가다,v.,ไป,Example\n오늘,n.,วันนี้,Example'}
          </Text>
        </View>
        <View style={styles.importActionsColumn}>
          <Pressable style={[styles.primaryButton, { backgroundColor: colors.primaryButton }]} onPress={handleImportCsv} disabled={importing}>
            <Text style={[styles.primaryButtonText, { color: colors.primaryButtonText }]}>
              {importing ? 'Importing...' : 'Import CSV'}
            </Text>
          </Pressable>
          <Pressable style={[styles.secondaryButton, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={handleImportExampleSet}>
            <Text style={[styles.secondaryButtonText, { color: colors.primaryText }]}>Load example set</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Select sets</Text>
        <TextInput
          value={setSearchQuery}
          onChangeText={setSetSearchQuery}
          placeholder="Search sets"
          placeholderTextColor={colors.secondaryText}
          style={[
            styles.input,
            styles.searchInput,
            {
              borderColor: colors.border,
              backgroundColor: colors.inputBackground,
              color: colors.primaryText,
            },
          ]}
        />
        <View style={styles.filterRow}>
          {SET_FILTER_OPTIONS.map((value) => {
            const active = setFilter === value;
            return (
              <Pressable
                key={value}
                style={[
                  styles.filterChip,
                  { backgroundColor: colors.softSurface, borderColor: colors.border },
                  active && { backgroundColor: colors.primaryText, borderColor: colors.primaryText },
                ]}
                onPress={() => setSetFilter(value)}
              >
                <Text style={[styles.filterChipText, { color: active ? colors.surface : colors.primaryText }]}>
                  {value}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.sortSection}>
          <Text style={[styles.settingsLabel, { color: colors.primaryText }]}>Sort sets</Text>
          <View style={styles.filterRow}>
            {SET_SORT_OPTIONS.map((value) => {
              const active = setSort === value;
              return (
                <Pressable
                  key={value}
                  style={[
                    styles.filterChip,
                    { backgroundColor: colors.softSurface, borderColor: colors.border },
                    active && { backgroundColor: colors.primaryText, borderColor: colors.primaryText },
                  ]}
                  onPress={() => setSetSort(value)}
                >
                  <Text style={[styles.filterChipText, { color: active ? colors.surface : colors.primaryText }]}>
                    {value}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        {selectedSets.length > 0 ? (
          <View style={[styles.selectedSetSummaryCard, { backgroundColor: colors.softSurface, borderColor: colors.border }]}>
            <View style={styles.selectedSetSummaryHeader}>
              <Text style={[styles.settingsLabel, { color: colors.primaryText }]}>Selected now</Text>
              <Text style={[styles.mutedText, { color: colors.secondaryText }]}>
                {selectedSetSummary.cardCount} cards • {selectedSetSummary.dueCount} due • {selectedSetSummary.newCount} new
              </Text>
            </View>
            <View style={styles.selectedSetChips}>
              {selectedSets.map((item) => (
                <Pressable
                  key={item.id}
                  style={[
                    styles.selectedSetChip,
                    { backgroundColor: colors.softAccent, borderColor: colors.accentBorder },
                  ]}
                  onPress={() => toggleSetSelection(item.id)}
                >
                  <Text style={[styles.selectedSetChipText, { color: colors.accentText }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <Text style={[styles.mutedText, { color: colors.secondaryText }]}>No sets selected yet.</Text>
        )}
        {sets.length === 0 ? (
          <Text style={[styles.mutedText, { color: colors.secondaryText }]}>No sets yet. Import a CSV or create a set first.</Text>
        ) : visibleSets.length === 0 ? (
          <Text style={[styles.mutedText, { color: colors.secondaryText }]}>No sets match your current search or filters.</Text>
        ) : (
          visibleSets.map((item) => {
            const isSelected = selectedSetIds.includes(item.id);
            return (
              <Pressable
                key={item.id}
                style={[
                  styles.setRow,
                  { backgroundColor: colors.softSurface, borderColor: colors.border },
                  getSetReviewTone(item, colors),
                  isSelected && styles.setRowSelected,
                  isSelected && { borderColor: colors.accentBorder },
                ]}
                onPress={() => toggleSetSelection(item.id)}
              >
                <View style={styles.setRowContent}>
                  <Text style={[styles.setName, { color: colors.primaryText }]}>{item.name}</Text>
                  <Text style={[styles.setMetaText, { color: colors.secondaryText }]}>
                    {formatSetStats(item)}
                  </Text>
                </View>
                <View
                  style={[
                    styles.setSelectionBadge,
                    {
                      borderColor: isSelected ? colors.accentBorder : colors.border,
                      backgroundColor: isSelected ? colors.softAccent : 'transparent',
                    },
                  ]}
                >
                  <Text style={[styles.checkbox, { color: isSelected ? colors.accentText : colors.secondaryText }]}>
                    {isSelected ? '✓' : '○'}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
        {(hasMoreSetsToShow || (showAllSets && !normalizedSetSearchQuery)) ? (
          <Pressable
            style={[styles.secondaryButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={() => setShowAllSets((prev) => !prev)}
          >
            <Text style={[styles.secondaryButtonText, { color: colors.primaryText }]}>
              {showAllSets ? 'Show less' : `Show all ${filteredSets.length} sets`}
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Speech settings</Text>
        <Text style={[styles.mutedText, { color: colors.secondaryText }]}>Adjust speech playback to match the way you want cards to sound.</Text>

        <View style={styles.settingsGroup}>
          <Text style={[styles.settingsLabel, { color: colors.primaryText }]}>Provider</Text>
          <View style={styles.filterRow}>
            {TTS_PROVIDER_OPTIONS.map((option) => {
              const active = ttsProvider === option.value;
              return (
                <Pressable
                  key={option.value}
                  style={[
                    styles.filterChip,
                    { backgroundColor: colors.softSurface, borderColor: colors.border },
                    active && { backgroundColor: colors.primaryText, borderColor: colors.primaryText },
                  ]}
                  onPress={() => updateSpeechSetting('tts_provider', option.value, setTtsProvider)}
                >
                  <Text style={[styles.filterChipText, { color: active ? colors.surface : colors.primaryText }]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={[styles.mutedText, { color: colors.secondaryText }]}>
            {currentTtsProviderStatus.message}
          </Text>
        </View>

        <View style={styles.settingsGroup}>
          <Text style={[styles.settingsLabel, { color: colors.primaryText }]}>Speed</Text>
          <View style={styles.quizSizeRow}>
            {TTS_RATE_OPTIONS.map((value) => {
              const active = ttsRate === value;
              return (
                <Pressable
                  key={value}
                  style={[
                    styles.quizSizeChip,
                    { borderColor: colors.border },
                    active && { backgroundColor: colors.primaryText, borderColor: colors.primaryText },
                  ]}
                  onPress={() => updateSpeechSetting('tts_rate', value, setTtsRate)}
                >
                  <Text
                    style={[
                      styles.quizSizeText,
                      { color: active ? colors.primaryButtonText : colors.primaryText },
                    ]}
                  >
                    {value.toFixed(1)}x
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.settingsGroup}>
          <Text style={[styles.settingsLabel, { color: colors.primaryText }]}>Pitch</Text>
          <View style={styles.quizSizeRow}>
            {TTS_PITCH_OPTIONS.map((value) => {
              const active = ttsPitch === value;
              return (
                <Pressable
                  key={value}
                  style={[
                    styles.quizSizeChip,
                    { borderColor: colors.border },
                    active && { backgroundColor: colors.primaryText, borderColor: colors.primaryText },
                  ]}
                  onPress={() => updateSpeechSetting('tts_pitch', value, setTtsPitch)}
                >
                  <Text
                    style={[
                      styles.quizSizeText,
                      { color: active ? colors.primaryButtonText : colors.primaryText },
                    ]}
                  >
                    {value.toFixed(1)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Pressable
          style={[styles.secondaryButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => speakFrontText(findSpeechPreviewText(cards))}
        >
          <Text style={[styles.secondaryButtonText, { color: colors.primaryText }]}>Preview speech</Text>
        </Pressable>
      </View>

      <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Data tools</Text>
        <Text style={[styles.mutedText, { color: colors.secondaryText }]}>
          Export or restore your card-level learning progress as a CSV backup.
        </Text>
        <Pressable
          style={[styles.secondaryButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={handleExportLearningProgress}
        >
          <Text style={[styles.secondaryButtonText, { color: colors.primaryText }]}>Export learning progress</Text>
        </Pressable>
        <Pressable
          style={[styles.secondaryButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={handleImportLearningProgress}
        >
          <Text style={[styles.secondaryButtonText, { color: colors.primaryText }]}>Import learning progress</Text>
        </Pressable>
      </View>

      <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Danger zone</Text>
        <Text style={[styles.mutedText, { color: colors.secondaryText }]}>Delete all sets, cards, and quiz history from this device.</Text>
        <Pressable style={[styles.dangerButton, { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder }]} onPress={clearAllData}>
          <Text style={[styles.dangerButtonText, { color: colors.dangerText }]}>Clear all data</Text>
        </Pressable>
        <Pressable style={[styles.dangerButton, { backgroundColor: colors.dangerSurface, borderColor: colors.dangerBorder }]} onPress={resetDatabaseSchema}>
          <Text style={[styles.dangerButtonText, { color: colors.dangerText }]}>Reset DB schema</Text>
        </Pressable>
      </View>

      <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>All cards</Text>
        {cards.length === 0 ? (
          <Text style={[styles.mutedText, { color: colors.secondaryText }]}>No cards yet. Import a CSV or start a new set.</Text>
        ) : (
          visibleCards.map((item) => (
            <View
              key={item.id}
              style={[
                styles.cardRow,
                { backgroundColor: colors.elevatedSurface, borderColor: colors.border },
                getCardReviewTone(item, colors),
              ]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.cardFront, { color: colors.primaryText }]}>{item.front}</Text>
                <Text style={[styles.cardBack, { color: colors.secondaryText }]}>
                  {item.back}
                </Text>
                {formatReviewStats(item) ? (
                  <Text style={[styles.reviewStatText, { color: colors.secondaryText }]}>
                    {formatReviewStats(item)}
                  </Text>
                ) : null}
              </View>
              <Pressable style={[styles.listenMiniButton, { backgroundColor: colors.softAccent }]} onPress={() => speakFrontText(item.front)}>
                <Text style={styles.listenMiniText}>🔊</Text>
              </Pressable>
            </View>
          ))
        )}
        {cards.length > 30 ? (
          <Text style={[styles.mutedText, { color: colors.secondaryText }]}>
            Showing 30 prioritized cards. New cards appear first, due cards rise next, and weaker cards stay higher.
          </Text>
        ) : null}
      </View>
    </AnimatedScrollView>

      <Animated.View style={[styles.stickyFooter, animatedFooterStyle, { backgroundColor: colors.stickySurface, borderColor: colors.border }]}>
        <Pressable
          style={[
            styles.primaryButton,
            { backgroundColor: hasSelectedSets ? colors.primaryButton : colors.border },
          ]}
          onPress={openReviewScreen}
          disabled={!hasSelectedSets}
        >
          <Text
            style={[
              styles.primaryButtonText,
              { color: hasSelectedSets ? colors.primaryButtonText : colors.secondaryText },
            ]}
          >
            Review selected cards
          </Text>
        </Pressable>
      </Animated.View>
    </SafeAreaView>
  );
}

function getSetReviewTone(set, colors) {
  const quizCount = Number(set.quiz_count) || 0;
  if (quizCount === 0) {
    return null;
  }

  return getAccuracyTone(Number(set.average_score_percent), colors);
}

function getCardAccuracyPercent(card) {
  const attempts = Number(card?.attempt_count) || 0;
  const correct = Number(card?.correct_count) || 0;

  if (attempts === 0) {
    return null;
  }

  return (correct / attempts) * 100;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseImportCsvRows(csvText) {
  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim().toLowerCase(),
  });

  if (parsed.errors?.length) {
    throw new Error(parsed.errors[0].message);
  }

  const rows = (parsed.data ?? [])
    .map((row) => ({
      front: String(row.front ?? '').trim(),
      type: String(row.type ?? '').trim(),
      back: String(row.back ?? '').trim(),
      set: String(row.set ?? '').trim() || 'Imported',
    }))
    .filter((row) => row.front && row.type && row.back);

  if (rows.length === 0) {
    throw new Error('CSV has no usable rows. Required columns: front, type, back, set');
  }

  return rows;
}

function estimateSpeechDurationMs(text, rate) {
  const normalizedText = String(text ?? '').trim();
  if (!normalizedText) {
    return 0;
  }

  const safeRate = Math.max(Number(rate) || DEFAULT_TTS_RATE, 0.3);
  const charDurationMs = /[가-힣]/.test(normalizedText) ? 140 : 110;
  const estimated = normalizedText.length * (charDurationMs / safeRate);
  return Math.max(estimated, 650);
}

function getQuizAdvanceDelayMs(quizItem, ttsRate) {
  if (quizItem?.promptField !== 'back') {
    return QUIZ_FEEDBACK_DELAY_MS;
  }

  return Math.max(
    QUIZ_FEEDBACK_DELAY_MS,
    getPostFeedbackSpeechDelayMs(true) +
      estimateSpeechDurationMs(quizItem.front, ttsRate) +
      QUIZ_POST_ANSWER_SPEECH_BUFFER_MS
  );
}

function getPostFeedbackSpeechDelayMs(isCorrect) {
  return (
    (isCorrect ? QUIZ_CORRECT_SOUND_DURATION_MS : QUIZ_WRONG_SOUND_DURATION_MS) +
    QUIZ_FEEDBACK_FOLLOWUP_SPEECH_DELAY_MS
  );
}

function downloadCsvOnWeb(filename, csvText) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

function isModeEnabled(mode, targetDirection) {
  return mode === 'mixed' || mode === targetDirection;
}

function normalizeImportedLearningProgressRows(rawRows) {
  return (rawRows ?? [])
    .map((row) => {
      const front = String(row.front ?? '').trim();
      const type = String(row.type ?? '').trim();
      const back = String(row.back ?? '').trim();
      const setNames = String(row.sets ?? '')
        .split('|')
        .map((value) => value.trim())
        .filter(Boolean);
      const attemptCount = Math.max(0, Number.parseInt(String(row.attempt_count ?? '0'), 10) || 0);
      const correctCount = Math.min(
        attemptCount,
        Math.max(0, Number.parseInt(String(row.correct_count ?? '0'), 10) || 0)
      );

      return {
        front,
        type,
        back,
        setNames,
        attemptCount,
        correctCount,
        incorrectCount: Math.max(0, attemptCount - correctCount),
        lastReviewedAt: String(row.last_reviewed_at ?? '').trim(),
        nextDueAt: String(row.next_due_at ?? '').trim(),
        correctStreak: Math.max(0, Number.parseInt(String(row.correct_streak ?? '0'), 10) || 0),
        intervalDays: Math.max(0, Number.parseInt(String(row.interval_days ?? '0'), 10) || 0),
      };
    })
    .filter((row) => row.front && row.type && row.back);
}

function getVoiceCountryCode(voice) {
  const language = String(voice?.language || voice?.lang || '').trim();
  if (!language) {
    return '';
  }

  const [, region = ''] = language.split(/[-_]/);
  return region.toUpperCase();
}

function formatVoiceCountryLabel(countryCode) {
  if (!countryCode) {
    return 'Unknown country';
  }

  if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
    try {
      const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
      return displayNames.of(countryCode) || countryCode;
    } catch {}
  }

  return countryCode;
}

function showAlert(title, message) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.alert([title, message].filter(Boolean).join('\n\n'));
    return;
  }

  Alert.alert(title, message);
}

function showConfirm({ title, message, confirmText, destructive = false, onConfirm }) {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const confirmed = window.confirm([title, message].filter(Boolean).join('\n\n'));
    if (confirmed) {
      onConfirm?.();
    }
    return;
  }

  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: confirmText,
      style: destructive ? 'destructive' : 'default',
      onPress: onConfirm,
    },
  ]);
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <SafeAreaView style={[styles.safeArea, styles.errorBoundarySafeArea]}>
        <View style={styles.errorBoundaryContainer}>
          <Text style={styles.errorBoundaryTitle}>App failed to load</Text>
          <Text style={styles.errorBoundaryMessage}>
            {this.state.error?.message ?? 'Unknown runtime error'}
          </Text>
        </View>
      </SafeAreaView>
    );
  }
}

async function readImportedText(asset) {
  if (asset?.file && typeof asset.file.text === 'function') {
    return asset.file.text();
  }

  return FileSystem.readAsStringAsync(asset.uri);
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  errorBoundarySafeArea: {
    backgroundColor: '#f5f7fb',
  },
  errorBoundaryContainer: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  errorBoundaryTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#172033',
  },
  errorBoundaryMessage: {
    fontSize: 15,
    lineHeight: 22,
    color: '#5f6b85',
  },
  screen: {
    flex: 1,
  },
  container: {
    padding: 20,
    gap: 16,
  },
  heroCard: {
    position: 'relative',
    borderRadius: 28,
    padding: 22,
    borderWidth: 1,
    gap: 12,
    shadowColor: '#0f172a',
    shadowOpacity: 0.12,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 6,
    overflow: 'hidden',
  },
  heroOrb: {
    position: 'absolute',
    borderRadius: 999,
    opacity: 0.8,
  },
  heroOrbLarge: {
    width: 140,
    height: 140,
    top: -56,
    right: -24,
  },
  heroOrbSmall: {
    width: 92,
    height: 92,
    bottom: -28,
    right: 56,
  },
  heroBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  heroBadgeText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  debugInfoList: {
    gap: 6,
  },
  debugInfoText: {
    fontSize: 14,
    lineHeight: 20,
  },
  debugInfoMono: {
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
    fontSize: 12,
  },
  debugVoiceRow: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    gap: 4,
  },
  debugVoiceName: {
    fontSize: 15,
    fontWeight: '700',
  },
  debugVoiceMeta: {
    fontSize: 12,
    lineHeight: 18,
  },
  debugVoiceActionButton: {
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 4,
  },
  debugVoiceActionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  summaryPillRow: {
    flexDirection: 'row',
    gap: 10,
  },
  summaryPill: {
    flex: 1,
    borderRadius: 18,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
    gap: 4,
  },
  summaryPillValue: {
    fontSize: 22,
    fontWeight: '800',
  },
  summaryPillLabel: {
    fontSize: 12,
    fontWeight: '700',
  },
  containerWithFooter: {
    paddingBottom: 120,
  },
  quizScreenContainer: {
    flex: 1,
  },
  title: {
    fontSize: 30,
    fontWeight: '800',
    color: '#172033',
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: '#5f6b85',
  },
  statsRow: {
    flexDirection: 'row',
    gap: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#ffffff',
    padding: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e5eaf3',
    alignItems: 'center',
    shadowColor: '#0f172a',
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  statValue: {
    fontSize: 28,
    fontWeight: '800',
    color: '#172033',
  },
  statLabel: {
    marginTop: 6,
    fontSize: 13,
    color: '#71809b',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  importActionsColumn: {
    gap: 10,
  },
  csvExampleCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
  },
  csvExampleText: {
    fontSize: 13,
    lineHeight: 19,
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
  },
  inlineCodeText: {
    fontFamily: Platform.select({
      ios: 'Menlo',
      android: 'monospace',
      default: 'monospace',
    }),
    fontSize: 13,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: '#4461f2',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#2d4de0',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 15,
  },
  secondaryButton: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ccd5e6',
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0f172a',
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 1,
  },
  secondaryButtonText: {
    color: '#22314d',
    fontWeight: '700',
    fontSize: 15,
  },
  sectionCard: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e5eaf3',
    gap: 12,
    shadowColor: '#0f172a',
    shadowOpacity: 0.04,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 2,
  },
  compactSectionCard: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#172033',
  },
  mutedText: {
    color: '#71809b',
    lineHeight: 20,
  },
  setRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    borderRadius: 16,
    backgroundColor: '#f6f8fc',
    borderWidth: 1,
    borderColor: '#edf1f7',
    shadowColor: '#0f172a',
    shadowOpacity: 0.035,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  setRowContent: {
    flex: 1,
    paddingRight: 12,
    gap: 4,
  },
  setRowSelected: {
    borderWidth: 2,
    shadowOpacity: 0.06,
    shadowRadius: 12,
  },
  setName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1d2740',
  },
  setMetaText: {
    fontSize: 12,
    lineHeight: 18,
  },
  checkbox: {
    fontSize: 18,
    color: '#4461f2',
    fontWeight: '700',
  },
  setSelectionBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  quizSizeRow: {
    flexDirection: 'row',
    gap: 10,
  },
  quizSizeChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#d7dfef',
    alignItems: 'center',
  },
  quizSizeChipActive: {
    backgroundColor: '#172033',
    borderColor: '#172033',
  },
  quizSizeText: {
    color: '#22314d',
    fontWeight: '700',
  },
  quizSizeTextActive: {
    color: '#ffffff',
  },
  settingsGroup: {
    gap: 8,
  },
  settingsLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: '#22314d',
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 13,
    paddingHorizontal: 13,
    borderRadius: 18,
    borderWidth: 1,
    shadowColor: '#0f172a',
    shadowOpacity: 0.045,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  cardFront: {
    fontSize: 18,
    fontWeight: '700',
    color: '#172033',
  },
  cardBack: {
    fontSize: 14,
    color: '#64748b',
    marginTop: 2,
  },
  reviewStatText: {
    fontSize: 12,
    marginTop: 6,
    lineHeight: 18,
  },
  listenMiniButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#eef2ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  listenMiniText: {
    fontSize: 18,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 18,
    gap: 14,
  },
  input: {
    borderWidth: 1,
    borderColor: '#d6deed',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: '#fbfcff',
  },
  searchInput: {
    marginBottom: 2,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  sortSection: {
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  quizHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  progressText: {
    fontSize: 15,
    color: '#5f6b85',
    fontWeight: '700',
  },
  selectedSetChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  selectedSetSummaryCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 12,
    gap: 10,
  },
  selectedSetSummaryHeader: {
    gap: 4,
  },
  selectedSetChip: {
    maxWidth: '100%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
  },
  selectedSetChipText: {
    fontSize: 13,
    fontWeight: '700',
  },
  quizCard: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 24,
    borderWidth: 1,
    borderColor: '#e5eaf3',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    shadowColor: '#0f172a',
    shadowOpacity: 0.07,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 3,
  },
  quizCardCompact: {
    width: '100%',
    minHeight: 136,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 5,
    marginBottom: 6,
    justifyContent: 'center',
  },
  quizLabel: {
    color: '#64748b',
    fontSize: 13,
  },
  frontText: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    color: '#172033',
    textAlign: 'center',
  },
  speakButton: {
    backgroundColor: '#eef2ff',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 14,
  },
  speakButtonText: {
    color: '#3147bf',
    fontWeight: '700',
  },
  optionsContainer: {
    gap: 8,
    paddingHorizontal: 2,
    paddingBottom: 0,
  },
  optionsContainerCompact: {
    justifyContent: 'flex-start',
    flexGrow: 0,
  },
  quizOptionsScroll: {
    flex: 1,
  },
  optionButton: {
    backgroundColor: '#ffffff',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#dbe3f1',
    minHeight: 46,
    paddingVertical: 5,
    paddingHorizontal: 12,
    justifyContent: 'center',
    shadowColor: '#0f172a',
    shadowOpacity: 0.03,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  optionButtonCompact: {
    minHeight: 64,
    paddingVertical: 18,
    paddingHorizontal: 12
  },
  optionContentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  optionText: {
    fontSize: 17,
    lineHeight: 22,
    color: '#1f2a44',
    fontWeight: '600',
  },
  optionTextCompact: {
    fontSize: 20,
    lineHeight: 24,
  },
  optionTextWrap: {
    flex: 1,
  },
  optionSoundButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  optionSoundText: {
    fontSize: 12,
  },
  scoreText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#172033',
  },
  resultHeroCard: {
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    gap: 12,
  },
  resultHeroTitle: {
    fontSize: 28,
    fontWeight: '800',
  },
  resultRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#edf1f7',
  },
  resultWord: {
    fontSize: 17,
    fontWeight: '800',
    color: '#172033',
    marginBottom: 4,
  },
  resultStatus: {
    fontSize: 13,
    fontWeight: '800',
    marginBottom: 4,
  },
  resultDetail: {
    color: '#5f6b85',
    lineHeight: 20,
  },
  feedbackCard: {
    borderRadius: 18,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 4,
    marginBottom: 4,
  },
  feedbackStickyCard: {
    marginBottom: 0,
  },
  feedbackTitle: {
    fontSize: 18,
    fontWeight: '800',
  },
  feedbackDetail: {
    fontSize: 14,
    lineHeight: 20,
  },
  feedbackButton: {
    marginTop: 8,
  },
  feedbackConfirmButton: {
    marginTop: 8,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedbackConfirmText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 15,
  },
  stickyFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 20,
    borderTopWidth: 1,
    shadowColor: '#0f172a',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -4 },
    elevation: 10,
  },
  dangerButton: {
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff1f1',
    borderWidth: 1,
    borderColor: '#f3b7b7',
  },
  dangerButtonText: {
    color: '#b42318',
    fontWeight: '700',
    fontSize: 15,
  },
});
