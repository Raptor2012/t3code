// The words shown while you hold the dictation key. Display only: release never waits for a
// preview, and the final transcript is decoded from the whole recording.

export interface PreviewDecode {
  readonly text: string;
  readonly tokens: readonly string[];
  readonly timestamps: readonly number[];
}

const RATE = 16000;
const INTERVAL_SECONDS = 0.8;
const WINDOW_SECONDS = 8;
const MIN_SECONDS = 0.65;
const MIN_VOICE_SECONDS = 0.1;
const COMMIT_AFTER_SECONDS = 3;
const KEEP_SECONDS = 1.5;
const PAD_SECONDS = 0.5;
const TOLERANCE_SECONDS = 0.3;

const normalizedWords = (text: string) => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

// A window decoded mid-sentence starts with a capital; lower an ordinary capitalised word there.
function continueCase(text: string, before: string): string {
  const match = /^[A-Z][a-z]+(?:'[a-z]+)?\b/.exec(text);
  if (!before || /[.!?]\s*$/.test(before) || !match || match[0].startsWith("I'")) return text;
  return text[0]!.toLowerCase() + text.slice(1);
}

/**
 * Decodes only the audio after the last committed word, so a long hold costs a short decode per
 * update and the bubble still shows the whole utterance.
 */
export class DictationPreview {
  private session = 0;
  private active = false;
  private inflight: number | undefined;
  private sent: { readonly start: number; readonly length: number } | undefined;
  private audio = new Float32Array(0);
  private base = 0;
  private committed = "";
  private cut: number | undefined;
  private newVoice = 0;
  private lastRequest = -Infinity;

  start(): number {
    this.session++;
    this.active = true;
    this.inflight = undefined;
    this.sent = undefined;
    this.audio = new Float32Array(0);
    this.base = 0;
    this.committed = "";
    this.cut = undefined;
    this.newVoice = 0;
    this.lastRequest = -Infinity;
    return this.session;
  }

  stop(): void {
    this.active = false;
    this.audio = new Float32Array(0);
    this.newVoice = 0;
  }

  push(samples: Float32Array, voiced: boolean): void {
    if (!this.active) return;
    const joined = new Float32Array(this.audio.length + samples.length);
    joined.set(this.audio);
    joined.set(samples, this.audio.length);
    const dropped = Math.max(0, joined.length - WINDOW_SECONDS * RATE);
    this.audio = dropped ? joined.subarray(dropped) : joined;
    this.base += dropped;
    if (voiced) this.newVoice += samples.length;
  }

  request(nowSeconds: number): { session: number; samples: Float32Array } | undefined {
    if (
      !this.active ||
      this.inflight !== undefined ||
      this.audio.length < MIN_SECONDS * RATE ||
      this.newVoice < MIN_VOICE_SECONDS * RATE ||
      nowSeconds < this.lastRequest + INTERVAL_SECONDS
    ) {
      return undefined;
    }
    this.inflight = this.session;
    this.sent = { start: this.base, length: this.audio.length };
    this.lastRequest = nowSeconds;
    this.newVoice = 0;
    return { session: this.session, samples: this.audio.slice() };
  }

  /** The text to show for this hold, or undefined for a stale or empty result. */
  complete(session: number, decode: PreviewDecode): string | undefined {
    if (this.inflight !== session) return undefined;
    this.inflight = undefined;
    const sent = this.sent;
    this.sent = undefined;
    if (!this.active || session !== this.session) return undefined;

    let window = decode.text.trim();
    const { tokens } = decode;
    if (sent && tokens.length > 0 && tokens.length === decode.timestamps.length) {
      const offset = sent.start / RATE;
      const stamps = decode.timestamps.map((stamp) => offset + stamp);
      const words = tokens.flatMap((token, index) =>
        token.startsWith(" ") || index === 0 ? [index] : [],
      );
      const cut = this.cut;
      // Audio before the boundary was decoded last time: skip those words, then any repeat of the
      // committed tail, since timestamps jitter by about 0.2 s.
      let first =
        words.find((index) => cut === undefined || stamps[index]! >= cut - TOLERANCE_SECONDS) ??
        tokens.length;
      if (cut !== undefined) {
        const tail = normalizedWords(this.committed).slice(-3);
        const later = words.filter((index) => index >= first);
        for (let count = Math.min(3, later.length); count > 0; count--) {
          const end = count < later.length ? later[count]! : tokens.length;
          const repeated = normalizedWords(tokens.slice(first, end).join(""));
          if (repeated.join(" ") === tail.slice(-count).join(" ")) {
            first = end;
            break;
          }
        }
      }
      window = continueCase(tokens.slice(first).join("").trim(), this.committed);

      const seconds = sent.length / RATE;
      if (seconds > COMMIT_AFTER_SECONDS) {
        const end = offset + seconds;
        const index = Math.max(
          0,
          ...words.filter((word) => word > first && stamps[word]! <= end - KEEP_SECONDS),
        );
        if (index) {
          const chunk = continueCase(tokens.slice(first, index).join("").trim(), this.committed);
          this.committed = `${this.committed} ${chunk}`.trim();
          window = continueCase(tokens.slice(index).join("").trim(), this.committed);
          this.cut = stamps[index]!;
          // Keep some audio before the boundary word: its onset precedes its timestamp.
          const boundary = Math.floor(Math.max(0, this.cut - PAD_SECONDS) * RATE);
          if (boundary > this.base) {
            this.audio = this.audio.subarray(boundary - this.base);
            this.base = boundary;
          }
        }
      }
    }
    const shown = `${this.committed} ${window}`.trim();
    return shown || undefined;
  }
}
