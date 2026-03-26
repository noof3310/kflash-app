import crypto from 'node:crypto';
import { put } from '@vercel/blob';

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_TTS_BASE_URL = 'https://texttospeech.googleapis.com/v1';
const GOOGLE_TTS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GOOGLE_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const GOOGLE_VOICES_CACHE_TTL_MS = 60 * 60 * 1000;
const GOOGLE_SPEECH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GOOGLE_SPEECH_CACHE_TTL_SECONDS = 24 * 60 * 60;
const GOOGLE_SPEECH_CACHE_LIMIT = 200;
const GOOGLE_BLOB_CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const GOOGLE_TTS_BLOB_PREFIX = 'tts-cache';
const TTS_ANALYTICS_KEY_PREFIX = 'tts:analytics';
const TTS_ANALYTICS_FIELDS = ['requests', 'memory_hit', 'persistent_hit', 'miss'];
const GOOGLE_TTS_RATE_LIMIT_WINDOW_SECONDS = 60;
const GOOGLE_TTS_RATE_LIMIT_MAX_REQUESTS = 60;
const GOOGLE_TTS_MAX_TEXT_LENGTH = 280;
const inMemoryRateLimitEntries = new Map();

let cachedAccessToken = '';
let cachedAccessTokenExpiresAt = 0;
const cachedVoicesByLanguage = new Map();
const cachedSpeechPayloads = new Map();
const inMemoryAnalytics = {
  requests: 0,
  memory_hit: 0,
  persistent_hit: 0,
  miss: 0,
};

export async function listGoogleVoices({ languageCode } = {}) {
  const voiceCacheKey = String(languageCode || '');
  const cachedVoiceEntry = cachedVoicesByLanguage.get(voiceCacheKey);
  if (cachedVoiceEntry && cachedVoiceEntry.expiresAt > Date.now()) {
    return cachedVoiceEntry.payload;
  }

  const accessToken = await getGoogleAccessToken();
  const searchParams = new URLSearchParams();
  if (languageCode) {
    searchParams.set('languageCode', languageCode);
  }

  const response = await fetch(
    `${GOOGLE_TTS_BASE_URL}/voices${searchParams.toString() ? `?${searchParams.toString()}` : ''}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Google voices request failed with ${response.status}`);
  }

  const payload = await response.json();
  cachedVoicesByLanguage.set(voiceCacheKey, {
    payload,
    expiresAt: Date.now() + GOOGLE_VOICES_CACHE_TTL_MS,
  });

  return payload;
}

export async function synthesizeGoogleSpeech(payload) {
  const speechCacheKey = buildSpeechCacheKey(payload);
  const cachedSpeechEntry = cachedSpeechPayloads.get(speechCacheKey);
  if (cachedSpeechEntry && cachedSpeechEntry.expiresAt > Date.now()) {
    await recordTtsAnalytics('memory-hit');
    return {
      payload: cachedSpeechEntry.payload,
      cache: { server: 'memory-hit' },
    };
  }

  const persistentCachedPayload = await getPersistentSpeechPayload(speechCacheKey);
  if (persistentCachedPayload) {
    cachedSpeechPayloads.set(speechCacheKey, {
      payload: persistentCachedPayload,
      expiresAt: Date.now() + GOOGLE_SPEECH_CACHE_TTL_MS,
    });
    trimSpeechCacheIfNeeded();
    await recordTtsAnalytics('persistent-hit');

    return {
      payload: persistentCachedPayload,
      cache: { server: 'persistent-hit' },
    };
  }

  const accessToken = await getGoogleAccessToken();
  const response = await fetch(`${GOOGLE_TTS_BASE_URL}/text:synthesize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Google synthesize request failed with ${response.status}: ${errorText}`);
  }

  const responsePayload = await response.json();
  const persistentPayload = await persistSpeechPayload(speechCacheKey, responsePayload);
  const cacheablePayload = persistentPayload || responsePayload;
  cachedSpeechPayloads.set(speechCacheKey, {
    payload: cacheablePayload,
    expiresAt: Date.now() + GOOGLE_SPEECH_CACHE_TTL_MS,
  });
  trimSpeechCacheIfNeeded();
  await recordTtsAnalytics('miss');

  return {
    payload: cacheablePayload,
    cache: { server: 'miss' },
  };
}

