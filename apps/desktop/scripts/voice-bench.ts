// Runs the voice engine over a private dictation benchmark (manifest.jsonl, asr/refs.jsonl,
// cleanup/gold.jsonl) and writes asr/hyps/<name>.jsonl and cleanup/results/<name>*.jsonl for the
// bench's scorers. Flags: --bench --asr --llama --llm [--draft] --tts --voice-model --name.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { cleanupDictation } from "../src/voice/engine/cleanup.ts";
import { CLEANUP_PROMPT, maxTokens, wrapTranscript } from "../src/voice/engine/cleanupPrompt.ts";
import { startLlamaServer } from "../src/voice/engine/llamaServer.ts";
import { startSpeech } from "../src/voice/engine/speech.ts";
import { loadSpeechToText } from "../src/voice/engine/speechToText.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    bench: { type: "string" },
    asr: { type: "string" },
    llama: { type: "string" },
    llm: { type: "string" },
    draft: { type: "string" },
    tts: { type: "string" },
    "voice-model": { type: "string" },
    name: { type: "string", default: "t3-voice" },
    limit: { type: "string" },
  },
});
const bench = values.bench!;
const limit = values.limit ? Number(values.limit) : Infinity;
const readJsonl = <T>(file: string): T[] =>
  NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
const writeJsonl = (file: string, rows: unknown[]) =>
  NodeFS.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0;
const summary = (label: string, values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  console.log(
    `${label.padEnd(22)} n=${sorted.length} p50=${pct(sorted, 0.5).toFixed(0)}ms p90=${pct(sorted, 0.9).toFixed(0)}ms max=${(sorted.at(-1) ?? 0).toFixed(0)}ms`,
  );
};

function readWav(file: string): { samples: Float32Array; sampleRate: number } {
  const data = NodeFS.readFileSync(file);
  let offset = 12;
  let sampleRate = 16000;
  let bits = 16;
  let channels = 1;
  while (offset + 8 <= data.length) {
    const id = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = data.readUInt16LE(body + 2);
      sampleRate = data.readUInt32LE(body + 4);
      bits = data.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`${file}: expected 16-bit PCM`);
      const frames = size / 2 / channels;
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++)
        samples[i] = data.readInt16LE(body + i * 2 * channels) / 32768;
      return { samples, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

interface ManifestItem {
  id: number;
  wav: string;
}
interface GoldItem {
  id: number;
  raw: string;
}

const manifest = readJsonl<ManifestItem>(NodePath.join(bench, "manifest.jsonl"));
const refIds = new Set(
  readJsonl<{ id: number }>(NodePath.join(bench, "asr/refs.jsonl")).map((r) => r.id),
);
const gold = readJsonl<GoldItem>(NodePath.join(bench, "cleanup/gold.jsonl"));

let t = performance.now();
const stt = await loadSpeechToText({ modelDir: values.asr! });
console.log(`speech-to-text loaded in ${(performance.now() - t).toFixed(0)} ms`);
t = performance.now();
const llama = await startLlamaServer({
  binary: values.llama!,
  model: values.llm!,
  draftModel: values.draft,
});
console.log(`llama-server (${llama.mode}) ready in ${(performance.now() - t).toFixed(0)} ms`);
// Warm the prompt cache the way the app does before the first dictation.
await cleanupDictation("Warm up the cleanup model for the first dictation please.", llama.url);
t = performance.now();
const speech = await startSpeech({
  binary: values.tts!,
  modelDir: values["voice-model"]!,
  voice: "Maeve",
});
console.log(`Maeve ready in ${(performance.now() - t).toFixed(0)} ms`);

try {
  // 1. Speech to text, then the full cleanup path, per dictation that has a reference.
  const hyps: unknown[] = [];
  const asrMs: number[] = [];
  const releaseToText: number[] = [];
  const methods: Record<string, number> = {};
  for (const item of manifest.filter((m) => refIds.has(m.id)).slice(0, limit)) {
    const { samples, sampleRate } = readWav(NodePath.join(bench, item.wav.replace(/\\/g, "/")));
    const start = performance.now();
    const hyp = await stt.transcribe(samples, sampleRate);
    const asrDone = performance.now();
    const cleaned = await cleanupDictation(hyp, llama.url);
    asrMs.push(asrDone - start);
    releaseToText.push(performance.now() - start);
    methods[cleaned.method] = (methods[cleaned.method] ?? 0) + 1;
    hyps.push({ id: item.id, hyp });
  }
  writeJsonl(NodePath.join(bench, "asr/hyps", `${values.name}.jsonl`), hyps);

  // 2. Cleanup on the gold set's fixed inputs, so its score compares with earlier prompt runs.
  const pipeline: unknown[] = [];
  const modelOnly: unknown[] = [];
  const cleanupMs: number[] = [];
  for (const item of gold.slice(0, limit)) {
    const result = await cleanupDictation(item.raw, llama.url);
    cleanupMs.push(result.ms);
    pipeline.push({ id: item.id, out: result.text, ms: result.ms, method: result.method });
    const forced = await fetchModelOnly(item.raw, llama.url);
    modelOnly.push({ id: item.id, out: forced });
  }
  writeJsonl(NodePath.join(bench, "cleanup/results", `${values.name}.jsonl`), pipeline);
  writeJsonl(NodePath.join(bench, "cleanup/results", `${values.name}.model-only.jsonl`), modelOnly);

  // 3. Maeve: time to first audio for typical reply sentences.
  const firstAudio: number[] = [];
  for (const text of [
    "Done. I pushed the fix and the build is running.",
    "The Windows and Linux builds passed; the Mac job is still waiting for a runner.",
    "I found two places that read the old setting, and changed both.",
    "Tests pass. Want me to open the release?",
  ]) {
    const start = performance.now();
    let first = 0;
    await speech.speak(text, () => {
      first ||= performance.now() - start;
    }).done;
    firstAudio.push(first);
  }

  console.log(`\ncleanup methods on dictations: ${JSON.stringify(methods)}`);
  summary("speech to text", asrMs);
  summary("release to text", releaseToText);
  summary("cleanup (gold inputs)", cleanupMs);
  summary("Maeve first audio", firstAudio);
} finally {
  speech.close();
  llama.stop();
}

async function fetchModelOnly(raw: string, url: string): Promise<string> {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: CLEANUP_PROMPT },
        { role: "user", content: wrapTranscript(raw) },
      ],
      temperature: 0,
      max_tokens: maxTokens(raw),
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (body.choices?.[0]?.message?.content ?? "").trim();
}
