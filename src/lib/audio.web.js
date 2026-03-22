import { useEffect, useMemo, useRef } from 'react';

const FEEDBACK_GAIN = 5;

export async function setAudioModeAsync() {}

export function createAudioPlayer(source) {
  let audio = null;
  let audioSource = getAssetUri(source);
  let volume = 1;

  const ensureAudio = () => {
    if (typeof window === 'undefined' || typeof window.Audio === 'undefined') {
      return null;
    }

    if (!audio) {
      audio = new window.Audio(audioSource || undefined);
      audio.preload = 'auto';
    }

    return audio;
  };

  return {
    async play() {
      const element = ensureAudio();
      if (!element || !audioSource) {
        return;
      }

      if (element.src !== audioSource) {
        element.src = audioSource;
      }

      element.volume = volume;
      await element.play().catch(() => {});
    },
    pause() {
      audio?.pause();
    },
    replace(nextSource) {
      audioSource = getAssetUri(nextSource);
      if (!audio) {
        return;
      }

      audio.pause();
      audio.src = audioSource || '';
      audio.load();
    },
    seekTo(seconds) {
      if (!audio) {
        return;
      }

      try {
        audio.currentTime = Number(seconds) || 0;
      } catch {}
    },
    get volume() {
      return volume;
    },
    set volume(nextVolume) {
      volume = Math.min(1, Math.max(0, Number(nextVolume) || 0));
      if (audio) {
        audio.volume = volume;
      }
    },
    remove() {
      if (!audio) {
        return;
      }

      audio.pause();
      audio.src = '';
      audio.load();
      audio = null;
    },
  };
}

export function useAudioPlayer(source) {
  const audioContextRef = useRef(null);
  const audioBufferRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const gainNodeRef = useRef(null);
  const seekOffsetRef = useRef(0);
  const volumeRef = useRef(1);
  const assetUri = getAssetUri(source);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass || !assetUri) {
      return undefined;
    }

    const context = new AudioContextClass();
    const gainNode = context.createGain();
    gainNode.gain.value = FEEDBACK_GAIN * volumeRef.current;
    gainNode.connect(context.destination);

    audioContextRef.current = context;
    gainNodeRef.current = gainNode;

    let cancelled = false;

    fetch(assetUri)
      .then((response) => response.arrayBuffer())
      .then((arrayBuffer) => context.decodeAudioData(arrayBuffer))
      .then((buffer) => {
        if (!cancelled) {
          audioBufferRef.current = buffer;
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;

      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.stop();
        } catch {}
        sourceNodeRef.current.disconnect();
      }

      gainNode.disconnect();
      context.close().catch(() => {});
      sourceNodeRef.current = null;
      gainNodeRef.current = null;
      audioContextRef.current = null;
      audioBufferRef.current = null;
    };
  }, [assetUri]);

  return useMemo(
    () => ({
      async play() {
        const context = audioContextRef.current;
        const buffer = audioBufferRef.current;
        const gainNode = gainNodeRef.current;

        if (!context || !buffer || !gainNode) {
          return;
        }

        if (context.state === 'suspended') {
          await context.resume();
        }

        if (sourceNodeRef.current) {
          try {
            sourceNodeRef.current.stop();
          } catch {}
          sourceNodeRef.current.disconnect();
        }

        gainNode.gain.value = FEEDBACK_GAIN * volumeRef.current;

        const sourceNode = context.createBufferSource();
        sourceNode.buffer = buffer;
        sourceNode.connect(gainNode);
        sourceNode.start(0, Math.max(0, seekOffsetRef.current));
        sourceNode.onended = () => {
          if (sourceNodeRef.current === sourceNode) {
            sourceNodeRef.current = null;
          }
        };

        sourceNodeRef.current = sourceNode;
        seekOffsetRef.current = 0;
      },
      pause() {
        if (!sourceNodeRef.current) {
          return;
        }

        try {
          sourceNodeRef.current.stop();
        } catch {}
        sourceNodeRef.current.disconnect();
        sourceNodeRef.current = null;
      },
      seekTo(seconds) {
        seekOffsetRef.current = Number(seconds) || 0;
      },
      get volume() {
        return volumeRef.current;
      },
      set volume(nextVolume) {
        volumeRef.current = Math.min(1, Math.max(0, Number(nextVolume) || 0));
        if (gainNodeRef.current) {
          gainNodeRef.current.gain.value = FEEDBACK_GAIN * volumeRef.current;
        }
      },
    }),
    []
  );
}

function getAssetUri(source) {
  const assetSource = Array.isArray(source) ? source[0] : source;
  return typeof assetSource === 'string' ? assetSource : assetSource?.uri ?? null;
}
