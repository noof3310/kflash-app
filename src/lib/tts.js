import * as FileSystem from 'expo-file-system/legacy';
import * as Speech from 'expo-speech';
import { Platform } from 'react-native';

import { createAudioPlayer } from './audio';

export const TTS_PROVIDER_SYSTEM = 'system';
export const TTS_PROVIDER_GOOGLE = 'google';
export const TTS_PROVIDER_OPTIONS = [
  { value: TTS_PROVIDER_SYSTEM, label: 'System' },
  { value: TTS_PROVIDER_GOOGLE, label: 'Google' },
];

const DEFAULT_WEB_TTS_PROXY_BASE_URL = '/api';
const GOOGLE_TTS_PROXY_BASE_URL = (
  process.env.EXPO_PUBLIC_GOOGLE_TTS_PROXY_BASE_URL ||
  process.env.EXPO_PUBLIC_TTS_PROXY_BASE_URL ||
  (Platform.OS === 'web' ? DEFAULT_WEB_TTS_PROXY_BASE_URL : '')
).replace(/\/$/, '');

let googlePlayer = null;
let cachedGoogleVoices = null;
const googleSpeechPayloadCache = new Map();
const googleAudioSourceCache = new Map();
const googleSpeechPayloadPromiseCache = new Map();
const googleAudioSourcePromiseCache = new Map();

export function getTtsProviderStatus(provider) {
  if (provider === TTS_PROVIDER_GOOGLE) {
    if (GOOGLE_TTS_PROXY_BASE_URL) {
      return {
        provider,
        configured: true,
        effectiveProvider: TTS_PROVIDER_GOOGLE,
        message: `Google TTS proxy ready at ${GOOGLE_TTS_PROXY_BASE_URL}.`,
      };
    }

    return {
      provider,
      configured: false,
      effectiveProvider: TTS_PROVIDER_SYSTEM,
      message: 'Google TTS proxy is not configured. Falling back to system voices.',
    };
  }

  return {
    provider: TTS_PROVIDER_SYSTEM,
    configured: true,
    effectiveProvider: TTS_PROVIDER_SYSTEM,
    message: 'Using device system TTS.',
  };
}

const GOOGLE_TTS_AUDIO_ENCODING = 'MP3';
const GOOGLE_TTS_DEFAULT_SPEAKING_RATE = 1;
const GOOGLE_TTS_DEFAULT_PITCH = 0;
const GOOGLE_TTS_DEFAULT_VOLUME_GAIN_DB = 6;
const GOOGLE_TTS_KOREAN_DEFAULT_VOICE = 'ko-KR-Wavenet-D';

function buildGoogleTtsAudioConfig() {
  return {
    audioEncoding: GOOGLE_TTS_AUDIO_ENCODING,
    speakingRate: GOOGLE_TTS_DEFAULT_SPEAKING_RATE,
    pitch: GOOGLE_TTS_DEFAULT_PITCH,
    volumeGainDb: GOOGLE_TTS_DEFAULT_VOLUME_GAIN_DB,
  };
}

export function buildGoogleTtsRequest({ text, language, voice }) {
  return {
    input: { text },
    voice: {
      languageCode: language || undefined,
      name: voice || undefined,
    },
    audioConfig: buildGoogleTtsAudioConfig(),
  };
}

export function buildGoogleTtsCacheKey({ text, language, voice }) {
  return hashString(
    JSON.stringify({
      text: String(text || ''),
      language: String(language || ''),
      voice: String(voice || ''),
      ...buildGoogleTtsAudioConfig(),
    })
  );
}

export function normalizeGoogleVoiceRows(payload) {
  const voiceRows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.voices)
      ? payload.voices
      : [];

  return voiceRows
    .map((voice) => {
      const languageCodes = normalizeVoiceLanguageCodes(voice);
      const family = getGoogleVoiceFamily(voice);

      return {
        identifier: voice.identifier || voice.name || voice.voiceURI || '',
        name: voice.name || voice.identifier || voice.voiceURI || 'Google voice',
        language: languageCodes[0] || '',
        languageCodes,
        gender: normalizeVoiceGender(voice),
        quality: family || voice.quality || voice.ssmlGender || voice.gender || 'Google',
        family: family || '',
        localService: false,
        isDefault: Boolean(voice.isDefault),
        provider: TTS_PROVIDER_GOOGLE,
        voiceURI: voice.voiceURI || voice.identifier || voice.name || '',
      };
    })
    .filter((voice) => voice.identifier || voice.name);
}

