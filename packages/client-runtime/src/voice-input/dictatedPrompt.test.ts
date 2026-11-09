import { describe, expect, it } from "vite-plus/test";

import { composeDictatedPrompt } from "./dictatedPrompt.ts";

describe("composeDictatedPrompt", () => {
  it.each([
    ["", "hello", undefined, "hello"],
    ["my note", "hello", undefined, "my note hello"],
    ["my note\n\nold take", "new take", "old take", "my note\n\nnew take"],
    ["my note\n\nold take", "", "old take", "my note"],
    ["old take", "", "old take", ""],
    ["edited by hand", "", "old take", "edited by hand"],
    ["go home and go home", "go home now", "go home", "go home and go home now"],
  ])("%j + %j replacing %j is %j", (current, text, replaces, expected) => {
    expect(composeDictatedPrompt(current, text, replaces)).toBe(expected);
  });

  it("drops live words once the words they replace were sent", () => {
    expect(composeDictatedPrompt("", "more words", "some words", true)).toBe("");
  });
});
