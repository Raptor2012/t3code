/**
 * The composer text after a dictation update: it replaces the same dictation's earlier words,
 * else adds to the end. Live words whose earlier words are gone were sent or edited, so they stop.
 */
export function composeDictatedPrompt(
  current: string,
  text: string,
  replaces: string | undefined,
  live = false,
): string {
  // The last match: an earlier dictation can hold the same words.
  const at = replaces ? current.lastIndexOf(replaces) : -1;
  if (replaces && at >= 0) {
    const next = current.slice(0, at) + text + current.slice(at + replaces.length);
    return text ? next : next.trim();
  }
  if (!text || (replaces && live)) return current;
  return current.trim() ? `${current.replace(/\s+$/, "")} ${text}` : text;
}
