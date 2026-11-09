import { composeDictatedPrompt } from "@t3tools/client-runtime/voice-input";

// About an eighth of a second at 16 kHz, so a slow link batches audio instead of queueing calls.
const MIN_PUSH_BYTES = 4000;

export interface HostDictationDeps {
  /** False when the connected host has no voice models. */
  readonly begin: () => Promise<boolean>;
  readonly push: (pcm: Uint8Array) => Promise<string>;
  readonly finish: () => Promise<string | null>;
  readonly cancel: () => void;
  /** Starts the microphone and returns how to stop it. */
  readonly openMicrophone: (onPcm: (pcm: Uint8Array) => void) => Promise<() => void>;
  readonly readDraft: () => string;
  readonly writeDraft: (text: string) => void;
}

/** One dictation transcribed by the host: audio goes up as you talk, words come straight back. */
export class HostDictation {
  private readonly deps: HostDictationDeps;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private pushing: Promise<void> | null = null;
  private placed: string | undefined;
  private closeMicrophone: (() => void) | undefined;
  private ended = false;

  constructor(deps: HostDictationDeps) {
    this.deps = deps;
  }

  /** False when this host cannot dictate, so the caller can use the phone's own transcription. */
  async start(): Promise<boolean> {
    if (!(await this.deps.begin())) return false;
    if (this.ended) return true;
    try {
      this.closeMicrophone = await this.deps.openMicrophone((pcm) => this.receive(pcm));
    } catch {
      this.deps.cancel();
      return false;
    }
    if (this.ended) this.closeMicrophone();
    return true;
  }

  async stop(): Promise<void> {
    if (this.ended) return;
    this.closeMicrophone?.();
    while (this.pushing || this.pendingBytes > 0) {
      this.pump();
      await this.pushing;
    }
    const text = await this.deps.finish().catch(() => null);
    if (this.ended) return;
    this.ended = true;
    if (text) this.place(text, false);
  }

  cancel(): void {
    if (this.ended) return;
    this.ended = true;
    this.closeMicrophone?.();
    this.deps.cancel();
  }

  private receive(pcm: Uint8Array) {
    this.pending.push(pcm);
    this.pendingBytes += pcm.length;
    if (this.pendingBytes >= MIN_PUSH_BYTES) this.pump();
  }

  private pump() {
    if (this.pushing || this.pendingBytes === 0) return;
    const chunk = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const part of this.pending) {
      chunk.set(part, offset);
      offset += part.length;
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.pushing = this.deps.push(chunk).then(
      (text) => {
        this.pushing = null;
        if (text && !this.ended) this.place(text, true);
        if (this.pendingBytes >= MIN_PUSH_BYTES) this.pump();
      },
      () => {
        this.pushing = null;
      },
    );
  }

  private place(text: string, live: boolean) {
    if (text === this.placed) return;
    const draft = this.deps.readDraft();
    const next = composeDictatedPrompt(draft, text, this.placed, live);
    if (next === draft) return;
    this.placed = text;
    this.deps.writeDraft(next);
  }
}