export function pickBestGoogleVoice(voices, language, preferredGender = 'MALE') {
  const normalizedVoices = Array.isArray(voices) ? voices.filter(Boolean) : [];
  if (normalizedVoices.length === 0) {
    return null;
  }

  const normalizedLanguage = String(language || '').trim();
  const normalizedLanguagePrefix = normalizedLanguage.split(/[-_]/)[0]?.toLowerCase() || '';
  const normalizedPreferredGender = String(preferredGender || '').trim().toUpperCase() || 'MALE';

  const exactMatches = normalizedLanguage
    ? normalizedVoices.filter((voice) =>
        getAllVoiceLanguageCodes(voice).some((code) => code.toLowerCase() === normalizedLanguage.toLowerCase())
      )
    : [];
  const prefixMatches =
    exactMatches.length > 0 || !normalizedLanguagePrefix
      ? []
      : normalizedVoices.filter((voice) =>
          getAllVoiceLanguageCodes(voice).some(
            (code) => code.split(/[-_]/)[0]?.toLowerCase() === normalizedLanguagePrefix
          )
        );

  const candidatePool =
    exactMatches.length > 0 ? exactMatches : prefixMatches.length > 0 ? prefixMatches : normalizedVoices;

  return [...candidatePool].sort((left, right) => {
    const familyComparison = compareVoiceFamily(left, right);
    if (familyComparison !== 0) {
      return familyComparison;
    }

    const genderComparison = compareVoiceGender(left, right, normalizedPreferredGender);
    if (genderComparison !== 0) {
      return genderComparison;
    }

    return String(left.name || left.identifier || '').localeCompare(String(right.name || right.identifier || ''));
  })[0] || null;
}

export async function loadTtsVoices({ provider }) {
  const providerStatus = getTtsProviderStatus(provider);

  if (provider === TTS_PROVIDER_GOOGLE && providerStatus.configured) {
    try {
      const payload = await fetchGoogleVoices();
      return {
        voices: payload,
        provider,
        effectiveProvider: TTS_PROVIDER_GOOGLE,
        fallback: false,
        message: providerStatus.message,
      };
    } catch (error) {
      return {
        voices: await listSystemVoices(),
        provider,
        effectiveProvider: TTS_PROVIDER_SYSTEM,
        fallback: true,
        message: error?.message || 'Google voice list failed. Falling back to system voices.',
      };
    }
  }

  return {
    voices: await listSystemVoices(),
    provider,
    effectiveProvider: TTS_PROVIDER_SYSTEM,
    fallback: provider === TTS_PROVIDER_GOOGLE,
    message: providerStatus.message,
  };
}

export async function loadTtsBackendStatus({ provider }) {
  const providerStatus = getTtsProviderStatus(provider);

  if (provider === TTS_PROVIDER_GOOGLE && providerStatus.configured) {
    const response = await fetch(`${GOOGLE_TTS_PROXY_BASE_URL}/health`);
    if (!response.ok) {
      throw new Error(`TTS backend status request failed with ${response.status}`);
    }

    const payload = await response.json();
    return payload?.googleTts || null;
  }

  return {
    ok: false,
    provider,
    config: {
      googleCredentialsConfigured: false,
      redisConfigured: false,
      blobConfigured: false,
      persistentCacheConfigured: false,
    },
    cache: {
      analyticsWindow: '',
      requests: 0,
      memoryHitCount: 0,
      persistentHitCount: 0,
      missCount: 0,
      hitRatio: 0,
      missRatio: 0,
    },
  };
}