export async function getGoogleTtsBackendStatus() {
  const analytics = await loadTtsAnalyticsSnapshot();
  const requests = analytics.requests;

  return {
    ok: true,
    provider: 'google',
    config: {
      googleCredentialsConfigured: isGoogleCredentialsConfigured(),
      redisConfigured: isRedisConfigured(),
      blobConfigured: isBlobConfigured(),
      persistentCacheConfigured: isPersistentSpeechCacheConfigured(),
      rateLimitConfigured: true,
      rateLimitWindowSeconds: GOOGLE_TTS_RATE_LIMIT_WINDOW_SECONDS,
      rateLimitMaxRequests: GOOGLE_TTS_RATE_LIMIT_MAX_REQUESTS,
      maxTextLength: GOOGLE_TTS_MAX_TEXT_LENGTH,
    },
    cache: {
      inMemoryVoiceEntries: cachedVoicesByLanguage.size,
      inMemorySpeechEntries: cachedSpeechPayloads.size,
      analyticsWindow: getAnalyticsWindowLabel(),
      requests,
      memoryHitCount: analytics.memory_hit,
      persistentHitCount: analytics.persistent_hit,
      missCount: analytics.miss,
      hitRatio: requests > 0 ? roundRatio((analytics.memory_hit + analytics.persistent_hit) / requests) : 0,
      missRatio: requests > 0 ? roundRatio(analytics.miss / requests) : 0,
    },
  };
}

export function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  applyCorsHeaders(res);
  res.end(JSON.stringify(payload));
}

export function getGoogleTtsRequestLimits() {
  return {
    maxTextLength: GOOGLE_TTS_MAX_TEXT_LENGTH,
    rateLimitWindowSeconds: GOOGLE_TTS_RATE_LIMIT_WINDOW_SECONDS,
    rateLimitMaxRequests: GOOGLE_TTS_RATE_LIMIT_MAX_REQUESTS,
  };
}

export function getRequestClientIp(req) {
  const forwardedFor = req.headers?.['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  const realIp = req.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

  return 'unknown';
}

export function isAllowedSpeakOrigin(req) {
  const origin = getRequestOrigin(req);
  if (!origin) {
    return true;
  }

  const originHost = getHostFromUrl(origin);
  if (!originHost) {
    return false;
  }

  const requestHost = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').trim().toLowerCase();
  if (requestHost && originHost === requestHost) {
    return true;
  }

  const allowedOrigins = getAllowedOriginList();
  return allowedOrigins.includes(origin.toLowerCase());
}

export async function checkGoogleTtsRateLimit(req) {
  const clientIp = getRequestClientIp(req);
  const key = `tts:ratelimit:${clientIp}`;

  if (isRedisConfigured()) {
    try {
      const incrementResponse = await upstashCommand(['INCR', key]);
      const count = parseCounterValue(incrementResponse?.result);
      if (count === 1) {
        await upstashCommand(['EXPIRE', key, GOOGLE_TTS_RATE_LIMIT_WINDOW_SECONDS]);
      }

      return {
        allowed: count <= GOOGLE_TTS_RATE_LIMIT_MAX_REQUESTS,
        count,
        limit: GOOGLE_TTS_RATE_LIMIT_MAX_REQUESTS,
        windowSeconds: GOOGLE_TTS_RATE_LIMIT_WINDOW_SECONDS,
      };
    } catch {
      return {
        allowed: true,
        count: 0,
        limit: GOOGLE_TTS_RATE_LIMIT_MAX_REQUESTS,
        windowSeconds: GOOGLE_TTS_RATE_LIMIT_WINDOW_SECONDS,
      };
    }
  }

  const now = Date.now();
  const existingEntry = inMemoryRateLimitEntries.get(key);
  if (!existingEntry || existingEntry.expiresAt <= now) {
    inMemoryRateLimitEntries.set(key, {
      count: 1,
      expiresAt: now + GOOGLE_TTS_RATE_LIMIT_WINDOW_SECONDS * 1000,
    });
    trimInMemoryRateLimitEntries(now);
    return {
      allowed: true,
      count: 1,
      limit: GOOGLE_TTS_RATE_LIMIT_MAX_REQUESTS,
      windowSeconds: GOOGLE_TTS_RATE_LIMIT_WINDOW_SECONDS,
    };
  }

  existingEntry.count += 1;
  trimInMemoryRateLimitEntries(now);
  return {
    allowed: existingEntry.count <= GOOGLE_TTS_RATE_LIMIT_MAX_REQUESTS,
    count: existingEntry.count,
    limit: GOOGLE_TTS_RATE_LIMIT_MAX_REQUESTS,
    windowSeconds: GOOGLE_TTS_RATE_LIMIT_WINDOW_SECONDS,
  };
}

export function validateGoogleSpeakPayload(body) {
  const text = String(body?.input?.text || body?.text || '').trim();
  if (!text) {
    return { ok: false, statusCode: 400, error: 'Missing input.text for Google TTS synthesis.' };
  }

  if (text.length > GOOGLE_TTS_MAX_TEXT_LENGTH) {
    return {
      ok: false,
      statusCode: 400,
      error: `input.text is too long. Maximum ${GOOGLE_TTS_MAX_TEXT_LENGTH} characters.`,
    };
  }

  const languageCode = body?.voice?.languageCode;
  if (languageCode != null && !isSafeVoiceField(languageCode, 20)) {
    return { ok: false, statusCode: 400, error: 'voice.languageCode is invalid.' };
  }

  const voiceName = body?.voice?.name;
  if (voiceName != null && !isSafeVoiceField(voiceName, 80)) {
    return { ok: false, statusCode: 400, error: 'voice.name is invalid.' };
  }

  return {
    ok: true,
    sanitizedBody: {
      input: { text },
      voice: {
        languageCode: typeof languageCode === 'string' && languageCode.trim() ? languageCode.trim() : undefined,
        name: typeof voiceName === 'string' && voiceName.trim() ? voiceName.trim() : undefined,
      },
      audioConfig: body?.audioConfig && typeof body.audioConfig === 'object' ? body.audioConfig : undefined,
    },
  };
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  return rawBody ? JSON.parse(rawBody) : {};
}

export function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export function handleOptions(req, res) {
  if (req.method !== 'OPTIONS') {
    return false;
  }

  applyCorsHeaders(res);
  res.statusCode = 204;
  res.end();
  return true;
}

function getGoogleServiceAccount() {
  if (process.env.GOOGLE_TTS_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.GOOGLE_TTS_SERVICE_ACCOUNT_JSON);
    return {
      clientEmail: parsed.client_email,
      privateKey: normalizePrivateKey(parsed.private_key),
    };
  }

  return {
    clientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_CLIENT_EMAIL || '',
    privateKey: normalizePrivateKey(
      process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY || ''
    ),
  };
}

