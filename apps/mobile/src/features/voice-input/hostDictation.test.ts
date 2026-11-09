import { describe, expect, it, vi } from "vite-plus/test";

import { HostDictation } from "./hostDictation";

const CHUNK = new Uint8Array(4000);

function setup(words: string[], final: string | null = null, draft = "") {
  const state = { draft, micClosed: 0, onPcm: (_pcm: Uint8Array) => undefined as void };
  const cancel = vi.fn();
  const begin = vi.fn(async () => true);
  const dictation = new HostDictation({
    begin,
    push: async () => words.shift() ?? "",
    finish: async () => final,
    cancel,
    openMicrophone: async (onPcm) => {
      state.onPcm = onPcm;
      return () => {
        state.micClosed++;
      };
    },
    readDraft: () => state.draft,
    writeDraft: (text) => {
      state.draft = text;
    },
  });
  const settled = async () => {
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  };
  const speak = async () => {
    state.onPcm(CHUNK);
    await settled();
  };
  return { state, dictation, cancel, begin, settled, speak };
}

describe("HostDictation", () => {
  it("shows words as they arrive and adds to what is already in the box", async () => {
    const { state, dictation, speak } = setup(["hello", "hello there"], "Hello there.", "my note");
    await dictation.start();
    await speak();
    expect(state.draft).toBe("my note hello");
    await speak();
    expect(state.draft).toBe("my note hello there");
    await dictation.stop();
    expect(state.draft).toBe("my note Hello there.");
    expect(state.micClosed).toBe(1);
  });

  it("keeps the live words when the host cannot finish", async () => {
    const { state, dictation, speak } = setup(["hello"], null);
    await dictation.start();
    await speak();
    await dictation.stop();
    expect(state.draft).toBe("hello");
  });

  it("stops placing words after cancel, for a send in the middle of a dictation", async () => {
    const { state, dictation, speak, cancel } = setup(["hello", "late words"]);
    await dictation.start();
    await speak();
    dictation.cancel();
    state.draft = "";
    await speak();
    expect(state.draft).toBe("");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("leaves the microphone alone when the host has no voice models", async () => {
    const { state, dictation, begin } = setup([]);
    begin.mockResolvedValue(false);
    expect(await dictation.start()).toBe(false);
    expect(state.micClosed).toBe(0);
  });
});
