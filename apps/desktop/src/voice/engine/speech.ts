// @effect-diagnostics nodeBuiltinImport:off -- Owns the t3-maeve-tts child process and its pipes.

import * as NodeChildProcess from "node:child_process";

export interface SpeechOptions {
  /** The t3-maeve-tts executable. */
  readonly binary: string;
  /** A Phonon checkpoint folder with its voices in `voices/`. */
  readonly modelDir: string;
  readonly voice: string;
  readonly threads?: number | undefined;
}

export interface SpokenResult {
  readonly samples: number;
  readonly ttfaMs: number;
  readonly totalMs: number;
  readonly stopped: boolean;
}

export interface Speech {
  readonly sampleRate: number;
  readonly speak: (
    text: string,
    onAudio: (pcm: Float32Array) => void,
  ) => { readonly id: number; readonly done: Promise<SpokenResult> };
  /** Stops one utterance, or everything queued and playing when `id` is omitted. */
  readonly stop: (id?: number) => void;
  readonly close: () => void;
}

const READY = 1;
const AUDIO = 2;
const DONE = 3;
const ERROR = 4;

interface Pending {
  readonly onAudio: (pcm: Float32Array) => void;
  readonly resolve: (result: SpokenResult) => void;
  readonly reject: (error: Error) => void;
}

export function startSpeech(options: SpeechOptions): Promise<Speech> {
  const child = NodeChildProcess.spawn(
    options.binary,
    ["--model", options.modelDir, "--voice", options.voice],
    {
      env: { ...process.env, RAYON_NUM_THREADS: String(options.threads ?? 4) },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    },
  );
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let buffered: Buffer = Buffer.alloc(0);

  return new Promise((resolve, reject) => {
    let ready = false;
    const failAll = (error: Error) => {
      for (const job of pending.values()) job.reject(error);
      pending.clear();
      if (!ready) reject(error);
    };
    child.once("error", failAll);
    child.once("exit", (code) => failAll(new Error(`t3-maeve-tts exited with ${code}`)));
    child.stdout.on("data", (chunk: Buffer) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (buffered.length < 4 + length) break;
        const kind = buffered[4];
        const id = buffered.readUInt32LE(5);
        const payload = buffered.subarray(9, 4 + length);
        buffered = buffered.subarray(4 + length);
        if (kind === READY) {
          ready = true;
          const info = JSON.parse(payload.toString("utf8")) as { sampleRate: number };
          resolve({
            sampleRate: info.sampleRate,
            speak: (text, onAudio) => {
              const id = nextId++;
              const done = new Promise<SpokenResult>((resolveJob, rejectJob) => {
                pending.set(id, { onAudio, resolve: resolveJob, reject: rejectJob });
              });
              child.stdin.write(`${JSON.stringify({ op: "speak", id, text })}\n`);
              return { id, done };
            },
            stop: (id = 0) => {
              child.stdin.write(`${JSON.stringify({ op: "stop", id })}\n`);
            },
            close: () => {
              child.stdin.end();
              child.kill();
            },
          });
        } else if (kind === AUDIO) {
          // Copy out of the pipe buffer, which Node reuses.
          const samples = new Float32Array(payload.length / 4);
          for (let i = 0; i < samples.length; i++) samples[i] = payload.readFloatLE(i * 4);
          pending.get(id)?.onAudio(samples);
        } else if (kind === DONE) {
          pending.get(id)?.resolve(JSON.parse(payload.toString("utf8")) as SpokenResult);
          pending.delete(id);
        } else if (kind === ERROR) {
          const error = new Error(payload.toString("utf8"));
          if (id === 0) failAll(error);
          pending.get(id)?.reject(error);
          pending.delete(id);
        }
      }
    });
  });
}
