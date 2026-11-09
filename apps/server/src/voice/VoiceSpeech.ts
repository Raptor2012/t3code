// @effect-diagnostics globalTimers:off -- Closes the idle speech helper outside Effect, alongside its process.

import { VoiceSpeechError } from "@t3tools/contracts";
import { type Speech, type SpeechOptions, startSpeech } from "@t3tools/shared/maeveSpeech";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const IDLE_CLOSE_MS = 10 * 60_000;

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

/** Starts the voice helper on first use and lets it go when no one has asked for a while. */
class VoiceSpeaker {
  private readonly options: SpeechOptions;
  private speech: Promise<Speech> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private active = 0;

  constructor(options: SpeechOptions) {
    this.options = options;
  }

  async synthesize(text: string): Promise<Buffer> {
    clearTimeout(this.idleTimer);
    this.active++;
    try {
      const speech = await this.start();
      const parts: Float32Array[] = [];
      await speech.speak(text, (pcm) => parts.push(pcm)).done;
      return encodeWav(parts, speech.sampleRate);
    } finally {
      this.active--;
      if (this.active === 0) this.idleTimer = setTimeout(() => this.close(), IDLE_CLOSE_MS);
    }
  }

  private start(): Promise<Speech> {
    if (this.speech) return this.speech;
    const starting = startSpeech(this.options);
    this.speech = starting;
    const forget = () => {
      if (this.speech === starting) this.speech = undefined;
    };
    starting.then((speech) => speech.exited.then(forget), forget);
    return starting;
  }

  close(): void {
    clearTimeout(this.idleTimer);
    const speech = this.speech;
    this.speech = undefined;
    void speech?.then(
      (running) => running.close(),
      () => undefined,
    );
  }
}

function configuredSpeech(): SpeechOptions | undefined {
  // Set by the desktop app, which is the host that owns the voice model.
  const raw = process.env.T3CODE_VOICE_SPEECH;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as SpeechOptions;
  } catch {
    return undefined;
  }
}

/** Reads text aloud with the host's voice model, for clients that cannot run it themselves. */
export class VoiceSpeech extends Context.Service<
  VoiceSpeech,
  {
    /** The spoken text as a base64 WAV file. */
    readonly synthesize: (text: string) => Effect.Effect<string, VoiceSpeechError>;
  }
>()("t3/voice/VoiceSpeech") {}

const make = Effect.gen(function* () {
  const options = configuredSpeech();
  const speaker = options ? new VoiceSpeaker(options) : undefined;
  yield* Effect.addFinalizer(() => Effect.sync(() => speaker?.close()));
  const synthesize = Effect.fn("VoiceSpeech.synthesize")(function* (text: string) {
    if (!speaker) {
      return yield* new VoiceSpeechError({ message: "This host has no voice model." });
    }
    return yield* Effect.tryPromise({
      try: async () => (await speaker.synthesize(text)).toString("base64"),
      catch: (cause) => new VoiceSpeechError({ message: String(cause) }),
    });
  });
  return VoiceSpeech.of({ synthesize });
});

export const layer = Layer.effect(VoiceSpeech, make);
