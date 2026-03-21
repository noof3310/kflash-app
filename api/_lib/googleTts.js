import crypto from 'node:crypto';

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_TTS_BASE_URL = 'https://texttospeech.googleapis.com/v1';
const GOOGLE_TTS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GOOGLE_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const GOOGLE_VOICES_CACHE_TTL_MS = 60 * 60 * 1000;
const GOOGLE_SPEECH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GOOGLE_SPEECH_CACHE_LIMIT = 200;

let cachedAccessToken = '';
let cachedAccessTokenExpiresAt = 0;
const cachedVoicesByLanguage = new Map();
const cachedSpeechPayloads = new Map();

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
    return {
      payload: cachedSpeechEntry.payload,
      cache: { server: 'hit' },
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
  cachedSpeechPayloads.set(speechCacheKey, {
    payload: responsePayload,
    expiresAt: Date.now() + GOOGLE_SPEECH_CACHE_TTL_MS,
  });
  trimSpeechCacheIfNeeded();

  return {
    payload: responsePayload,
    cache: { server: 'miss' },
  };
}

export function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  applyCorsHeaders(res);
  res.end(JSON.stringify(payload));
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

function buildSpeechCacheKey(payload) {
  return JSON.stringify({
    text: payload?.input?.text || '',
    ssml: payload?.input?.ssml || '',
    languageCode: payload?.voice?.languageCode || '',
    name: payload?.voice?.name || '',
    audioEncoding: payload?.audioConfig?.audioEncoding || '',
    speakingRate: payload?.audioConfig?.speakingRate ?? '',
    pitch: payload?.audioConfig?.pitch ?? '',
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
