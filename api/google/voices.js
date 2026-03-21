import {
  handleOptions,
  listGoogleVoices,
  sendJson,
} from '../_lib/googleTts.js';

export default async function handler(req, res) {
  if (handleOptions(req, res)) {
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const languageCode = typeof req.query?.languageCode === 'string' ? req.query.languageCode : undefined;
    const payload = await listGoogleVoices({ languageCode });
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, 500, {
      error: error?.message || 'Could not load Google TTS voices.',
    });
  }
}
