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
let nativeGoogleAudioUri = null;

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

export function buildGoogleTtsRequest({ text, language, voice, rate, pitch }) {
  return {
    input: { text },
    voice: {
      languageCode: language || undefined,
      name: voice || undefined,
    },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate: rate,
      pitch,
    },
  };
}

export function normalizeGoogleVoiceRows(payload) {
  const voiceRows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.voices)
      ? payload.voices
      : [];

  return voiceRows
    .map((voice) => ({
      identifier: voice.identifier || voice.name || voice.voiceURI || '',
      name: voice.name || voice.identifier || voice.voiceURI || 'Google voice',
      language: voice.language || voice.languageCode || voice.lang || voice.locale || '',
      quality: voice.quality || voice.ssmlGender || voice.gender || 'Google',
      localService: false,
      isDefault: Boolean(voice.isDefault),
      provider: TTS_PROVIDER_GOOGLE,
      voiceURI: voice.voiceURI || voice.identifier || voice.name || '',
    }))
    .filter((voice) => voice.identifier || voice.name);
}

export async function loadTtsVoices({ provider }) {
  const providerStatus = getTtsProviderStatus(provider);

  if (provider === TTS_PROVIDER_GOOGLE && providerStatus.configured) {
    try {
      const response = await fetch(`${GOOGLE_TTS_PROXY_BASE_URL}/google/voices`);
      if (!response.ok) {
        throw new Error(`Voice list request failed with ${response.status}`);
      }

      const payload = await response.json();
      return {
        voices: normalizeGoogleVoiceRows(payload),
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

export async function speakWithTts({ text, language, pitch, provider, rate, voice }) {
  if (provider === TTS_PROVIDER_GOOGLE && GOOGLE_TTS_PROXY_BASE_URL) {
    try {
      await stopTtsPlayback();
      const response = await fetch(`${GOOGLE_TTS_PROXY_BASE_URL}/google/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          buildGoogleTtsRequest({
            text,
            language,
            voice,
            rate,
            pitch,
          })
        ),
      });

      if (!response.ok) {
        throw new Error(`Google TTS request failed with ${response.status}`);
      }

      const payload = await response.json();
      const audioSource = await resolveGoogleAudioSource(payload);
      if (!audioSource) {
        throw new Error('Google TTS proxy did not return usable audio.');
      }

      googlePlayer = createAudioPlayer(audioSource);
      if (googlePlayer?.play) {
        await googlePlayer.play();
      }

      return {
        provider,
        effectiveProvider: TTS_PROVIDER_GOOGLE,
        fallback: false,
        message: 'Spoken with Google TTS.',
      };
    } catch (error) {
      await speakWithSystemTts({ text, language, pitch, rate, voice });
      return {
        provider,
        effectiveProvider: TTS_PROVIDER_SYSTEM,
        fallback: true,
        message: error?.message || 'Google TTS failed. Fell back to system TTS.',
      };
    }
  }

  await speakWithSystemTts({ text, language, pitch, rate, voice });
  return {
    provider,
    effectiveProvider: TTS_PROVIDER_SYSTEM,
    fallback: provider === TTS_PROVIDER_GOOGLE,
    message: getTtsProviderStatus(provider).message,
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
  await cleanupNativeGoogleAudioUri();
}

async function listSystemVoices() {
  try {
    const voices = await Speech.getAvailableVoicesAsync();
    return Array.isArray(voices) ? voices : [];
  } catch {
    return [];
  }
}

async function speakWithSystemTts({ text, language, pitch, rate, voice }) {
  Speech.stop();
  Speech.speak(text, {
    language,
    pitch,
    rate,
    voice: voice || undefined,
  });
}

async function resolveGoogleAudioSource(payload) {
  const audioUrl = payload.audioUrl || payload.audio_url || payload.url || '';
  if (audioUrl) {
    return audioUrl;
  }

  const audioContent = payload.audioContent || payload.audio_content || '';
  if (!audioContent) {
    return null;
  }

  const contentType = payload.contentType || payload.content_type || 'audio/mpeg';

  if (Platform.OS === 'web') {
    return `data:${contentType};base64,${audioContent}`;
  }

  const outputDirectory = FileSystem.cacheDirectory || FileSystem.documentDirectory;
  if (!outputDirectory) {
    return null;
  }

  await cleanupNativeGoogleAudioUri();
  nativeGoogleAudioUri = `${outputDirectory}google-tts-${Date.now()}.mp3`;
  await FileSystem.writeAsStringAsync(nativeGoogleAudioUri, audioContent, {
    encoding: FileSystem.EncodingType.Base64,
  });

  return nativeGoogleAudioUri;
}

async function cleanupNativeGoogleAudioUri() {
  if (!nativeGoogleAudioUri || Platform.OS === 'web') {
    nativeGoogleAudioUri = null;
    return;
  }

  try {
    const info = await FileSystem.getInfoAsync(nativeGoogleAudioUri);
    if (info.exists) {
      await FileSystem.deleteAsync(nativeGoogleAudioUri, { idempotent: true });
    }
  } catch {}

  nativeGoogleAudioUri = null;
}
