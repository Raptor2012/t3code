import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { ReplyReader } from "@t3tools/client-runtime/voice-input";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { environmentThreadDetails } from "../../state/threads";
import { voiceSpeechEnvironment } from "../../state/voiceSpeech";
import { playReplyAudio, speakWithPhoneVoice, stopReplyAudio } from "./replyPlayback";
import { SpokenReplyQueue } from "./spokenReplyQueue";

export interface VoiceReplyMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
}

/** Hands a thread's new agent replies to `speak`, but only once a spoken turn has armed it. */
export class VoiceReplyFollower {
  private readonly speak: (text: string) => void;
  private readonly reader = new ReplyReader();
  private readonly seen = new Set<string>();
  private armed = false;

  constructor(speak: (text: string) => void) {
    this.speak = speak;
  }

  arm(): void {
    this.armed = true;
  }

  disarm(): void {
    this.armed = false;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  update(messages: ReadonlyArray<VoiceReplyMessage>): void {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      if (!this.armed) {
        this.seen.add(message.id);
        continue;
      }
      if (this.seen.has(message.id)) continue;
      const chunk = this.reader.next(message.id, message.text, !message.streaming);
      if (chunk) this.speak(chunk);
    }
  }
}

let synthesizeOnHost: (text: string) => Promise<string | null> = () => Promise.resolve(null);
let speaking = false;
let version = 0;
const listeners = new Set<() => void>();

function notify() {
  version++;
  for (const listener of listeners) listener();
}

const replies = new SpokenReplyQueue({
  synthesize: (text) => synthesizeOnHost(text),
  play: playReplyAudio,
  speakFallback: speakWithPhoneVoice,
  stopPlayback: stopReplyAudio,
  onSpeakingChange: (value) => {
    speaking = value;
    notify();
  },
});

const followers = new Map<string, VoiceReplyFollower>();

function followerFor(key: string): VoiceReplyFollower {
  let follower = followers.get(key);
  if (!follower) {
    follower = new VoiceReplyFollower((text) => replies.enqueue(text));
    followers.set(key, follower);
  }
  return follower;
}

const repliesFamily = Atom.family((key: string) =>
  Atom.make((get) => {
    const follower = followerFor(key);
    // `subscribe`, not `get`: a rebuild per streaming tick would reset the follower.
    get.subscribe(
      environmentThreadDetails.threadAtom(parseThreadKey(key)),
      (thread) => follower.update(thread?.projection.messages ?? []),
      { immediate: true },
    );
    get.addFinalizer(() => {
      followers.delete(key);
      replies.stop();
    });
  }).pipe(Atom.withLabel(`thread-voice-replies:${key}`)),
);

const noReplies = Atom.make<void>(undefined).pipe(Atom.withLabel("thread-voice-replies:none"));

/** Mount while the thread is on screen so a spoken turn's reply can be read aloud. */
export function threadVoiceReplies(ref: ScopedThreadRef | null): Atom.Atom<void> {
  return ref === null ? noReplies : repliesFamily(threadKey(ref));
}

export function armVoiceReplies(ref: ScopedThreadRef): void {
  followers.get(threadKey(ref))?.arm();
  notify();
}

export function disarmVoiceReplies(ref: ScopedThreadRef): void {
  followers.get(threadKey(ref))?.disarm();
  notify();
}

export function stopSpokenReply(): void {
  replies.stop();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether replies are being spoken, and whether this thread's next reply will be. */
export function useVoiceAgentActivity(ref: ScopedThreadRef) {
  useSyncExternalStore(subscribe, () => version);
  return { speaking, armed: followers.get(threadKey(ref))?.isArmed ?? false };
}

/** Lets replies use the connected host's voice model while this screen is open. */
export function useHostVoice(environmentId: EnvironmentId) {
  const synthesize = useAtomCommand(voiceSpeechEnvironment.synthesize, { reportFailure: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- points the module-level reply queue, which runs outside React, at the open thread's host
  useEffect(() => {
    synthesizeOnHost = async (text) => {
      const result = await synthesize({ environmentId, input: { text } });
      return AsyncResult.isSuccess(result) ? result.value.wavBase64 : null;
    };
  });
}
