// A plain Node child that owns speech-to-text, the cleanup model and Maeve's voice, so their
// native code and CPU work never touch the Electron main process.
import { cleanupDictation } from "./engine/cleanup.ts";
import { type LlamaServer, startLlamaServer } from "./engine/llamaServer.ts";
import type { VoiceEngineEvent, VoiceEngineRequest } from "./engine/protocol.ts";
import { type Speech, startSpeech } from "./engine/speech.ts";
import { loadSpeechToText, type SpeechToText } from "./engine/speechToText.ts";

const send = (event: VoiceEngineEvent) => {
  try {
    process.send?.(event);
  } catch {}
};

let stt: SpeechToText | undefined;
let llama: LlamaServer | undefined;
let speech: Speech | undefined;
// Main ids for utterances, by the speech helper's own ids.
const utterances = new Map<number, number>();

async function init(request: Extract<VoiceEngineRequest, { type: "init" }>) {
  const start = performance.now();
  const { config } = request;
  try {
    const [loadedStt, loadedSpeech, loadedLlama] = await Promise.all([
      loadSpeechToText(config.speechToText),
      startSpeech(config.speech),
      config.cleanup
        ? startLlamaServer({
            binary: config.cleanup.llamaServer,
            model: config.cleanup.model,
            draftModel: config.cleanup.draftModel,
            gpuLayers: config.cleanup.gpuLayers,
          }).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    stt = loadedStt;
    speech = loadedSpeech;
    llama = loadedLlama;
    // Warm the cleanup prompt cache so the first dictation is as fast as the rest.
    if (llama)
      await cleanupDictation(
        "Warm up the cleanup model for the first dictation please.",
        llama.url,
      );
    send({
      type: "ready",
      sampleRate: speech.sampleRate,
      cleanup: llama?.mode ?? "off",
      loadMs: performance.now() - start,
    });
  } catch (error) {
    send({ type: "failed", message: (error as Error).message });
  }
}

async function dictate(request: Extract<VoiceEngineRequest, { type: "dictate" }>) {
  if (!stt) {
    send({ type: "error", id: request.id, message: "The voice engine is not ready." });
    return;
  }
  try {
    const start = performance.now();
    const raw = await stt.transcribe(request.samples, request.sampleRate);
    const speechToTextMs = performance.now() - start;
    const cleaned = request.cleanup
      ? await cleanupDictation(raw, llama?.url)
      : ({ text: raw, method: "off", ms: 0 } as const);
    send({
      type: "dictated",
      id: request.id,
      result: {
        raw,
        text: cleaned.text,
        cleanup: cleaned.method,
        speechToTextMs,
        cleanupMs: cleaned.ms,
      },
    });
  } catch (error) {
    send({ type: "error", id: request.id, message: (error as Error).message });
  }
}

function speak(request: Extract<VoiceEngineRequest, { type: "speak" }>) {
  if (!speech) {
    send({ type: "error", id: request.id, message: "The voice engine is not ready." });
    return;
  }
  const job = speech.speak(request.text, (pcm) => send({ type: "audio", id: request.id, pcm }));
  utterances.set(request.id, job.id);
  job.done
    .then(
      (result) =>
        send({ type: "spoken", id: request.id, ttfaMs: result.ttfaMs, stopped: result.stopped }),
      (error: Error) => send({ type: "error", id: request.id, message: error.message }),
    )
    .finally(() => utterances.delete(request.id));
}

process.on("message", (request: VoiceEngineRequest) => {
  switch (request.type) {
    case "init":
      void init(request);
      break;
    case "dictate":
      void dictate(request);
      break;
    case "speak":
      speak(request);
      break;
    case "stop": {
      const helperId = request.id === undefined ? undefined : utterances.get(request.id);
      if (request.id === undefined || helperId !== undefined) speech?.stop(helperId);
      break;
    }
  }
});

const shutdown = () => {
  speech?.close();
  llama?.stop();
  process.exit(0);
};
process.once("disconnect", shutdown);
process.once("SIGTERM", shutdown);
