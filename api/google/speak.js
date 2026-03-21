import {
  handleOptions,
  readJsonBody,
  sendJson,
  synthesizeGoogleSpeech,
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
    const body = await readJsonBody(req);
    const text = String(body?.input?.text || body?.text || '').trim();
    if (!text) {
      sendJson(res, 400, { error: 'Missing input.text for Google TTS synthesis.' });
      return;
    }

    const payload = await synthesizeGoogleSpeech(body);
    sendJson(res, 200, {
      audioContent: payload.audioContent || '',
      contentType: 'audio/mpeg',
    });
  } catch (error) {
    sendJson(res, 500, {
      error: error?.message || 'Could not synthesize Google TTS audio.',
    });
  }
}
