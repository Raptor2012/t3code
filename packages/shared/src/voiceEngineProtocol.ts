// Messages between the desktop main process and the voice engine worker (a forked Node child
// with advanced serialization, so typed arrays cross without copying into JSON).

import type { PreviewDecode } from "./dictationPreview.ts";

export interface VoiceEngineConfig {
  readonly speechToText: { readonly modelDir: string; readonly threads?: number };
  readonly cleanup?:
    | {
        readonly llamaServer: string;
        readonly model: string;
        readonly draftModel?: string | undefined;
        readonly gpuLayers?: number | undefined;
      }
    | undefined;
  readonly speech: {
    readonly binary: string;
    readonly modelDir: string;
    readonly voice: string;
    readonly threads?: number;
  };
}

export type VoiceEngineRequest =
  | { readonly type: "init"; readonly config: VoiceEngineConfig }
  | {
      readonly type: "dictate";
      readonly id: number;
      readonly samples: Float32Array;
      readonly sampleRate: number;
      readonly cleanup: boolean;
    }
  | {
      readonly type: "preview";
      readonly id: number;
      readonly samples: Float32Array;
      readonly sampleRate: number;
    }
  | { readonly type: "speak"; readonly id: number; readonly text: string }
  | { readonly type: "stop"; readonly id?: number | undefined }
  | { readonly type: "fx"; readonly on: boolean };

export interface DictationResult {
  readonly raw: string;
  readonly text: string;
  readonly cleanup: "fast" | "model" | "raw" | "off";
  readonly speechToTextMs: number;
  readonly cleanupMs: number;
}

export type VoiceEngineEvent =
  | {
      readonly type: "ready";
      readonly sampleRate: number;
      readonly cleanup: "gpu+mtp" | "gpu" | "cpu" | "off";
      readonly loadMs: number;
    }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "dictated"; readonly id: number; readonly result: DictationResult }
  | { readonly type: "previewed"; readonly id: number; readonly result: PreviewDecode }
  | { readonly type: "audio"; readonly id: number; readonly pcm: Float32Array }
  | {
      readonly type: "spoken";
      readonly id: number;
      readonly ttfaMs: number;
      readonly stopped: boolean;
    }
  | { readonly type: "error"; readonly id: number; readonly message: string };
