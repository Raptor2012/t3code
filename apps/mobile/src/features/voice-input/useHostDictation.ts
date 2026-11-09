import type { EnvironmentId } from "@t3tools/contracts";
import { AudioModule, requestRecordingPermissionsAsync } from "expo-audio";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as Base64 from "effect/encoding/Base64";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { makeMutable, type SharedValue } from "react-native-reanimated";

import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";
import { useAtomCommand } from "../../state/use-atom-command";
import { voiceSpeechEnvironment } from "../../state/voiceSpeech";
import { HostDictation } from "./hostDictation";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const SAMPLE_RATE = 16000;
const KEEP_AWAKE_TAG = "voice-input:host";

function levelOf(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const count = Math.floor(pcm.byteLength / 2);
  if (count === 0) return 0;
  let energy = 0;
  for (let index = 0; index < count; index++) {
    const sample = view.getInt16(index * 2, true) / 32768;
    energy += sample * sample;
  }
  return Math.min(1, Math.sqrt(energy / count) * 4);
}

async function openMicrophone(onPcm: (pcm: Uint8Array) => void): Promise<() => void> {
  const permission = await requestRecordingPermissionsAsync();
  if (!permission.granted) throw new Error("Microphone access is required.");
  const session = acquireAudioSession("recording");
  await activateAudioSession(session);
  const stream = new AudioModule.AudioStream({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: "int16",
  });
  const subscription = stream.addListener("audioStreamBuffer", (buffer) =>
    onPcm(new Uint8Array(buffer.data)),
  );
  void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);
  const close = () => {
    subscription.remove();
    stream.stop();
    stream.release();
    void releaseAudioSession(session).catch(() => undefined);
    void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
  };
  try {
    await stream.start();
    // The host's model takes 16 kHz; a device that cannot deliver it uses local transcription.
    if (stream.sampleRate !== SAMPLE_RATE) throw new Error("Unsupported microphone rate.");
  } catch (error) {
    close();
    throw error;
  }
  return close;
}

export type HostDictationPhase = "idle" | "live" | "finishing";

/** Dictation transcribed by the connected host, with the words appearing as you talk. */
export function useHostDictation(input: {
  readonly environmentId: EnvironmentId;
  readonly readDraft: () => string;
  readonly writeDraft: (text: string) => void;
}): {
  readonly phase: HostDictationPhase;
  readonly audioLevels: SharedValue<ReadonlyArray<number>>;
  readonly start: () => Promise<boolean>;
  readonly stop: () => void;
  readonly cancel: () => void;
} {
  const begin = useAtomCommand(voiceSpeechEnvironment.dictationStart, { reportFailure: false });
  const push = useAtomCommand(voiceSpeechEnvironment.dictationPush, { reportFailure: false });
  const finish = useAtomCommand(voiceSpeechEnvironment.dictationFinish, { reportFailure: false });
  const cancelOnHost = useAtomCommand(voiceSpeechEnvironment.dictationCancel, {
    reportFailure: false,
  });
  const latest = useRef(input);
  // oxlint-disable-next-line react/refs -- words arrive asynchronously and must reach the current composer callbacks, not the ones captured at start
  latest.current = input;
  const [phase, setPhase] = useState<HostDictationPhase>("idle");
  const [audioLevels] = useState(() =>
    makeMutable<ReadonlyArray<number>>(Array<number>(VOICE_WAVEFORM_SAMPLE_COUNT).fill(0)),
  );
  const active = useRef<HostDictation | null>(null);

  const stop = () => {
    const dictation = active.current;
    if (!dictation) return;
    setPhase("finishing");
    void dictation.stop().finally(() => {
      if (active.current === dictation) active.current = null;
      setPhase("idle");
    });
  };

  const cancel = () => {
    active.current?.cancel();
    active.current = null;
    setPhase("idle");
  };

  const start = async () => {
    if (active.current) return true;
    const environmentId = latest.current.environmentId;
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dictation = new HostDictation({
      begin: async () =>
        AsyncResult.isSuccess(await begin({ environmentId, input: { sessionId } })),
      push: async (pcm) => {
        const result = await push({
          environmentId,
          input: { sessionId, pcmBase64: Base64.encode(pcm) },
        });
        return AsyncResult.isSuccess(result) ? result.value.text : "";
      },
      finish: async () => {
        const result = await finish({ environmentId, input: { sessionId } });
        return AsyncResult.isSuccess(result) ? result.value.text : null;
      },
      cancel: () => void cancelOnHost({ environmentId, input: { sessionId } }),
      openMicrophone: (onPcm) =>
        openMicrophone((pcm) => {
          const level = levelOf(pcm);
          audioLevels.set((levels) => [...levels.slice(1), level]);
          onPcm(pcm);
        }),
      readDraft: () => latest.current.readDraft(),
      writeDraft: (text) => latest.current.writeDraft(text),
    });
    active.current = dictation;
    setPhase("live");
    const started = await dictation.start();
    if (!started) {
      active.current = null;
      setPhase("idle");
    }
    return started;
  };

  // A recording cannot continue once the app leaves the foreground.
  const stopRef = useRef(stop);
  // oxlint-disable-next-line react/refs -- the app-state listener below is registered once and must call the current stop
  stopRef.current = stop;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finishes the dictation when the operating system backgrounds the app
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") stopRef.current();
    });
    return () => subscription.remove();
  }, []);

  return { phase, audioLevels, start, stop, cancel };
}
