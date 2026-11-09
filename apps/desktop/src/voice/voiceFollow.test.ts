import { describe, expect, it } from "@effect/vitest";

import { followedVoiceOn } from "./voiceFollow.ts";

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
