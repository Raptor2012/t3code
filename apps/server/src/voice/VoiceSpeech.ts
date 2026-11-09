// @effect-diagnostics globalTimers:off globalDate:off -- Closes the idle voice engine outside Effect, alongside its process.

import { VoiceSpeechError } from "@t3tools/contracts";
import { DictationPreview, type PreviewDecode } from "@t3tools/shared/dictationPreview";
import {
  startVoiceEngineProcess,
  type VoiceEngineProcess,
} from "@t3tools/shared/voiceEngineProcess";
import type { VoiceEngineConfig } from "@t3tools/shared/voiceEngineProtocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const RATE = 16000;
const IDLE_CLOSE_MS = 10 * 60_000;
const ABANDONED_SESSION_MS = 60_000;
const MIN_DICTATION_SAMPLES = RATE * 0.25;
const VOICED_RMS = 0.004;
const EMPTY_DECODE: PreviewDecode = { text: "", tokens: [], timestamps: [] };

/** Mono 16-bit WAV: every phone can play it, without a streaming audio path. */
export function encodeWav(parts: ReadonlyArray<Float32Array>, sampleRate: number): Buffer {
  const samples = parts.reduce((total, part) => total + part.length, 0);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(samples * 2, 40);
  let offset = 44;
  for (const part of parts) {
    for (const sample of part) {
      wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), offset);
      offset += 2;
    }
  }
  return wav;
}

export function decodePcm16(pcm: Buffer): Float32Array {
  const samples = new Float32Array(Math.floor(pcm.length / 2));
  for (let index = 0; index < samples.length; index++) {
    samples[index] = pcm.readInt16LE(index * 2) / 32768;
  }
  return samples;
}

function isVoiced(samples: Float32Array): boolean {
  if (samples.length === 0) return false;
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / samples.length) > VOICED_RMS;
}

interface DictationSession {
  readonly preview: DictationPreview;
  readonly previewSession: number;
  readonly chunks: Float32Array[];
  shown: string;
  touchedAt: number;
}

interface HostVoiceOptions {
  readonly workerPath: string;
  readonly config: VoiceEngineConfig;
}

/** Runs the voice engine for phones: started on first use, closed after a quiet while. */
class HostVoice {
  private readonly options: HostVoiceOptions;
  private readonly sessions = new Map<string, DictationSession>();
  private engine: VoiceEngineProcess | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: HostVoiceOptions) {
    this.options = options;
  }

  async synthesize(text: string): Promise<Buffer> {
    const engine = await this.ready();
    const { sampleRate } = await engine.ready;
    const parts: Float32Array[] = [];
    await engine.speak(text, (pcm) => parts.push(pcm)).done;
    return encodeWav(parts, sampleRate);
  }

  beginDictation(sessionId: string): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.touchedAt > ABANDONED_SESSION_MS) this.sessions.delete(id);
    }
    const preview = new DictationPreview();
    this.sessions.set(sessionId, {
      preview,
      previewSession: preview.start(),
      chunks: [],
      shown: "",
      touchedAt: now,
    });
    // Warm the engine now, so the first words are not waiting on it.
    void this.ready().catch(() => undefined);
  }

  /** Adds audio and returns the words recognised so far. */
  pushDictation(sessionId: string, pcm: Buffer): string {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("That dictation has ended.");
    session.touchedAt = Date.now();
    const samples = decodePcm16(pcm);
    session.chunks.push(samples);
    session.preview.push(samples, isVoiced(samples));
    const request = session.preview.request(performance.now() / 1000);
    if (request) {
      const finish = (decode: PreviewDecode) => {
        const shown = session.preview.complete(request.session, decode);
        if (shown) session.shown = shown;
      };
      void this.ready()
        .then((engine) => engine.preview(request.samples, RATE))
        .then(finish, () => finish(EMPTY_DECODE));
    }
    return session.shown;
  }

  async finishDictation(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("That dictation has ended.");
    this.sessions.delete(sessionId);
    session.preview.stop();
    const length = session.chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (length < MIN_DICTATION_SAMPLES) return "";
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of session.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    const engine = await this.ready();
    return (await engine.dictate(samples, RATE, true)).text;
  }

  cancelDictation(sessionId: string): void {
    this.sessions.get(sessionId)?.preview.stop();
    this.sessions.delete(sessionId);
  }

  private ready(): Promise<VoiceEngineProcess> {
    this.keepOpen();
    let engine = this.engine;
    if (!engine) {
      const started = startVoiceEngineProcess(this.options.workerPath, this.options.config, () =>
        this.forget(started),
      );
      this.engine = started;
      started.ready.catch(() => this.forget(started));
      engine = started;
    }
    const running = engine;
    return running.ready.then(() => running);
  }

  private forget(engine: VoiceEngineProcess) {
    if (this.engine === engine) this.engine = undefined;
  }

  private keepOpen() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.sessions.size > 0) this.keepOpen();
      else this.close();
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }

  close(): void {
    clearTimeout(this.idleTimer);
    this.engine?.close();
    this.engine = undefined;
  }
}