async function getGoogleAccessToken() {
  if (cachedAccessToken && cachedAccessTokenExpiresAt - GOOGLE_TOKEN_REFRESH_BUFFER_MS > Date.now()) {
    return cachedAccessToken;
  }

  const { clientEmail, privateKey } = getGoogleServiceAccount();

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Missing Google service account credentials. Set GOOGLE_TTS_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.'
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = { alg: 'RS256', typ: 'JWT' };
  const jwtPayload = {
    iss: clientEmail,
    scope: GOOGLE_TTS_SCOPE,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };

  const assertion = signJwt(jwtHeader, jwtPayload, privateKey);
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Google OAuth token request failed with ${response.status}: ${errorText}`);
  }

  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error('Google OAuth token response did not include access_token.');
  }

  cachedAccessToken = payload.access_token;
  cachedAccessTokenExpiresAt = Date.now() + (Number(payload.expires_in || 3600) * 1000);

  return payload.access_token;
}

function signJwt(header, payload, privateKey) {
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  const signature = signer.sign(privateKey);

  return `${encodedHeader}.${encodedPayload}.${encodeBase64Url(signature)}`;
}

function encodeBase64Url(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function normalizePrivateKey(privateKey) {
  return String(privateKey || '').replace(/\\n/g, '\n');
}

export function buildSpeechCacheKey(payload) {
  return JSON.stringify({
    text: payload?.input?.text || '',
    ssml: payload?.input?.ssml || '',
    languageCode: payload?.voice?.languageCode || '',
    name: payload?.voice?.name || '',
    audioEncoding: payload?.audioConfig?.audioEncoding || '',
    speakingRate: payload?.audioConfig?.speakingRate ?? '',
    pitch: payload?.audioConfig?.pitch ?? '',
    volumeGainDb: payload?.audioConfig?.volumeGainDb ?? '',
  });
}

function trimSpeechCacheIfNeeded() {
  if (cachedSpeechPayloads.size <= GOOGLE_SPEECH_CACHE_LIMIT) {
    return;
  }

  const oldestKey = cachedSpeechPayloads.keys().next().value;
  if (oldestKey) {
    cachedSpeechPayloads.delete(oldestKey);
  }
}

async function getPersistentSpeechPayload(speechCacheKey) {
  if (!isPersistentSpeechCacheConfigured()) {
    return null;
  }

  try {
    const cacheKey = getPersistentSpeechRedisKey(speechCacheKey);
    const response = await upstashCommand(['GET', cacheKey]);
    const rawValue = response?.result;
    if (!rawValue || typeof rawValue !== 'string') {
      return null;
    }

    const parsed = JSON.parse(rawValue);
    const audioUrl = String(parsed?.audioUrl || '').trim();
    if (!audioUrl) {
      return null;
    }

    return {
      audioUrl,
      contentType: parsed?.contentType || 'audio/mpeg',
    };
  } catch {
    return null;
  }
}

async function persistSpeechPayload(speechCacheKey, googlePayload) {
  if (!isPersistentSpeechCacheConfigured()) {
    return null;
  }

  const audioContent = String(googlePayload?.audioContent || '').trim();
  if (!audioContent) {
    return null;
  }

  try {
    const pathname = `${GOOGLE_TTS_BLOB_PREFIX}/${speechCacheKey}.mp3`;
    const blob = await put(pathname, Buffer.from(audioContent, 'base64'), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'audio/mpeg',
      cacheControlMaxAge: GOOGLE_BLOB_CACHE_MAX_AGE_SECONDS,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    const persistentPayload = {
      audioUrl: blob.url,
      contentType: 'audio/mpeg',
    };

    await upstashCommand(
      ['SETEX', getPersistentSpeechRedisKey(speechCacheKey), GOOGLE_SPEECH_CACHE_TTL_SECONDS, JSON.stringify(persistentPayload)]
    );

    return persistentPayload;
  } catch {
    return null;
  }
}

function isPersistentSpeechCacheConfigured() {
  return isRedisConfigured() && isBlobConfigured();
}

function getPersistentSpeechRedisKey(speechCacheKey) {
  return `tts:${speechCacheKey}`;
}

async function upstashCommand(command) {
  const restUrl = getUpstashRestUrl();
  const restToken = getUpstashRestToken();

  if (!restUrl || !restToken) {
    throw new Error('Upstash Redis is not configured.');
  }

  const response = await fetch(restUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${restToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Upstash command failed with ${response.status}: ${errorText}`);
  }

  const payload = await response.json();
  if (payload?.error) {
    throw new Error(payload.error);
  }

  return payload;
}

