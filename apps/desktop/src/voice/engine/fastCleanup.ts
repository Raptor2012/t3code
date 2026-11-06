// Deterministic cleanup for short dictations (≤ 8 words): 92.5 against the model's 94.7 on 137
// hand-cleaned dictations, and 0.3–1.2 s faster. Anything needing judgement (a misheard word,
// a self-correction, spoken punctuation, numbers) goes to the model.

const FILLERS = /\b(?:uh+|um+|uhm|erm|er|ah)\b[,.]?\s*/gi;
const QUESTION_WORDS = new Set([
  "what",
  "why",
  "how",
  "who",
  "where",
  "when",
  "which",
  "can",
  "could",
  "would",
  "should",
  "is",
  "are",
  "do",
  "does",
  "did",
  "will",
  "shall",
  "have",
  "has",
  "was",
  "were",
  "am",
]);
const RISKY =
  /\b(?:org|odd|op|or|all|aud|jemma|jema|jima|jma|mave|maize|codecs|cloud|third|type|sub|agings|regions|open whisper|open risk|incline|headcline|help line|sponsor|boot calls|c3|tp|no wait|scratch that|i mean|actually no|period|comma|new line|like|one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand|percent)\b/i;
const NUMBER_WORDS = new Set([
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "zero",
  "oh",
]);
const FAST_CLEANUP_MAX_WORDS = 8;

export function isFastCleanupEligible(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > FAST_CLEANUP_MAX_WORDS) return false;
  if (/\d/.test(text)) return false;
  return !RISKY.test(text);
}

export function fastCleanup(text: string): string {
  let t = text.replace(FILLERS, "").trim();
  // Stutters ("the the" → "the"), never number words ("one one four" is 114).
  t = t.replace(/\b(\w+)((?:\s+\1\b)+)/gi, (match, word: string) =>
    NUMBER_WORDS.has(word.toLowerCase()) || /^\d+$/.test(word) ? match : word,
  );
  t = t.replace(/\s+([,.?!])/g, "$1").replace(/^[\s,]+|[\s,]+$/g, "");
  if (!t.replace(/[\W_]/g, "")) return "";
  t = t[0]!.toUpperCase() + t.slice(1);
  if (!/[.?!]$/.test(t)) {
    const first = (t.split(/\s+/)[0] ?? "").toLowerCase().replace(/,$/, "");
    t += QUESTION_WORDS.has(first) ? "?" : ".";
  }
  return t;
}
