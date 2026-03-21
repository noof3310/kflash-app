jest.mock('../src/lib/audio', () => ({
  createAudioPlayer: jest.fn(() => ({
    play: jest.fn(),
    pause: jest.fn(),
    remove: jest.fn(),
    seekTo: jest.fn(),
  })),
}));

import {
  buildGoogleTtsRequest,
  getTtsProviderStatus,
  normalizeGoogleVoiceRows,
  TTS_PROVIDER_GOOGLE,
  TTS_PROVIDER_SYSTEM,
} from '../src/lib/tts';

describe('tts helpers', () => {
  test('buildGoogleTtsRequest maps app settings to google payload shape', () => {
    expect(
      buildGoogleTtsRequest({
        text: '안녕하세요',
        language: 'ko-KR',
        voice: 'ko-KR-Voice-1',
        rate: 0.9,
        pitch: 1.1,
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
        pitch: 1.1,
      },
    });
  });

  test('normalizeGoogleVoiceRows accepts google-style voice rows', () => {
    expect(
      normalizeGoogleVoiceRows({
        voices: [
          {
            name: 'ko-KR-Neural2-A',
            languageCode: 'ko-KR',
            ssmlGender: 'FEMALE',
          },
        ],
      })
    ).toEqual([
      {
        identifier: 'ko-KR-Neural2-A',
        name: 'ko-KR-Neural2-A',
        language: 'ko-KR',
        quality: 'FEMALE',
        localService: false,
        isDefault: false,
        provider: TTS_PROVIDER_GOOGLE,
        voiceURI: 'ko-KR-Neural2-A',
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
});