export async function prefetchTts({ text, language, pitch, provider, rate, voice }) {
  if (!text) {
    return {
      provider,
      effectiveProvider: provider === TTS_PROVIDER_GOOGLE ? TTS_PROVIDER_GOOGLE : TTS_PROVIDER_SYSTEM,
      fallback: false,
      cache: {
        client: 'skipped',
        server: 'skipped',
      },
      selectedVoice: voice || '',
      selectedLanguage: language || '',
    };
  }

  if (provider === TTS_PROVIDER_GOOGLE && GOOGLE_TTS_PROXY_BASE_URL) {
    try {
      const selectedVoice =
        voice || (await getAutoSelectedGoogleVoiceName({ language, preferredGender: 'MALE' })) || undefined;
      const selectedLanguage =
        language || (await getAutoSelectedGoogleVoiceLanguage({ voiceName: selectedVoice })) || undefined;
      const requestPayload = buildGoogleTtsRequest({
        text,
        language: selectedLanguage,
        voice: selectedVoice,
      });
      const cacheKey = buildGoogleTtsCacheKey({
        text,
        language: selectedLanguage,
        voice: selectedVoice,
      });
      const payload = await fetchGoogleSpeechPayload(requestPayload, cacheKey);
      await resolveGoogleAudioSource(payload, cacheKey);

      return {
        provider,
        effectiveProvider: TTS_PROVIDER_GOOGLE,
        fallback: false,
        cache: {
          client: payload._clientCache || 'unknown',
          server: payload.cache?.server || 'unknown',
        },
        selectedVoice: selectedVoice || '',
        selectedLanguage: selectedLanguage || '',
      };
    } catch {
      return {
        provider,
        effectiveProvider: TTS_PROVIDER_SYSTEM,
        fallback: true,
        cache: {
          client: 'miss',
          server: 'unknown',
        },
        selectedVoice: voice || '',
        selectedLanguage: language || '',
      };
    }
  }

  return {
    provider,
    effectiveProvider: TTS_PROVIDER_SYSTEM,
    fallback: provider === TTS_PROVIDER_GOOGLE,
    cache: {
      client: 'n/a',
      server: 'n/a',
    },
    selectedVoice: voice || '',
    selectedLanguage: language || '',
  };
}

export async function speakWithTts({ text, language, pitch, provider, rate, voice, volume }) {
  if (provider === TTS_PROVIDER_GOOGLE && GOOGLE_TTS_PROXY_BASE_URL) {
    try {
      await stopTtsPlayback();
      const selectedVoice =
        voice || (await getAutoSelectedGoogleVoiceName({ language, preferredGender: 'MALE' })) || undefined;
      const selectedLanguage =
        language || (await getAutoSelectedGoogleVoiceLanguage({ voiceName: selectedVoice })) || undefined;
      const requestPayload = buildGoogleTtsRequest({
        text,
        language: selectedLanguage,
        voice: selectedVoice,
      });
      const cacheKey = buildGoogleTtsCacheKey({
        text,
        language: selectedLanguage,
        voice: selectedVoice,
      });
      const payload = await fetchGoogleSpeechPayload(requestPayload, cacheKey);
      const audioSource = await resolveGoogleAudioSource(payload, cacheKey);
      if (!audioSource) {
        throw new Error('Google TTS proxy did not return usable audio.');
      }

      googlePlayer = createAudioPlayer(audioSource);
      if (googlePlayer) {
        googlePlayer.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;
      }
      if (googlePlayer?.play) {
        await googlePlayer.play();
      }

      return {
        provider,
        effectiveProvider: TTS_PROVIDER_GOOGLE,
        fallback: false,
        message: 'Spoken with Google TTS.',
        cache: {
          client: payload._clientCache || 'unknown',
          server: payload.cache?.server || 'unknown',
        },
        selectedVoice: selectedVoice || '',
        selectedLanguage: selectedLanguage || '',
      };
    } catch (error) {
      await speakWithSystemTts({ text, language, pitch, rate, voice, volume });
      return {
        provider,
        effectiveProvider: TTS_PROVIDER_SYSTEM,
        fallback: true,
        message: error?.message || 'Google TTS failed. Fell back to system TTS.',
        cache: {
          client: 'miss',
          server: 'unknown',
        },
        selectedVoice: voice || '',
        selectedLanguage: language || '',
      };
    }
  }

  await speakWithSystemTts({ text, language, pitch, rate, voice, volume });
  return {
    provider,
    effectiveProvider: TTS_PROVIDER_SYSTEM,
    fallback: provider === TTS_PROVIDER_GOOGLE,
    message: getTtsProviderStatus(provider).message,
    cache: {
      client: 'n/a',
      server: 'n/a',
    },
    selectedVoice: voice || '',
    selectedLanguage: language || '',
  };
}

