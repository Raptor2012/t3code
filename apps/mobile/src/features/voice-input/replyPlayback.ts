import { createAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import * as Speech from "expo-speech";

import {
  acquireAudioSession,
  activateAudioSession,
  disposeAudioPlayer,
  releaseAudioSession,
} from "../../lib/audioSession";

const WAV_BYTES_PER_SECOND = 48_000;
const PLAYBACK_GRACE_MS = 3_000;

let stopCurrent: (() => void) | undefined;
let nextFile = 1;

/** Plays one base64 WAV to its end, or until `stopReplyAudio`. */
export async function playReplyAudio(wavBase64: string): Promise<void> {
  const session = acquireAudioSession("playback", () => stopCurrent?.());
  const file = new File(Paths.cache, `voice-reply-${nextFile++}.wav`);
  file.create({ overwrite: true });
  file.write(wavBase64, { encoding: "base64" });
  const player = createAudioPlayer({ uri: file.uri }, { updateInterval: 250 });
  try {
    if (!(await activateAudioSession(session))) return;
    const seconds = (wavBase64.length * 0.75) / WAV_BYTES_PER_SECOND;
    await new Promise<void>((resolve) => {
      // A player that never reports its end must not hold the rest of the reply back.
      const watchdog = setTimeout(resolve, seconds * 1000 + PLAYBACK_GRACE_MS);
      const finish = () => {
        clearTimeout(watchdog);
        subscription.remove();
        stopCurrent = undefined;
        resolve();
      };
      const subscription = player.addListener("playbackStatusUpdate", (status) => {
        if (status.didJustFinish) finish();
      });
      stopCurrent = finish;
      player.play();
    });
  } finally {
    disposeAudioPlayer(player);
    await releaseAudioSession(session).catch(() => undefined);
    if (file.exists) file.delete();
  }
}

export function speakWithPhoneVoice(text: string): Promise<void> {
  return new Promise((resolve) => {
    Speech.speak(text, { onDone: resolve, onStopped: resolve, onError: () => resolve() });
  });
}

export function stopReplyAudio(): void {
  stopCurrent?.();
  void Speech.stop();
}
