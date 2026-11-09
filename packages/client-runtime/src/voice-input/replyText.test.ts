import { describe, expect, it } from "@effect/vitest";

import { cleanProse, ReplyReader } from "./replyText.ts";

describe("cleanProse", () => {
  it.each([
    ["Run `vp test` now.", "Run vp test now."],
    ["## Summary\nAll good", "Summary. All good"],
    ["See [the docs](https://x.dev) or https://x.dev/a", "See the docs or"],
    ["Before\n```ts\nconst x = 1;\n```\nAfter", "Before After"],
    ["- **one**\n- two", "one two"],
    ["a &amp; b", "a & b"],
  ])("speaks %j as %j", (input, spoken) => {
    expect(cleanProse(input)).toBe(spoken);
  });
});

describe("ReplyReader", () => {
  it("speaks whole sentences while streaming, then the rest, never repeating", () => {
    const reader = new ReplyReader();
    expect(reader.next("m", "I found it", false)).toBe("");
    expect(reader.next("m", "I found it. Fixing", false)).toBe("I found it.");
    expect(reader.next("m", "I found it. Fixing now. Done", false)).toBe("Fixing now.");
    expect(reader.next("m", "I found it. Fixing now. Done", true)).toBe("Done");
  });

  it("never rereads a finished reply when it is reported again", () => {
    const reader = new ReplyReader();
    expect(reader.next("m", "All done here.", true)).toBe("All done here.");
    expect(reader.next("m", "All done here.", true)).toBe("");
  });

  it("never reads a half-open code fence", () => {
    const reader = new ReplyReader();
    expect(reader.next("m", "Here is the change. \n``", false)).toBe("");
    expect(reader.next("m", "Here is the change.\n```ts\nconst x = 1;\n```", true)).toBe(
      "Here is the change.",
    );
  });

  it("goes quiet when the reply is rewritten under spoken text", () => {
    const reader = new ReplyReader();
    expect(reader.next("m", "First try. More", false)).toBe("First try.");
    expect(reader.next("m", "Second try. More", false)).toBe("");
    expect(reader.next("m", "Second try. More", true)).toBe("");
  });
});
