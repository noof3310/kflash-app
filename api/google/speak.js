import {
  checkGoogleTtsRateLimit,
  getGoogleTtsRequestLimits,
  handleOptions,
  isAllowedSpeakOrigin,
  readJsonBody,
  sendJson,
  synthesizeGoogleSpeech,
  validateGoogleSpeakPayload,
} from '../_lib/googleTts.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    if (!isAllowedSpeakOrigin(req)) {
      sendJson(res, 403, { error: 'Origin is not allowed.' });
      return;
    }

    const rateLimit = await checkGoogleTtsRateLimit(req);
    res.setHeader('X-RateLimit-Limit', String(rateLimit.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, rateLimit.limit - rateLimit.count)));
    res.setHeader('X-RateLimit-Window', String(rateLimit.windowSeconds));
    if (!rateLimit.allowed) {
      sendJson(res, 429, {
        error: 'Too many TTS requests. Please slow down and try again shortly.',
        rateLimit,
      });
      return;
    }

    const body = await readJsonBody(req);
    const validation = validateGoogleSpeakPayload(body);
    if (!validation.ok) {
      sendJson(res, validation.statusCode, {
        error: validation.error,
        limits: getGoogleTtsRequestLimits(),
      });
      return;
    }

    const result = await synthesizeGoogleSpeech(validation.sanitizedBody);
    const payload = result?.payload || {};
    sendJson(res, 200, {
      audioContent: payload.audioContent || '',
      contentType: 'audio/mpeg',
      cache: result?.cache || { server: 'unknown' },
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error?.message || 'Could not synthesize Google TTS audio.',
    });
  }
}
