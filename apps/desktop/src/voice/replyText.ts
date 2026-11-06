// What Maeve reads aloud from an agent reply: its prose, never code, links or markup.

const decodeEntities = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

export function cleanProse(text: string): string {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker) {
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence !== undefined || raw.startsWith("    ") || raw.startsWith("\t")) continue;
    if (/^\s*(?:[-*_]\s*){3,}$/.test(raw)) continue;
    let line = raw
      .replace(/!\[[^\]]*\]\([^\n]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^\n]*?\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/<[^>]+>/g, "");
    const heading = /^\s{0,3}#{1,6}\s+(.+)/.exec(line)?.[1];
    if (heading) line = `${heading.replace(/[#\s]+$/, "").replace(/[.!?]+$/, "")}.`;
    line = line
      .replace(/^\s*(?:[-+*]|\d+[.)]|>)\s+/, "")
      .replace(/(`+)(.*?)\1/g, "$2")
      .replaceAll("**", "")
      .replaceAll("__", "")
      .replaceAll("~~", "");
    lines.push(line);
  }
  return decodeEntities(lines.join(" ")).replace(/\s+/g, " ").trim();
}

/**
 * Turns a reply's growing text into speakable chunks: whole sentences while it streams, the rest
 * when it is final. Text already spoken is never repeated; a reply rewritten under what was
 * spoken goes quiet rather than replaying.
 */
export class ReplyReader {
  private readonly spoken = new Map<string, string>();
  private readonly silenced = new Set<string>();

  next(messageId: string, text: string, final: boolean): string {
    if (this.silenced.has(messageId)) return "";
    // A partial opening fence line must never become audible code.
    const source = final
      ? text
      : text.replace(/(?:^|\n) {0,3}(?:`{1,2}(?!`)|~{1,2}(?!~))[^\n]*$/, "");
    const prose = cleanProse(source);
    const prefix = this.spoken.get(messageId) ?? "";
    if (!prose.startsWith(prefix)) {
      this.silenced.add(messageId);
      return "";
    }
    const remaining = prose.slice(prefix.length).trimStart();
    let chunk = remaining;
    if (!final) {
      const boundaries = [...remaining.matchAll(/[.!?](?=\s)/g)];
      const last = boundaries.at(-1);
      if (last?.index !== undefined) chunk = remaining.slice(0, last.index + 1);
      else if (remaining.length > 140) {
        const cut = remaining.lastIndexOf(" ", 140);
        chunk = cut > 0 ? remaining.slice(0, cut) : "";
      } else chunk = "";
    }
    if (!chunk) return "";
    const end = prose.indexOf(chunk, prefix.length) + chunk.length;
    this.spoken.set(messageId, prose.slice(0, end));
    if (final) this.spoken.delete(messageId);
    return chunk;
  }

  silence(messageId: string): void {
    this.silenced.add(messageId);
  }

  reset(): void {
    this.spoken.clear();
    this.silenced.clear();
  }
}
