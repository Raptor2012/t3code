// @effect-diagnostics globalTimers:off -- Browser preload code; the microphone idle timer runs outside Effect.
// Preload for the voice orb window. The page (resources/voice/orb.html) is unchanged from the
// standalone orb, so this exposes the same `pywebview.api` it calls, and owns the window's audio:
// microphone capture at 16 kHz for dictation and Maeve's playback at 24 kHz.
import { contextBridge, ipcRenderer } from "electron";

const ORB_ACTIONS = [
  "audio_devices",
  "cancel_review",
  "confirm_review",
  "drag_window",
  "quit",
  "select",
  "set_appearance",
  "set_delivery",
  "set_expanded",
  "set_hit_regions",
  "set_hover",
  "set_mic_device",
  "set_panel_extra",
  "set_speaker_device",
  "stop",
  "test_voice",
  "toggle_cleanup",
  "toggle_dock",
  "toggle_follow_active",
  "toggle_maeve_mute",
  "toggle_mic_mute",
  "toggle_startup",
  "toggle_voice",
  "toggle_voice_fx",
  "update_review_text",
] as const;

const BANDS = 11;

// Eleven speech bands from 100 Hz to 6 kHz on a log scale, mapped like the standalone orb's
// numpy version: (dB + 72) / 42, clipped to 0..1.
function bandsFrom(analyser: AnalyserNode, scratch: Float32Array<ArrayBuffer>): number[] {
  analyser.getFloatFrequencyData(scratch);
  const nyquist = analyser.context.sampleRate / 2;
  const top = Math.min(6000, nyquist);
  const bands: number[] = [];
  for (let band = 0; band < BANDS; band++) {
    const low = 100 * (top / 100) ** (band / BANDS);
    const high = 100 * (top / 100) ** ((band + 1) / BANDS);
    let first = Math.floor((low / nyquist) * scratch.length);
    let last = Math.ceil((high / nyquist) * scratch.length);
    first = Math.min(first, scratch.length - 1);
    last = Math.max(first + 1, Math.min(last, scratch.length));
    let peak = -Infinity;
    for (let i = first; i < last; i++) peak = Math.max(peak, scratch[i]!);
    bands.push(Math.max(0, Math.min(1, (peak + 72) / 42)));
  }
  return bands;
}

function levelFrom(analyser: AnalyserNode, scratch: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(scratch);
  let sum = 0;
  for (const sample of scratch) sum += sample * sample;
  return Math.sqrt(sum / scratch.length);
}

const CAPTURE_WORKLET = `
registerProcessor("voice-capture", class extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
});`;

// A ring of queued utterance audio; reports how much of each utterance has played so the page
// can keep its reply text in step with Maeve's voice.
const PLAYBACK_WORKLET = `
registerProcessor("voice-playback", class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.played = new Map();
    this.port.onmessage = ({ data }) => {
      if (data.type === "audio") this.queue.push({ id: data.id, pcm: data.pcm });
      else if (data.type === "flush") { this.queue = []; this.offset = 0; }
    };
    this.reported = 0;
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    let written = 0;
    while (written < out.length && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(out.length - written, head.pcm.length - this.offset);
      out.set(head.pcm.subarray(this.offset, this.offset + take), written);
      written += take;
      this.offset += take;
      this.played.set(head.id, (this.played.get(head.id) || 0) + take);
      if (this.offset >= head.pcm.length) { this.queue.shift(); this.offset = 0; }
    }
    out.fill(0, written);
    if (currentFrame - this.reported >= 2400) {
      this.reported = currentFrame;
      this.port.postMessage({ played: [...this.played], queued: this.queue.length });
    }
    return true;
  }
});`;

const workletUrl = (source: string) =>
  URL.createObjectURL(new Blob([source], { type: "text/javascript" }));

interface Playback {
  readonly context: AudioContext;
  readonly node: AudioWorkletNode;
  readonly analyser: AnalyserNode;
}

