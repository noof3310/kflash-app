import { useMemo } from 'react';

export async function setAudioModeAsync() {}

export function useAudioPlayer() {
  return useMemo(
    () => ({
      play() {},
      pause() {},
      seekTo() {},
    }),
    []
  );
}
