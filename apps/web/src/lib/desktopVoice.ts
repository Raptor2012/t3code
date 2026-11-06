const VOICE_DICTATION_EVENT = "t3code:voice-dictation";

export interface VoiceDictationRequest {
  readonly environmentId: string;
  readonly threadId: string;
  readonly text: string;
  readonly submit: boolean;
  readonly replaces?: string | undefined;
  /** Set by the open thread's view when it takes the dictation. */
  handled: boolean;
  /** Set when a send was held because the composer had the user's own unsent text. */
  heldForDraft: boolean;
}

/** The user's own unsent text, leaving out an earlier dictation this one replaces. */
export function userDraftText(current: string, replaces: string | undefined): string {
  return (replaces && current.includes(replaces) ? current.replace(replaces, "") : current).trim();
}

/** The composer text after a dictation: it replaces its own unsent predecessor, else appends. */
export function composeDictatedPrompt(
  current: string,
  text: string,
  replaces: string | undefined,
): string {
  if (replaces && current.includes(replaces)) return current.replace(replaces, text);
  return current.trim() ? `${current.replace(/\s+$/, "")}\n\n${text}` : text;
}

/** Offers a dictation to the open thread's composer; `handled` is false when none took it. */
export function dispatchVoiceDictation(
  request: Omit<VoiceDictationRequest, "handled" | "heldForDraft">,
): VoiceDictationRequest {
  const detail: VoiceDictationRequest = { ...request, handled: false, heldForDraft: false };
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
