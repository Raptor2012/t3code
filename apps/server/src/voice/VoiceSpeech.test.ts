import { describe, expect, it } from "vite-plus/test";

import { encodeWav } from "./VoiceSpeech.ts";

describe("encodeWav", () => {
  it("writes mono 16-bit audio across chunks and clamps out-of-range samples", () => {
    const wav = encodeWav([new Float32Array([0, 1]), new Float32Array([-2])], 24000);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(40)).toBe(6);
    expect([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)]).toEqual([
      0, 32767, -32767,
    ]);
  });
});