function configuredVoice(): HostVoiceOptions | undefined {
  // Set by the desktop app, which is the host that owns the voice models.
  const raw = process.env.T3CODE_VOICE_ENGINE;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as HostVoiceOptions;
  } catch {
    return undefined;
  }
}

/** The host's voice models, for clients that cannot run them themselves. */
export class VoiceSpeech extends Context.Service<
  VoiceSpeech,
  {
    /** The spoken text as a base64 WAV file. */
    readonly synthesize: (text: string) => Effect.Effect<string, VoiceSpeechError>;
    readonly dictationStart: (sessionId: string) => Effect.Effect<void, VoiceSpeechError>;
    /** Adds 16 kHz mono 16-bit audio and returns the words so far. */
    readonly dictationPush: (
      sessionId: string,
      pcmBase64: string,
    ) => Effect.Effect<string, VoiceSpeechError>;
    readonly dictationFinish: (sessionId: string) => Effect.Effect<string, VoiceSpeechError>;
    readonly dictationCancel: (sessionId: string) => Effect.Effect<void>;
  }
>()("t3/voice/VoiceSpeech") {}

const failure = (cause: unknown) => new VoiceSpeechError({ message: String(cause) });
const unavailable = new VoiceSpeechError({ message: "This host has no voice models." });

const make = Effect.gen(function* () {
  const options = configuredVoice();
  const voice = options ? new HostVoice(options) : undefined;
  yield* Effect.addFinalizer(() => Effect.sync(() => voice?.close()));

  const synthesize = Effect.fn("VoiceSpeech.synthesize")(function* (text: string) {
    if (!voice) return yield* unavailable;
    return yield* Effect.tryPromise({
      try: async () => (await voice.synthesize(text)).toString("base64"),
      catch: failure,
    });
  });
  const dictationStart = Effect.fn("VoiceSpeech.dictationStart")(function* (sessionId: string) {
    if (!voice) return yield* unavailable;
    voice.beginDictation(sessionId);
  });
  // Runs several times a second for each dictation.
  const dictationPush = Effect.fnUntraced(function* (sessionId: string, pcmBase64: string) {
    if (!voice) return yield* unavailable;
    return yield* Effect.try({
      try: () => voice.pushDictation(sessionId, Buffer.from(pcmBase64, "base64")),
      catch: failure,
    });
  });
  const dictationFinish = Effect.fn("VoiceSpeech.dictationFinish")(function* (sessionId: string) {
    if (!voice) return yield* unavailable;
    return yield* Effect.tryPromise({
      try: () => voice.finishDictation(sessionId),
      catch: failure,
    });
  });
  const dictationCancel = (sessionId: string) =>
    Effect.sync(() => voice?.cancelDictation(sessionId));

  return VoiceSpeech.of({
    synthesize,
    dictationStart,
    dictationPush,
    dictationFinish,
    dictationCancel,
  });
});

export const layer = Layer.effect(VoiceSpeech, make);
