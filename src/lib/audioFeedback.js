export function prepareFeedbackPlayback(currentRequestId, sfxEnabled) {
  return {
    requestId: currentRequestId + 1,
    shouldPlaySound: sfxEnabled,
  };
}