export async function stopTtsPlayback() {
  Speech.stop();

  if (googlePlayer?.pause) {
    googlePlayer.pause();
  }
  if (googlePlayer?.seekTo) {
    try {
      const seekResult = googlePlayer.seekTo(0);
      if (seekResult && typeof seekResult.then === 'function') {
        await seekResult.catch(() => {});
      }
    } catch {}
  }
  if (googlePlayer?.remove) {
    googlePlayer.remove();
  }

  googlePlayer = null;
}

async function listSystemVoices() {
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    return Array.isArray(voices) ? voices : [];
  } catch {
    return [];
  }
}

async function speakWithSystemTts({ text, language, pitch, rate, voice, volume }) {
  Speech.stop();
  Speech.speak(text, {
    language,
    pitch,
    rate,
    voice: voice || undefined,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1,
  });
}

async function resolveGoogleAudioSource(payload, cacheKey) {
  if (cacheKey && googleAudioSourceCache.has(cacheKey)) {
    return googleAudioSourceCache.get(cacheKey);
  }

  if (cacheKey && googleAudioSourcePromiseCache.has(cacheKey)) {
    return googleAudioSourcePromiseCache.get(cacheKey);
  }

  const resolvePromise = (async () => {
    const audioUrl = payload.audioUrl || payload.audio_url || payload.url || '';
    if (audioUrl) {
      if (cacheKey) {
        googleAudioSourceCache.set(cacheKey, audioUrl);
      }
      return audioUrl;
    }

    const audioContent = payload.audioContent || payload.audio_content || '';
    if (!audioContent) {
      return null;
    }

    const contentType = payload.contentType || payload.content_type || 'audio/mpeg';

    if (Platform.OS === 'web') {
      const dataUri = `data:${contentType};base64,${audioContent}`;
      if (cacheKey) {
        googleAudioSourceCache.set(cacheKey, dataUri);
      }
      return dataUri;
    }

    const outputDirectory = FileSystem.cacheDirectory || FileSystem.documentDirectory;
    if (!outputDirectory) {
      return null;
    }

    const fileUri = `${outputDirectory}google-tts-${cacheKey || hashString(audioContent)}.mp3`;
    const info = await FileSystem.getInfoAsync(fileUri);
    if (!info.exists) {
      await FileSystem.writeAsStringAsync(fileUri, audioContent, {
        encoding: FileSystem.EncodingType.Base64,
      });
    }

    if (cacheKey) {
      googleAudioSourceCache.set(cacheKey, fileUri);
    }

    return fileUri;
  })();

  if (cacheKey) {
    googleAudioSourcePromiseCache.set(cacheKey, resolvePromise);
  }

  try {
    return await resolvePromise;
  } finally {
    if (cacheKey) {
      googleAudioSourcePromiseCache.delete(cacheKey);
    }
  }
}

function normalizeVoiceLanguageCodes(voice) {
  if (Array.isArray(voice?.languageCodes) && voice.languageCodes.length > 0) {
    return voice.languageCodes.map((item) => String(item || '').trim()).filter(Boolean);
  }

  const fallback = voice?.language || voice?.languageCode || voice?.lang || voice?.locale || '';
  return fallback ? [String(fallback).trim()] : [];
}

function getGoogleVoiceFamily(voice) {
  const name = String(voice?.name || voice?.identifier || voice?.voiceURI || '');

  if (/wavenet/i.test(name)) {
    return 'WaveNet';
  }

  if (/standard/i.test(name)) {
    return 'Standard';
  }

  if (/neural2/i.test(name)) {
    return 'Neural2';
  }

  if (/studio/i.test(name)) {
    return 'Studio';
  }

  if (/chirp/i.test(name)) {
    return 'Chirp';
  }

  return '';
}

