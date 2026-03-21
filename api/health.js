import { getGoogleTtsBackendStatus, handleOptions, sendJson } from './_lib/googleTts.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const googleTts = await getGoogleTtsBackendStatus().catch((error) => ({
    ok: false,
    error: error?.message || 'Could not load Google TTS backend status.',
  }));

  sendJson(res, 200, {
    ok: true,
    service: 'flash-card-api',
    now: new Date().toISOString(),
    googleTts,
  });
}
