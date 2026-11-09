export interface SpokenReplyDeps {
  /** The sentence as audio from the host, or null when the host cannot speak it. */
  readonly synthesize: (text: string) => Promise<string | null>;
  readonly play: (audio: string) => Promise<void>;
  /** Reads the sentence with the phone's own voice. */
  readonly speakFallback: (text: string) => Promise<void>;
  readonly stopPlayback: () => void;
  readonly onSpeakingChange: (speaking: boolean) => void;
}

interface Job {
  readonly text: string;
  readonly audio: Promise<string | null>;
}

/**
 * Plays a reply's sentences in order. Each is fetched as soon as it arrives, so the next is usually
 * ready before the current one ends.
 */
export class SpokenReplyQueue {
  private readonly deps: SpokenReplyDeps;
  private jobs: Job[] = [];
  private generation = 0;
  private running = false;

  constructor(deps: SpokenReplyDeps) {
    this.deps = deps;
  }

  enqueue(text: string): void {
    this.jobs.push({ text, audio: this.deps.synthesize(text).catch(() => null) });
    if (!this.running) void this.drain();
  }

  stop(): void {
    this.generation++;
    this.jobs = [];
    this.deps.stopPlayback();
  }

  private async drain(): Promise<void> {
    this.running = true;
    this.deps.onSpeakingChange(true);
    for (let job = this.jobs.shift(); job; job = this.jobs.shift()) {
      const generation = this.generation;
      const audio = await job.audio;
      if (generation !== this.generation) continue;
      try {
        await (audio === null ? this.deps.speakFallback(job.text) : this.deps.play(audio));
      } catch (error) {
        console.warn("[voice] could not play a reply", error);
      }
    }
    this.running = false;
    this.deps.onSpeakingChange(false);
  }
}