function joinChunks(chunks: readonly Float32Array[]): Float32Array {
  const joined = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

class OrbAudio {
  private capture:
    | {
        context: AudioContext;
        stream: MediaStream;
        node: AudioWorkletNode;
        analyser: AnalyserNode;
        deviceId: string;
      }
    | undefined;
  private recording: Float32Array[] | undefined;
  private forwarded = 0;
  private previewTimer: ReturnType<typeof setInterval> | undefined;
  private captureIdle: ReturnType<typeof setTimeout> | undefined;
  private playback: Playback | undefined;
  private openingPlayback: Promise<Playback> | undefined;
  private played = new Map<number, number>();
  private readonly frequency = new Float32Array(256);
  private readonly time = new Float32Array(512);

  micDevice = "";
  speakerDevice = "";

  async startRecording(): Promise<void> {
    if (this.captureIdle) clearTimeout(this.captureIdle);
    this.recording = [];
    this.forwarded = 0;
    this.previewTimer = setInterval(() => this.forwardPreview(), 100);
    const capture = await this.ensureCapture();
    if (capture.context.state === "suspended") await capture.context.resume();
  }

  stopRecording(): Float32Array {
    const chunks = this.recording ?? [];
    this.recording = undefined;
    if (this.previewTimer) clearInterval(this.previewTimer);
    // Keep the microphone open briefly so a quick follow-up starts without the device warm-up.
    this.captureIdle = setTimeout(() => this.closeCapture(), 30_000);
    return joinChunks(chunks);
  }

  private forwardPreview() {
    const chunks = this.recording;
    if (!chunks || chunks.length === this.forwarded) return;
    const samples = joinChunks(chunks.slice(this.forwarded));
    this.forwarded = chunks.length;
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    ipcRenderer.send("voice-orb:preview-audio", samples, Math.sqrt(sum / samples.length) > 0.004);
  }

  async play(id: number, pcm: Float32Array): Promise<void> {
    const playback = await this.ensurePlayback();
    playback.node.port.postMessage({ type: "audio", id, pcm }, [pcm.buffer]);
  }

  flush(): void {
    this.playback?.node.port.postMessage({ type: "flush" });
  }

  playedSamples(id: number): number {
    return this.played.get(id) ?? 0;
  }

  levels() {
    const mic = this.capture && this.recording ? this.capture.analyser : undefined;
    const out = this.playback?.analyser;
    return {
      mic: mic ? levelFrom(mic, this.time) : 0,
      micBands: mic ? bandsFrom(mic, this.frequency) : new Array(BANDS).fill(0),
      out: out ? levelFrom(out, this.time) : 0,
      outBands: out ? bandsFrom(out, this.frequency) : new Array(BANDS).fill(0),
    };
  }

  async devices(kind: "audioinput" | "audiooutput") {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((device) => device.kind === kind && device.deviceId !== "communications")
      .map((device) => ({
        id: device.deviceId === "default" ? "" : device.deviceId,
        label: device.label,
      }));
  }

  async setSpeaker(deviceId: string): Promise<void> {
    this.speakerDevice = deviceId;
    const context = this.playback?.context as
      | (AudioContext & { setSinkId?: (id: string) => Promise<void> })
      | undefined;
    await context?.setSinkId?.(deviceId);
  }

  setMic(deviceId: string): void {
    this.micDevice = deviceId;
    this.closeCapture();
  }

  private async ensureCapture() {
    if (this.capture && this.capture.deviceId === this.micDevice) return this.capture;
    this.closeCapture();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(this.micDevice ? { deviceId: { exact: this.micDevice } } : {}),
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const context = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
    await context.audioWorklet.addModule(workletUrl(CAPTURE_WORKLET));
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, "voice-capture");
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    node.port.onmessage = ({ data }: MessageEvent<Float32Array>) => this.recording?.push(data);
    source.connect(node);
    source.connect(analyser);
    // A worklet only runs while connected to the graph's output; it writes silence there.
    node.connect(context.destination);
    this.capture = { context, stream, node, analyser, deviceId: this.micDevice };
    return this.capture;
  }

  private closeCapture() {
    if (!this.capture) return;
    for (const track of this.capture.stream.getTracks()) track.stop();
    void this.capture.context.close();
    this.capture = undefined;
  }

  // Maeve's first audio arrives in a burst; every chunk must wait on the one player being opened.
  private ensurePlayback(): Promise<Playback> {
    this.openingPlayback ??= this.openPlayback().catch((error: Error) => {
      this.openingPlayback = undefined;
      throw error;
    });
    return this.openingPlayback;
  }

  private async openPlayback(): Promise<Playback> {
    const context = new AudioContext({ sampleRate: 24000, latencyHint: "interactive" });
    await context.audioWorklet.addModule(workletUrl(PLAYBACK_WORKLET));
    const node = new AudioWorkletNode(context, "voice-playback", { outputChannelCount: [1] });
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    node.connect(analyser);
    analyser.connect(context.destination);
    node.port.onmessage = ({ data }: MessageEvent<{ played: Array<[number, number]> }>) => {
      for (const [id, samples] of data.played) this.played.set(id, samples);
    };
    const sink = context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (this.speakerDevice) await sink.setSinkId?.(this.speakerDevice).catch(() => undefined);
    if (context.state === "suspended") void context.resume();
    this.playback = { context, node, analyser };
    return this.playback;
  }
}

