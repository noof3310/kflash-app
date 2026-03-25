import { useEffect, useMemo, useRef, useState } from 'react';

const FEEDBACK_GAIN = 2;
let webAudioForegroundVersion = 0;
const webAudioForegroundListeners = new Set();
let hasRegisteredWebAudioLifecycleListeners = false;

export async function setAudioModeAsync() {}

function notifyWebAudioForegroundRestore() {
  webAudioForegroundVersion += 1;
  webAudioForegroundListeners.forEach((listener) => {
    try {
      listener(webAudioForegroundVersion);
    } catch {}
  });
}

function ensureWebAudioLifecycleListeners() {
  if (hasRegisteredWebAudioLifecycleListeners || typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      notifyWebAudioForegroundRestore();
    }
  };

  const handlePageShow = () => {
    notifyWebAudioForegroundRestore();
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pageshow', handlePageShow);
  hasRegisteredWebAudioLifecycleListeners = true;
}

function subscribeToWebAudioForegroundRestore(listener) {
  ensureWebAudioLifecycleListeners();
  webAudioForegroundListeners.add(listener);
  return () => {
    webAudioForegroundListeners.delete(listener);
  };
}

function useWebAudioForegroundVersion() {
  const [foregroundVersion, setForegroundVersion] = useState(webAudioForegroundVersion);

  useEffect(() => subscribeToWebAudioForegroundRestore(setForegroundVersion), []);

  return foregroundVersion;
}

export function createAudioPlayer(source) {
  let fallbackAudio = null;
  let audioContext = null;
  let gainNode = null;
  let sourceNode = null;
  let audioBuffer = null;
  let bufferPromise = null;
  let seekOffset = 0;
  let audioSource = getAssetUri(source);
  let volume = 1;
  let foregroundVersion = webAudioForegroundVersion;

  ensureWebAudioLifecycleListeners();

  const cleanupContext = () => {
    if (sourceNode) {
      try {
        sourceNode.stop();
      } catch {}
      sourceNode.disconnect();
      sourceNode = null;
    }

    if (gainNode) {
      gainNode.disconnect();
      gainNode = null;
    }

    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
  };

  const resetAfterForegroundRestore = () => {
    foregroundVersion = webAudioForegroundVersion;
    cleanupContext();
    audioBuffer = null;
    bufferPromise = null;

    if (fallbackAudio) {
      fallbackAudio.pause();
      fallbackAudio.src = audioSource || '';
      fallbackAudio.load();
    }
  };

  const ensureContext = () => {
    if (typeof window === 'undefined') {
      return null;
    }

    if (foregroundVersion !== webAudioForegroundVersion) {
      resetAfterForegroundRestore();
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      return null;
    }

    if (!audioContext) {
      audioContext = new AudioContextClass();
      gainNode = audioContext.createGain();
      gainNode.connect(audioContext.destination);
    }

    gainNode.gain.value = Number.isFinite(volume) ? Math.max(0, volume) : 1;
    return audioContext;
  };

  const ensureFallbackAudio = () => {
    if (typeof window === 'undefined' || typeof window.Audio === 'undefined') {
      return null;
    }

    if (!fallbackAudio) {
      fallbackAudio = new window.Audio(audioSource || undefined);
      fallbackAudio.preload = 'auto';
    }

    fallbackAudio.volume = Math.min(1, Number.isFinite(volume) ? Math.max(0, volume) : 1);
    return fallbackAudio;
  };

  const loadBuffer = async () => {
    if (!audioSource) {
      return null;
    }

    if (audioBuffer) {
      return audioBuffer;
    }

    if (bufferPromise) {
      return bufferPromise;
    }

    const context = ensureContext();
    if (!context) {
      return null;
    }

    bufferPromise = fetch(audioSource)
      .then((response) => response.arrayBuffer())
      .then((arrayBuffer) => context.decodeAudioData(arrayBuffer))
      .then((decodedBuffer) => {
        audioBuffer = decodedBuffer;
        return decodedBuffer;
      })
      .finally(() => {
        bufferPromise = null;
      });

    return bufferPromise;
  };

  return {
    async play() {
      if (!audioSource) {
        return;
      }

      const context = ensureContext();
      if (!context) {
        const element = ensureFallbackAudio();
        if (!element) {
          return;
        }
        if (element.src !== audioSource) {
          element.src = audioSource;
        }
        element.currentTime = Math.max(0, seekOffset);
        await element.play().catch(() => {});
        seekOffset = 0;
        return;
      }

      const buffer = await loadBuffer().catch(() => null);
      if (!buffer || !gainNode) {
        const element = ensureFallbackAudio();
        if (!element) {
          return;
        }
        if (element.src !== audioSource) {
          element.src = audioSource;
        }
        element.currentTime = Math.max(0, seekOffset);
        await element.play().catch(() => {});
        seekOffset = 0;
        return;
      }

      if (context.state === 'suspended') {
        await context.resume().catch(() => {});
      }

      if (sourceNode) {
        try {
          sourceNode.stop();
        } catch {}
        sourceNode.disconnect();
      }

      sourceNode = context.createBufferSource();
      sourceNode.buffer = buffer;
      sourceNode.connect(gainNode);
      sourceNode.start(0, Math.max(0, seekOffset));
      sourceNode.onended = () => {
        if (sourceNode) {
          sourceNode.disconnect();
          sourceNode = null;
        }
      };
      seekOffset = 0;
    },
    pause() {
      if (sourceNode) {
        try {
          sourceNode.stop();
        } catch {}
        sourceNode.disconnect();
        sourceNode = null;
      }
      fallbackAudio?.pause();
    },
    set volume(value) {
      volume = Number.isFinite(value) ? Math.max(0, value) : 1;
      if (gainNode) {
        gainNode.gain.value = volume;
      }
      if (fallbackAudio) {
        fallbackAudio.volume = Math.min(1, volume);
      }
    },
    get volume() {
      return volume;
    },
    replace(nextSource) {
      audioSource = getAssetUri(nextSource);
      audioBuffer = null;
      bufferPromise = null;
      seekOffset = 0;

      if (sourceNode) {
        try {
          sourceNode.stop();
        } catch {}
        sourceNode.disconnect();
        sourceNode = null;
      }

      if (fallbackAudio) {
        fallbackAudio.pause();
        fallbackAudio.src = audioSource || '';
        fallbackAudio.load();
      }
    },
    seekTo(seconds) {
      seekOffset = Number(seconds) || 0;
      if (fallbackAudio) {
        try {
          fallbackAudio.currentTime = seekOffset;
        } catch {}
      }
    },
    remove() {
      cleanupContext();

      if (fallbackAudio) {
        fallbackAudio.pause();
        fallbackAudio.src = '';
        fallbackAudio.load();
        fallbackAudio = null;
      }

      audioBuffer = null;
      bufferPromise = null;
    },
  };
}

export function useAudioPlayer(source) {
  const foregroundVersion = useWebAudioForegroundVersion();
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
  }, [assetUri, foregroundVersion]);

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
      set volume(value) {
        const normalized = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
        volumeRef.current = normalized;
        if (gainNodeRef.current) {
          gainNodeRef.current.gain.value = FEEDBACK_GAIN * normalized;
        }
      },
      get volume() {
        return volumeRef.current;
      },
    }),
    []
  );
}

function getAssetUri(source) {
  const assetSource = Array.isArray(source) ? source[0] : source;
  return typeof assetSource === 'string' ? assetSource : assetSource?.uri ?? null;
}
