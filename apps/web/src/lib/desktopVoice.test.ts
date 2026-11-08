import { describe, expect, it } from "vite-plus/test";

import { composeDictatedPrompt, ReplyOpenGate } from "./desktopVoice";

describe("composeDictatedPrompt", () => {
  it.each([
    ["", "hello", undefined, "hello"],
    ["my note", "hello", undefined, "my note\n\nhello"],
    ["my note\n\nold take", "new take", "old take", "my note\n\nnew take"],
    ["my note\n\nold take", "", "old take", "my note"],
    ["old take", "", "old take", ""],
    ["edited by hand", "", "old take", "edited by hand"],
  ])("%j + %j replacing %j is %j", (current, text, replaces, expected) => {
    expect(composeDictatedPrompt(current, text, replaces)).toBe(expected);
  });
});

describe("ReplyOpenGate", () => {
  const OPENED = 1_000;
  const reply = (messageId: string, updatedAtMs: number) => ({ messageId, updatedAtMs });

  it("treats a finished reply that loads after the thread opens as history", () => {
    const gate = new ReplyOpenGate(OPENED);
    expect(gate.allows(false, null)).toBe(false);
    expect(gate.allows(true, reply("old", 500))).toBe(false);
    expect(gate.allows(true, reply("old", 500))).toBe(false);
  });

  it("stays quiet for a reply already in progress when the thread opens", () => {
    const gate = new ReplyOpenGate(OPENED);
    expect(gate.allows(true, reply("running", 1_500))).toBe(false);
    expect(gate.allows(true, reply("next", 2_000))).toBe(true);
  });

  it("does not read an older reply delivered after a stale first snapshot", () => {
    const gate = new ReplyOpenGate(OPENED);
    expect(gate.allows(true, reply("cached", 300))).toBe(false);
    expect(gate.allows(true, reply("newer-history", 800))).toBe(false);
  });

  it("reads the first reply of a turn that starts after the thread opened", () => {
    const gate = new ReplyOpenGate(OPENED);
    expect(gate.allows(true, null)).toBe(false);
    expect(gate.allows(true, reply("new", 1_200))).toBe(true);
  });
});