const audio = new OrbAudio();

const api: Record<string, (...args: unknown[]) => Promise<unknown>> = {
  poll: async (choosingDelivery: unknown, regions: unknown) => {
    const snapshot = (await ipcRenderer.invoke(
      "voice-orb:poll",
      choosingDelivery,
      regions,
    )) as Record<string, unknown> & {
      playback?: { run?: number; total?: number; final?: boolean } | null;
    };
    const levels = audio.levels();
    const playback = snapshot.playback;
    if (!playback || typeof playback.run !== "number") return { ...snapshot, ...levels };
    const played = Math.min(playback.total ?? 0, audio.playedSamples(playback.run));
    return {
      ...snapshot,
      ...levels,
      playback: {
        ...playback,
        played,
        fraction: playback.total && playback.final ? played / playback.total : null,
        active: Boolean(playback.total && (!playback.final || played < playback.total)),
      },
    };
  },
  audio_devices: async () => ({
    inputs: await audio.devices("audioinput"),
    outputs: await audio.devices("audiooutput"),
    mic: audio.micDevice,
    speaker: audio.speakerDevice,
  }),
  set_mic_device: async (deviceId: unknown) => {
    audio.setMic(String(deviceId ?? ""));
    return ipcRenderer.invoke("voice-orb:action", "set_mic_device", [deviceId]);
  },
  set_speaker_device: async (deviceId: unknown) => {
    await audio.setSpeaker(String(deviceId ?? ""));
    return ipcRenderer.invoke("voice-orb:action", "set_speaker_device", [deviceId]);
  },
};
for (const name of ORB_ACTIONS) {
  api[name] ??= (...args: unknown[]) => ipcRenderer.invoke("voice-orb:action", name, args);
}

contextBridge.exposeInMainWorld("pywebview", { api });

ipcRenderer.on("voice-orb:devices", (_event, devices: { mic: string; speaker: string }) => {
  audio.micDevice = devices.mic;
  void audio.setSpeaker(devices.speaker);
});
ipcRenderer.on("voice-orb:record-start", () => {
  audio.startRecording().catch((error: Error) => {
    ipcRenderer.send("voice-orb:recorded", { error: error.message });
  });
});
ipcRenderer.on("voice-orb:record-stop", () => {
  const samples = audio.stopRecording();
  ipcRenderer.send("voice-orb:recorded", { samples, sampleRate: 16000 });
});
ipcRenderer.on("voice-orb:audio", (_event, chunk: { id: number; pcm: Float32Array }) => {
  audio.play(chunk.id, chunk.pcm).catch((error: Error) => {
    ipcRenderer.send("voice-orb:playback-failed", error.message);
  });
});
ipcRenderer.on("voice-orb:flush", () => audio.flush());
ipcRenderer.on("voice-orb:open-card", () => window.dispatchEvent(new Event("maeve-open-card")));

window.addEventListener("DOMContentLoaded", () => {
  window.dispatchEvent(new Event("pywebviewready"));
});
