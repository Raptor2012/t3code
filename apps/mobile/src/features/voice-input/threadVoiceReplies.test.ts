import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./replyPlayback", () => ({
  playReplyAudio: vi.fn(),
  speakWithPhoneVoice: vi.fn(),
  stopReplyAudio: vi.fn(),
}));
vi.mock("../../state/threads", () => ({ environmentThreadDetails: {} }));
vi.mock("../../state/voiceSpeech", () => ({ voiceSpeechEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));

import { VoiceReplyFollower } from "./threadVoiceReplies";

const assistant = (id: string, text: string, streaming = false) => ({
  id,
  role: "assistant",
  text,
  streaming,
});

function setup() {
  const spoken: string[] = [];
  return { spoken, follower: new VoiceReplyFollower((text) => spoken.push(text)) };
}

describe("VoiceReplyFollower", () => {
  it("stays silent until a spoken turn arms it", () => {
    const { spoken, follower } = setup();
    follower.update([assistant("a", "Old reply.")]);
    follower.update([assistant("a", "Old reply."), assistant("b", "New reply.")]);
    expect(spoken).toEqual([]);
  });

  it("treats a thread's first load as history even when already armed", () => {
    const { spoken, follower } = setup();
    follower.arm();
    follower.update([]);
    follower.update([assistant("a", "Old reply.")]);
    follower.update([assistant("a", "Old reply."), assistant("b", "New reply.")]);
    expect(spoken).toEqual(["New reply."]);
  });

  it("reads only replies that arrive after arming, a sentence at a time", () => {
    const { spoken, follower } = setup();
    follower.update([assistant("a", "Old reply.")]);
    follower.arm();
    follower.update([assistant("a", "Old reply."), assistant("b", "First. Sec", true)]);
    follower.update([assistant("a", "Old reply."), assistant("b", "First. Second.")]);
    expect(spoken).toEqual(["First.", "Second."]);
  });

  it("ignores the user's messages and goes quiet when disarmed", () => {
    const { spoken, follower } = setup();
    follower.update([{ id: "first", role: "user", text: "Hi.", streaming: false }]);
    follower.arm();
    follower.update([{ id: "u", role: "user", text: "Hello.", streaming: false }]);
    follower.disarm();
    follower.update([assistant("b", "Not read.")]);
    expect(spoken).toEqual([]);
  });
});