async function fetchGoogleSpeechPayload(requestPayload, cacheKey) {
  if (cacheKey && googleSpeechPayloadCache.has(cacheKey)) {
    return {
      ...googleSpeechPayloadCache.get(cacheKey),
      _clientCache: 'hit',
    };
  }

  if (cacheKey && googleSpeechPayloadPromiseCache.has(cacheKey)) {
    const inFlightPayload = await googleSpeechPayloadPromiseCache.get(cacheKey);
    return {
      ...inFlightPayload,
      _clientCache: 'hit',
    };
  }

  const fetchPromise = (async () => {
    const response = await fetch(`${GOOGLE_TTS_PROXY_BASE_URL}/google/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });

    if (!response.ok) {
      throw new Error(`Google TTS request failed with ${response.status}`);
    }

    const payload = await response.json();
    if (cacheKey) {
      googleSpeechPayloadCache.set(cacheKey, payload);
    }
    return payload;
  })();

  if (cacheKey) {
    googleSpeechPayloadPromiseCache.set(cacheKey, fetchPromise);
  }

  try {
    const payload = await fetchPromise;
    return {
      ...payload,
      _clientCache: 'miss',
    };
  } finally {
    if (cacheKey) {
      googleSpeechPayloadPromiseCache.delete(cacheKey);
    }
  }
}

function normalizeVoiceGender(voice) {
  return String(voice?.ssmlGender || voice?.gender || '').trim().toUpperCase();
}

async function fetchGoogleVoices() {
  if (cachedGoogleVoices) {
    return cachedGoogleVoices;
  }

  const response = await fetch(`${GOOGLE_TTS_PROXY_BASE_URL}/google/voices`);
  if (!response.ok) {
    throw new Error(`Voice list request failed with ${response.status}`);
  }

  const payload = await response.json();
  cachedGoogleVoices = normalizeGoogleVoiceRows(payload);
  return cachedGoogleVoices;
}

async function getAutoSelectedGoogleVoiceName({ language, preferredGender }) {
  const voices = await fetchGoogleVoices();
  const koreanDefaultVoice = pickGoogleDefaultVoiceForLanguage(voices, language);
  if (koreanDefaultVoice) {
    return koreanDefaultVoice.identifier || '';
  }

  return pickBestGoogleVoice(voices, language, preferredGender)?.identifier || '';
}


function pickGoogleDefaultVoiceForLanguage(voices, language) {
  const normalizedLanguage = String(language || '').trim().toLowerCase();
  if (!normalizedLanguage.startsWith('ko')) {
    return null;
  }

  return (Array.isArray(voices) ? voices : []).find(
    (voice) => String(voice?.identifier || voice?.name || '').toLowerCase() === GOOGLE_TTS_KOREAN_DEFAULT_VOICE.toLowerCase()
  ) || null;
}

async function getAutoSelectedGoogleVoiceLanguage({ voiceName }) {
  if (!voiceName) {
    return '';
  }

  const voices = await fetchGoogleVoices();
  return voices.find((voice) => voice.identifier === voiceName)?.languageCodes?.[0] || '';
}

function getAllVoiceLanguageCodes(voice) {
  if (Array.isArray(voice?.languageCodes) && voice.languageCodes.length > 0) {
    return voice.languageCodes.map((item) => String(item || '').trim()).filter(Boolean);
  }

  return [String(voice?.language || '').trim()].filter(Boolean);
}

function compareVoiceFamily(left, right) {
  return getVoiceFamilyRank(left) - getVoiceFamilyRank(right);
}

function compareVoiceGender(left, right, preferredGender) {
  return getVoiceGenderRank(left, preferredGender) - getVoiceGenderRank(right, preferredGender);
}

function getVoiceFamilyRank(voice) {
  const family = String(voice?.family || voice?.quality || '').trim();

  if (family === 'WaveNet') {
    return 0;
  }

  if (family === 'Standard') {
    return 1;
  }

  return 2;
}

function getVoiceGenderRank(voice, preferredGender) {
  const gender = String(voice?.gender || '').trim().toUpperCase();

  if (gender === preferredGender) {
    return 0;
  }

  if (gender === 'NEUTRAL') {
    return 1;
  }

  if (!gender) {
    return 2;
  }

  return 3;
}

function hashString(value) {
  const input = String(value || '');
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}
