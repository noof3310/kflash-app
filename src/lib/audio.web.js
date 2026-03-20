import { useEffect, useMemo } from 'react';

export async function setAudioModeAsync() {}

export function useAudioPlayer(source) {
  const audio = useMemo(() => {
    if (typeof Audio === 'undefined') {
      return null;
    }

    const assetSource = Array.isArray(source) ? source[0] : source;
    const uri = typeof assetSource === 'string' ? assetSource : assetSource?.uri;
    if (!uri) {
      return null;
    }

    const nextAudio = new Audio(uri);
    nextAudio.preload = 'auto';
    return nextAudio;
  }, [source]);

  useEffect(() => {
    return () => {
      if (!audio) {
        return;
      }

      audio.pause();
      audio.src = '';
    };
  }, [audio]);

  return useMemo(
    () => ({
      async play() {
        if (!audio) {
          return;
        }

        await audio.play();
      },
      pause() {
        audio?.pause();
      },
      seekTo(seconds) {
        if (!audio) {
          return;
        }

        audio.currentTime = Number(seconds) || 0;
      },
    }),
    [audio]
  );
}