async function recordTtsAnalytics(source) {
  inMemoryAnalytics.requests += 1;
  if (source === 'memory-hit') {
    inMemoryAnalytics.memory_hit += 1;
  } else if (source === 'persistent-hit') {
    inMemoryAnalytics.persistent_hit += 1;
  } else {
    inMemoryAnalytics.miss += 1;
  }

  if (!isRedisConfigured()) {
    return;
  }

  try {
    const key = getAnalyticsRedisKey();
    const field = source === 'memory-hit' ? 'memory_hit' : source === 'persistent-hit' ? 'persistent_hit' : 'miss';
    await Promise.all([
      upstashCommand(['HINCRBY', key, 'requests', 1]),
      upstashCommand(['HINCRBY', key, field, 1]),
      upstashCommand(['EXPIRE', key, GOOGLE_BLOB_CACHE_MAX_AGE_SECONDS]),
    ]);
  } catch {}
}

async function loadTtsAnalyticsSnapshot() {
  if (!isRedisConfigured()) {
    return { ...inMemoryAnalytics };
  }

  try {
    const response = await upstashCommand(['HMGET', getAnalyticsRedisKey(), ...TTS_ANALYTICS_FIELDS]);
    const values = Array.isArray(response?.result) ? response.result : [];
    return {
      requests: parseCounterValue(values[0]),
      memory_hit: parseCounterValue(values[1]),
      persistent_hit: parseCounterValue(values[2]),
      miss: parseCounterValue(values[3]),
    };
  } catch {
    return { ...inMemoryAnalytics };
  }
}

function isRedisConfigured() {
  return Boolean(getUpstashRestUrl() && getUpstashRestToken());
}

function isBlobConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function getUpstashRestUrl() {
  return (
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ''
  );
}

function getUpstashRestToken() {
  return (
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    ''
  );
}

function isGoogleCredentialsConfigured() {
  const { clientEmail, privateKey } = getGoogleServiceAccount();
  return Boolean(clientEmail && privateKey);
}

function getAnalyticsRedisKey() {
  return `${TTS_ANALYTICS_KEY_PREFIX}:${getAnalyticsWindowLabel()}`;
}

function getAnalyticsWindowLabel() {
  return new Date().toISOString().slice(0, 7);
}

function parseCounterValue(value) {
  return Number.parseInt(String(value ?? '0'), 10) || 0;
}

function roundRatio(value) {
  return Math.round(value * 1000) / 1000;
}

function getRequestOrigin(req) {
  const origin = req.headers?.origin;
  if (typeof origin === 'string' && origin.trim()) {
    return origin.trim();
  }

  const referer = req.headers?.referer;
  if (typeof referer === 'string' && referer.trim()) {
    try {
      const parsed = new URL(referer);
      return parsed.origin;
    } catch {
      return '';
    }
  }

  return '';
}

function getHostFromUrl(value) {
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return '';
  }
}

function getAllowedOriginList() {
  return String(process.env.ALLOWED_APP_ORIGINS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function isSafeVoiceField(value, maxLength) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 && trimmedValue.length <= maxLength && /^[a-zA-Z0-9._-]+$/.test(trimmedValue);
}

function trimInMemoryRateLimitEntries(now = Date.now()) {
  for (const [key, entry] of inMemoryRateLimitEntries.entries()) {
    if (entry.expiresAt <= now) {
      inMemoryRateLimitEntries.delete(key);
    }
  }
}
