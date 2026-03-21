import { handleOptions, sendJson } from './_lib/googleTts.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    service: 'flash-card-api',
    now: new Date().toISOString(),
  });
}
