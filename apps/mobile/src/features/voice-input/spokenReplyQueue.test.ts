import { describe, expect, it } from "vite-plus/test";

import { SpokenReplyQueue } from "./spokenReplyQueue";

function setup(synthesize: (text: string) => Promise<string | null>) {
  const heard: string[] = [];
  const speaking: boolean[] = [];
  let finishPlaying: (() => void) | undefined;
  const queue = new SpokenReplyQueue({
    synthesize,
    play: (audio) =>
      new Promise((resolve) => {
        heard.push(audio);
        finishPlaying = resolve;
      }),
    speakFallback: async (text) => {
      heard.push(`phone:${text}`);
    },
    stopPlayback: () => finishPlaying?.(),
    onSpeakingChange: (value) => speaking.push(value),
  });
  const settled = async () => {
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  };
  return { queue, heard, speaking, settled, finish: () => finishPlaying?.() };
}

describe("SpokenReplyQueue", () => {
  it("plays in order even when a later sentence is ready first", async () => {
    let resolveFirst: (audio: string) => void = () => undefined;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const { queue, heard, speaking, settled, finish } = setup((text) =>
      text === "one" ? first : Promise.resolve("audio-two"),
    );
    queue.enqueue("one");
    queue.enqueue("two");
    await settled();
    expect(heard).toEqual([]);
    resolveFirst("audio-one");
    await settled();
    finish();
    await settled();
    finish();
    await settled();
    expect(heard).toEqual(["audio-one", "audio-two"]);
    expect(speaking).toEqual([true, false]);
  });

  it("falls back to the phone's voice when the host cannot speak", async () => {
    const { queue, heard, settled } = setup(() => Promise.reject(new Error("no model")));
    queue.enqueue("hello");
    await settled();
    expect(heard).toEqual(["phone:hello"]);
  });

  it("stop drops sentences that are queued or still being fetched", async () => {
    let resolveFirst: (audio: string) => void = () => undefined;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const { queue, heard, speaking, settled } = setup((text) =>
      text === "one" ? first : Promise.resolve("audio-two"),
    );
    queue.enqueue("one");
    queue.enqueue("two");
    queue.stop();
    resolveFirst("audio-one");
    await settled();
    expect(heard).toEqual([]);
    expect(speaking).toEqual([true, false]);
  });
});
