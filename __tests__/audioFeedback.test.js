import { prepareFeedbackPlayback } from '../src/lib/audioFeedback';

describe('prepareFeedbackPlayback', () => {
  test('reserves a new feedback request id even when SFX is disabled', () => {
    expect(prepareFeedbackPlayback(7, false)).toEqual({
      requestId: 8,
      shouldPlaySound: false,
    });
  });

  test('keeps sound playback enabled when SFX is on', () => {
    expect(prepareFeedbackPlayback(2, true)).toEqual({
      requestId: 3,
      shouldPlaySound: true,
    });
  });
});
