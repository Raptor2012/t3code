import { describe, expect, it } from "@effect/vitest";

import { DictationPreview, type PreviewDecode } from "./dictationPreview.ts";
import { followedVoiceOn } from "./voiceFollow.ts";

const RATE = 16000;
const seconds = (value: number) => new Float32Array(Math.round(RATE * value)).fill(0.1);

// Spaced tokens, as Parakeet returns them, one word per `spacing` seconds of the decoded window.
const decoded = (words: string[], spacing = 0.5, start = 0): PreviewDecode => ({
  text: words.join(" "),
  tokens: words.map((word, index) => (index === 0 ? word : ` ${word}`)),
  timestamps: words.map((_, index) => start + index * spacing),
});

describe("DictationPreview", () => {
  it("waits for enough voiced audio, then decodes one window at a time", () => {
    const preview = new DictationPreview();
    const session = preview.start();
    preview.push(seconds(0.4), true);
    expect(preview.request(1)).toBeUndefined();
    preview.push(seconds(0.4), true);
    const first = preview.request(2);
    expect(first?.session).toBe(session);
    expect(first?.samples.length).toBe(RATE * 0.8);
    preview.push(seconds(1), true);
    expect(preview.request(4)).toBeUndefined();
    expect(preview.complete(session, decoded(["hello", "there"]))).toBe("hello there");
    expect(preview.request(4)?.samples.length).toBe(RATE * 1.8);
  });

  it("does not decode silence or more often than the interval", () => {
    const preview = new DictationPreview();
    const session = preview.start();
    preview.push(seconds(1), false);
    expect(preview.request(1)).toBeUndefined();
    preview.push(seconds(0.2), true);
    expect(preview.request(1)).toBeDefined();
    preview.complete(session, decoded(["hello"]));
    preview.push(seconds(0.2), true);
    expect(preview.request(1.5)).toBeUndefined();
    expect(preview.request(1.8)).toBeDefined();
  });

  it("drops a result that arrives after release or from an earlier hold", () => {
    const preview = new DictationPreview();
    const earlier = preview.start();
    preview.push(seconds(1), true);
    preview.request(1);
    preview.stop();
    expect(preview.complete(earlier, decoded(["too", "late"]))).toBeUndefined();

    preview.start();
    preview.push(seconds(1), true);
    expect(preview.request(2)).toBeDefined();
    expect(preview.complete(earlier, decoded(["stale"]))).toBeUndefined();
  });

  it("commits older words so a long hold shows all of it from a short window", () => {
    const preview = new DictationPreview();
    const session = preview.start();
    preview.push(seconds(4), true);
    expect(preview.request(1)?.samples.length).toBe(RATE * 4);
    expect(
      preview.complete(session, decoded(["one", "two", "three", "four", "five", "six", "seven"])),
    ).toBe("one two three four five six seven");

    preview.push(seconds(1), true);
    const next = preview.request(2);
    // Words before 2.5 s are committed; audio from 0.5 s before that boundary is kept.
    expect(next?.samples.length).toBe(RATE * 3);
    expect(
      preview.complete(session, decoded(["five", "six", "seven", "eight", "nine"], 0.5, 0.5)),
    ).toBe("one two three four five six seven eight nine");
  });

  it("caps buffered audio when results stop arriving", () => {
    const preview = new DictationPreview();
    preview.start();
    preview.push(seconds(12), true);
    expect(preview.request(1)?.samples.length).toBe(RATE * 8);
  });
});

describe("followedVoiceOn", () => {
  it("carries Maeve's state from the thread you were following", () => {
    expect(followedVoiceOn({ a: true }, "a", undefined)).toBe(true);
    expect(followedVoiceOn({ a: false, b: true }, "a", undefined)).toBe(false);
  });

  it("starts from the last thread, or on if any thread had Maeve on", () => {
    expect(followedVoiceOn({ a: false, b: true }, undefined, "a")).toBe(false);
    expect(followedVoiceOn({ a: false, b: true }, undefined, undefined)).toBe(true);
    expect(followedVoiceOn(undefined, undefined, undefined)).toBe(false);
  });
});
