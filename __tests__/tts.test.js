jest.mock('../src/lib/audio', () => ({
  createAudioPlayer: jest.fn(() => ({
    play: jest.fn(),
    pause: jest.fn(),
    remove: jest.fn(),
    seekTo: jest.fn(),
  })),
}));

import {
  buildGoogleTtsCacheKey,
  buildGoogleTtsRequest,
  getTtsProviderStatus,
  normalizeGoogleVoiceRows,
  pickBestGoogleVoice,
  TTS_PROVIDER_GOOGLE,
  TTS_PROVIDER_SYSTEM,
} from '../src/lib/tts';
import { buildSpeechCacheKey } from '../api/_lib/googleTts';

describe('tts helpers', () => {
  test('buildGoogleTtsRequest maps app settings to google payload shape', () => {
    expect(
      buildGoogleTtsRequest({
        text: '안녕하세요',
        language: 'ko-KR',
        voice: 'ko-KR-Voice-1',
      })
    ).toEqual({
      input: { text: '안녕하세요' },
      voice: {
        languageCode: 'ko-KR',
        name: 'ko-KR-Voice-1',
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: 0.9,
        pitch: 1.0,
        volumeGainDb: 6,
      },
    });
  });

  test('buildGoogleTtsCacheKey is stable for the same request payload', () => {
    expect(
      buildGoogleTtsCacheKey({
        text: '안녕하세요',
        language: 'ko-KR',
        voice: 'ko-KR-Wavenet-B',
      })
    ).toBe(
      buildGoogleTtsCacheKey({
        text: '안녕하세요',
        language: 'ko-KR',
        voice: 'ko-KR-Wavenet-B',
      })
    );
  });

  test('buildGoogleTtsCacheKey uses fixed google audio settings despite app-side rate and pitch inputs', () => {
    expect(
      buildGoogleTtsCacheKey({
        text: '안녕하세요',
        language: 'ko-KR',
        voice: 'ko-KR-Wavenet-B',
        rate: 0.9,
        pitch: 1,
      })
    ).toBe(
      buildGoogleTtsCacheKey({
        text: '안녕하세요',
        language: 'ko-KR',
        voice: 'ko-KR-Wavenet-B',
        rate: 1.2,
        pitch: 0.8,
        volume: 0.3,
      })
    );
  });

  test('buildGoogleTtsCacheKey changes when google voice changes', () => {
    expect(
      buildGoogleTtsCacheKey({
        text: '안녕하세요',
        language: 'ko-KR',
        voice: 'ko-KR-Wavenet-B',
      })
    ).not.toBe(
      buildGoogleTtsCacheKey({
        text: '안녕하세요',
        language: 'ko-KR',
        voice: 'ko-KR-Wavenet-C',
      })
    );
  });

  test('buildSpeechCacheKey changes when google volumeGainDb changes', () => {
    expect(
      buildSpeechCacheKey({
        input: { text: '안녕하세요' },
        voice: { languageCode: 'ko-KR', name: 'ko-KR-Wavenet-B' },
        audioConfig: {
          audioEncoding: 'MP3',
          volumeGainDb: 6,
        },
      })
    ).not.toBe(
      buildSpeechCacheKey({
        input: { text: '안녕하세요' },
        voice: { languageCode: 'ko-KR', name: 'ko-KR-Wavenet-B' },
        audioConfig: {
          audioEncoding: 'MP3',
          volumeGainDb: 0,
        },
      })
    );
  });

  test('normalizeGoogleVoiceRows accepts google-style voice rows', () => {
    expect(
      normalizeGoogleVoiceRows({
        voices: [
          {
            name: 'ko-KR-Wavenet-A',
            languageCodes: ['ko-KR'],
            ssmlGender: 'FEMALE',
          },
        ],
      })
    ).toEqual([
      {
        identifier: 'ko-KR-Wavenet-A',
        name: 'ko-KR-Wavenet-A',
        language: 'ko-KR',
        languageCodes: ['ko-KR'],
        gender: 'FEMALE',
        quality: 'WaveNet',
        family: 'WaveNet',
        localService: false,
        isDefault: false,
        provider: TTS_PROVIDER_GOOGLE,
        voiceURI: 'ko-KR-Wavenet-A',
      },
    ]);
  });

  test('system provider status is always configured', () => {
    expect(getTtsProviderStatus(TTS_PROVIDER_SYSTEM)).toEqual({
      provider: TTS_PROVIDER_SYSTEM,
      configured: true,
      effectiveProvider: TTS_PROVIDER_SYSTEM,
      message: 'Using device system TTS.',
    });
  });

  test('pickBestGoogleVoice prefers exact locale, WaveNet, then male voice', () => {
    expect(
      pickBestGoogleVoice(
        [
          {
            identifier: 'ko-KR-Standard-B',
            name: 'ko-KR-Standard-B',
            language: 'ko-KR',
            languageCodes: ['ko-KR'],
            family: 'Standard',
            gender: 'MALE',
          },
          {
            identifier: 'ko-KR-Wavenet-A',
            name: 'ko-KR-Wavenet-A',
            language: 'ko-KR',
            languageCodes: ['ko-KR'],
            family: 'WaveNet',
            gender: 'FEMALE',
          },
          {
            identifier: 'ko-KR-Wavenet-B',
            name: 'ko-KR-Wavenet-B',
            language: 'ko-KR',
            languageCodes: ['ko-KR'],
            family: 'WaveNet',
            gender: 'MALE',
          },
        ],
        'ko-KR',
        'MALE'
      )
    ).toMatchObject({
      identifier: 'ko-KR-Wavenet-B',
    });
  });
});
