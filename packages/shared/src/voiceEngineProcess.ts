// @effect-diagnostics globalTimers:off -- The shutdown watchdog runs at a child-process callback boundary.
// @effect-diagnostics nodeBuiltinImport:off -- Owns the voice engine child process.

import * as NodeChildProcess from "node:child_process";

import type { PreviewDecode } from "./dictationPreview.ts";
import type {
  DictationResult,
  VoiceEngineConfig,
  VoiceEngineEvent,
  VoiceEngineRequest,
} from "./voiceEngineProtocol.ts";

export interface VoiceEngineReady {
  readonly sampleRate: number;
  readonly cleanup: "gpu+mtp" | "gpu" | "cpu" | "off";
  readonly loadMs: number;
}

export interface VoiceEngineProcess {
  readonly ready: Promise<VoiceEngineReady>;
  readonly dictate: (
    samples: Float32Array,
    sampleRate: number,
    cleanup: boolean,
  ) => Promise<DictationResult>;
  /** Decodes audio for the words shown while the dictation key is held. */
  readonly preview: (samples: Float32Array, sampleRate: number) => Promise<PreviewDecode>;
  /** Streams Maeve's audio for `text` to `onAudio`; resolves when she finishes or is stopped. */
  readonly speak: (
    text: string,
    onAudio: (pcm: Float32Array) => void,
  ) => { readonly id: number; readonly done: Promise<{ ttfaMs: number; stopped: boolean }> };
  readonly stop: (id?: number) => void;
  readonly setFx: (on: boolean) => void;
  readonly close: () => void;
}

interface Waiter<T> {
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

export function startVoiceEngineProcess(
  workerPath: string,
  config: VoiceEngineConfig,
  onExit: (code: number | null) => void,
): VoiceEngineProcess {
  const child = NodeChildProcess.fork(workerPath, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  let nextId = 1;
  const dictations = new Map<number, Waiter<DictationResult>>();
  const previews = new Map<number, Waiter<PreviewDecode>>();
  const utterances = new Map<
    number,
    Waiter<{ ttfaMs: number; stopped: boolean }> & { onAudio: (pcm: Float32Array) => void }
  >();
  let markReady!: Waiter<VoiceEngineReady>;
  const ready = new Promise<VoiceEngineReady>((resolve, reject) => {
    markReady = { resolve, reject };
  });
  const request = (message: VoiceEngineRequest) => {
    if (child.connected) child.send(message);
  };
  const failAll = (error: Error) => {
    markReady.reject(error);
    for (const waiter of dictations.values()) waiter.reject(error);
    for (const waiter of previews.values()) waiter.reject(error);
    for (const waiter of utterances.values()) waiter.reject(error);
    dictations.clear();
    previews.clear();
    utterances.clear();
  };

  child.on("message", (event: VoiceEngineEvent) => {
    switch (event.type) {
      case "ready":
        markReady.resolve(event);
        break;
      case "failed":
        markReady.reject(new Error(event.message));
        break;
      case "dictated":
        dictations.get(event.id)?.resolve(event.result);
        dictations.delete(event.id);
        break;
      case "previewed":
        previews.get(event.id)?.resolve(event.result);
        previews.delete(event.id);
        break;
      case "audio":
        utterances.get(event.id)?.onAudio(event.pcm);
        break;
      case "spoken":
        utterances.get(event.id)?.resolve({ ttfaMs: event.ttfaMs, stopped: event.stopped });
        utterances.delete(event.id);
        break;
      case "error": {
        const error = new Error(event.message);
        dictations.get(event.id)?.reject(error);
        previews.get(event.id)?.reject(error);
        utterances.get(event.id)?.reject(error);
        dictations.delete(event.id);
        previews.delete(event.id);
        utterances.delete(event.id);
        break;
      }
    }
  });
  child.once("error", failAll);
  child.once("exit", (code) => {
    failAll(new Error(`Voice engine exited with code ${code}`));
    onExit(code);
  });
  request({ type: "init", config });

  return {
    ready,
    dictate: (samples, sampleRate, cleanup) => {
      const id = nextId++;
      const result = new Promise<DictationResult>((resolve, reject) => {
        dictations.set(id, { resolve, reject });
      });
      request({ type: "dictate", id, samples, sampleRate, cleanup });
      return result;
    },
    preview: (samples, sampleRate) => {
      const id = nextId++;
      const result = new Promise<PreviewDecode>((resolve, reject) => {
        previews.set(id, { resolve, reject });
      });
      request({ type: "preview", id, samples, sampleRate });
      return result;
    },
    speak: (text, onAudio) => {
      const id = nextId++;
      const done = new Promise<{ ttfaMs: number; stopped: boolean }>((resolve, reject) => {
        utterances.set(id, { resolve, reject, onAudio });
      });
      request({ type: "speak", id, text });
      return { id, done };
    },
    stop: (id) => request({ type: "stop", id }),
    setFx: (on) => request({ type: "fx", on }),
    close: () => {
      if (child.connected) child.disconnect();
      const forceKill = setTimeout(() => child.kill(), 2_000);
      forceKill.unref?.();
      child.once("exit", () => clearTimeout(forceKill));
    },
  };
}
