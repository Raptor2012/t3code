/**
 * Whether Maeve is on for a thread the orb has just followed you to. She keeps the state of the
 * thread you came from; at launch, that of the last thread, or on if any thread had her on.
 */
export function followedVoiceOn(
  voiceThreads: Readonly<Record<string, boolean>> | undefined,
  previousThread: string | undefined,
  lastThread: string | undefined,
): boolean {
  const from = previousThread ?? lastThread;
  if (from !== undefined) return Boolean(voiceThreads?.[from]);
  return Object.values(voiceThreads ?? {}).some(Boolean);
}
