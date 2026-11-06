// @effect-diagnostics nodeBuiltinImport:off -- Loads the sherpa-onnx native addon in the voice engine process.

import * as NodePath from "node:path";

export interface SpeechToTextOptions {
  /** A sherpa-onnx NeMo transducer folder: encoder, decoder and joiner (int8) plus tokens.txt. */
  readonly modelDir: string;
  readonly threads?: number | undefined;
}

export interface SpeechToText {
  readonly transcribe: (samples: Float32Array, sampleRate: number) => Promise<string>;
}

interface SherpaStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}
interface SherpaRecognizer {
  createStream(): SherpaStream;
  decodeAsync(stream: SherpaStream): Promise<void>;
  getResult(stream: SherpaStream): { text: string };
}
interface SherpaModule {
  OfflineRecognizer: { createAsync(config: unknown): Promise<SherpaRecognizer> };
}

export async function loadSpeechToText(options: SpeechToTextOptions): Promise<SpeechToText> {
  const loaded = (await import("sherpa-onnx-node")) as SherpaModule & { default?: SherpaModule };
  const sherpa = loaded.default ?? loaded;
  const file = (name: string) => NodePath.join(options.modelDir, name);
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: file("encoder.int8.onnx"),
        decoder: file("decoder.int8.onnx"),
        joiner: file("joiner.int8.onnx"),
      },
      tokens: file("tokens.txt"),
      numThreads: options.threads ?? 8,
      modelType: "nemo_transducer",
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
  });
  return {
    transcribe: async (samples, sampleRate) => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate, samples });
      await recognizer.decodeAsync(stream);
      return recognizer.getResult(stream).text.trim();
    },
  };
}
