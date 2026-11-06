// @effect-diagnostics globalFetch:off -- Runs in the plain Node voice engine process, outside Effect.

import { CLEANUP_PROMPT, maxTokens, wrapTranscript } from "./cleanupPrompt.ts";
import { fastCleanup, isFastCleanupEligible } from "./fastCleanup.ts";

export interface CleanupResult {
  readonly text: string;
  readonly method: "fast" | "model" | "raw";
  readonly ms: number;
}

// Long dictations take several seconds to clean up; never cut one off at a short fixed limit.
const timeoutMs = (text: string) => Math.min(30_000, 4_000 + text.length * 20);

// Falls back to the raw transcript on any failure: a dictation is never lost to cleanup.
export async function cleanupDictation(
  raw: string,
  serverUrl: string | undefined,
): Promise<CleanupResult> {
  const start = performance.now();
  const done = (text: string, method: CleanupResult["method"]) => ({
    text,
    method,
    ms: performance.now() - start,
  });
  const text = raw.trim();
  if (!text) return done("", "raw");
  if (isFastCleanupEligible(text)) return done(fastCleanup(text), "fast");
  if (!serverUrl) return done(text, "raw");
  try {
    const response = await fetch(`${serverUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs(text)),
      body: JSON.stringify({
        messages: [
          { role: "system", content: CLEANUP_PROMPT },
          { role: "user", content: wrapTranscript(text) },
        ],
        temperature: 0,
        max_tokens: maxTokens(text),
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!response.ok) return done(text, "raw");
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const cleaned = (body.choices?.[0]?.message?.content ?? "")
      .replace(/<\/?transcript>/g, "")
      .trim();
    return cleaned ? done(cleaned, "model") : done(text, "raw");
  } catch {
    return done(text, "raw");
  }
}
