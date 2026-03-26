import {
  isAllowedSpeakOrigin,
  validateGoogleSpeakPayload,
} from '../api/_lib/googleTts';

describe('googleTts API guards', () => {
  const originalAllowedOrigins = process.env.ALLOWED_APP_ORIGINS;

  afterEach(() => {
    process.env.ALLOWED_APP_ORIGINS = originalAllowedOrigins;
  });

  test('validateGoogleSpeakPayload rejects text that is too long', () => {
    const result = validateGoogleSpeakPayload({
      input: { text: 'a'.repeat(281) },
    });

    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(400);
  });

  test('validateGoogleSpeakPayload accepts safe voice fields', () => {
    const result = validateGoogleSpeakPayload({
      input: { text: '안녕하세요' },
      voice: {
        languageCode: 'ko-KR',
        name: 'ko-KR-Wavenet-D',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.sanitizedBody).toEqual({
      input: { text: '안녕하세요' },
      voice: {
        languageCode: 'ko-KR',
        name: 'ko-KR-Wavenet-D',
      },
      audioConfig: undefined,
    });
  });

  test('isAllowedSpeakOrigin allows same-host requests', () => {
    process.env.ALLOWED_APP_ORIGINS = '';
    expect(
      isAllowedSpeakOrigin({
        headers: {
          origin: 'https://flash.example.com',
          host: 'flash.example.com',
        },
      })
    ).toBe(true);
  });

  test('isAllowedSpeakOrigin blocks foreign origins not in allowlist', () => {
    process.env.ALLOWED_APP_ORIGINS = 'https://flash.example.com';
    expect(
      isAllowedSpeakOrigin({
        headers: {
          origin: 'https://evil.example.com',
          host: 'flash.example.com',
        },
      })
    ).toBe(false);
  });
});
