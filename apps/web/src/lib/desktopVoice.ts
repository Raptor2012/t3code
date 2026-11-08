const VOICE_DICTATION_EVENT = "t3code:voice-dictation";

export interface VoiceDictationRequest {
  readonly environmentId: string;
  readonly threadId: string;
  readonly text: string;
  readonly replaces?: string | undefined;
  /** Set by the open thread's view when it takes the dictation. */
  handled: boolean;
}

/** The composer text after a dictation: it replaces its own unsent predecessor, else appends. */
export function composeDictatedPrompt(
  current: string,
  text: string,
  replaces: string | undefined,
): string {
  if (replaces && current.includes(replaces)) {
    return text ? current.replace(replaces, text) : current.replace(replaces, "").trim();
  }
  if (!text) return current;
  return current.trim() ? `${current.replace(/\s+$/, "")}\n\n${text}` : text;
}

/** Offers a dictation to the open thread's composer; `handled` is false when none took it. */
export function dispatchVoiceDictation(
  request: Omit<VoiceDictationRequest, "handled">,
): VoiceDictationRequest {
  const detail: VoiceDictationRequest = { ...request, handled: false };
  window.dispatchEvent(new CustomEvent(VOICE_DICTATION_EVENT, { detail }));
  return detail;
}

export function subscribeVoiceDictation(
  listener: (request: VoiceDictationRequest) => void,
): () => void {
  const wrapped = (event: Event) => listener((event as CustomEvent<VoiceDictationRequest>).detail);
  window.addEventListener(VOICE_DICTATION_EVENT, wrapped);
  return () => window.removeEventListener(VOICE_DICTATION_EVENT, wrapped);
}

export function focusedTextField(): HTMLElement | null {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement)) return null;
  if (element.isContentEditable) return element;
  const editable =
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && /^(text|search|url|email)$/.test(element.type));
  return editable && !element.readOnly && !element.disabled ? element : null;
}

/**
 * Decides which of a thread's replies are new enough to read aloud. A thread's history loads after
 * it opens, so the first reply seen, and anything last updated before the thread opened, is history.
 */
export class ReplyOpenGate {
  private readonly openedAtMs: number;
  private settled = false;
  private history: string | null = null;

  constructor(openedAtMs: number) {
    this.openedAtMs = openedAtMs;
  }

  allows(
    hasItems: boolean,
    reply: { readonly messageId: string; readonly updatedAtMs: number } | null,
  ): boolean {
    if (!hasItems) return false;
    if (!this.settled) {
      this.settled = true;
      this.history = reply?.messageId ?? null;
    }
    return (
      reply !== null && reply.messageId !== this.history && reply.updatedAtMs >= this.openedAtMs
    );
  }
}
