import type {
  DesktopVoiceActivity,
  DesktopVoiceBridge,
  DesktopVoiceDelivery,
  DesktopVoiceThread,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useStableCallback } from "../../hooks/useStableCallback";
import { composeDictatedPrompt, dispatchVoiceDictation } from "../../lib/desktopVoice";
import {
  useAssistantMessageText,
  useThreadShell,
  useThreadVisibleTurnItems,
  useVisibleThreadShells,
} from "../../state/entities";

const MAX_THREADS = 40;

function voiceBridge(): DesktopVoiceBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.voice;
}

/** Desktop voice: tells the orb which threads exist and what the agent says, and takes dictations. */
export function VoiceCoordinator() {
  const bridge = voiceBridge();
  return bridge ? <VoiceCoordinatorWithBridge bridge={bridge} /> : null;
}

function VoiceCoordinatorWithBridge({ bridge }: { bridge: DesktopVoiceBridge }) {
  const { routeThreadRef } = useHandleNewThread();
  const shells = useVisibleThreadShells();
  const routeShell = useThreadShell(routeThreadRef);

  const threads = [...shells]
    .filter((shell) => shell.archivedAt === null)
    .sort((a, b) =>
      (b.latestUserMessageAt ?? b.updatedAt).localeCompare(a.latestUserMessageAt ?? a.updatedAt),
    )
    .slice(0, MAX_THREADS)
    .map((shell): DesktopVoiceThread => ({
      environmentId: shell.environmentId,
      threadId: shell.id,
      title: shell.title,
    }));
  const active: DesktopVoiceThread | null =
    routeThreadRef && routeShell
      ? {
          environmentId: routeThreadRef.environmentId,
          threadId: routeThreadRef.threadId,
          title: routeShell.title,
        }
      : null;
  const threadsKey = JSON.stringify([threads, active]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the thread list to the desktop voice orb, outside React
  useEffect(() => {
    const [nextThreads, nextActive] = JSON.parse(threadsKey) as [
      DesktopVoiceThread[],
      DesktopVoiceThread | null,
    ];
    bridge.reportThreads(nextThreads, nextActive);
  }, [bridge, threadsKey]);

  const activity: DesktopVoiceActivity = routeShell
    ? routeShell.hasPendingApprovals
      ? "approval"
      : routeShell.hasPendingUserInput
        ? "input"
        : routeShell.runtime?.activeRunId
          ? "thinking"
          : ""
    : "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the desktop voice orb whether the agent is working or waiting
  useEffect(() => {
    if (routeThreadRef) bridge.reportActivity(routeThreadRef, activity);
  }, [bridge, routeThreadRef, activity]);

  const deliver = useStableCallback((delivery: DesktopVoiceDelivery) => {
    try {
      const taken = dispatchVoiceDictation({
        environmentId: delivery.environmentId,
        threadId: delivery.threadId,
        text: delivery.text,
        submit: delivery.mode === "send",
        replaces: delivery.replaces,
      });
      if (taken.handled) {
        bridge.completeDelivery(
          delivery.id,
          taken.heldForDraft ? "Kept in the composer beside your unsent draft." : undefined,
        );
        return;
      }
      // The thread is not open: leave the dictation in its composer draft.
      const ref = {
        environmentId: delivery.environmentId,
        threadId: delivery.threadId,
      } as ScopedThreadRef;
      const store = useComposerDraftStore.getState();
      const current = store.getComposerDraft(ref)?.prompt ?? "";
      store.setPrompt(ref, composeDictatedPrompt(current, delivery.text, delivery.replaces));
      bridge.completeDelivery(
        delivery.id,
        delivery.mode === "send" ? "Saved to the thread's composer; open it to send." : undefined,
      );
    } catch (error) {
      bridge.completeDelivery(delivery.id, error instanceof Error ? error.message : String(error));
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to dictations from the desktop voice engine
  useEffect(() => bridge.onDelivery(deliver), [bridge, deliver]);

  return routeThreadRef ? (
    <ReplyReporter
      key={`${routeThreadRef.environmentId}/${routeThreadRef.threadId}`}
      bridge={bridge}
      threadRef={routeThreadRef}
    />
  ) : null;
}

/** Streams the open thread's latest agent reply to Maeve. */
function ReplyReporter({
  bridge,
  threadRef,
}: {
  bridge: DesktopVoiceBridge;
  threadRef: ScopedThreadRef;
}) {
  const items = useThreadVisibleTurnItems(threadRef);
  const latest = latestAssistantReply(items);
  // A reply already finished when the thread opened is history, never read aloud.
  const finishedAtOpen = useRef(latest && !latest.streaming ? latest.messageId : null);
  const liveText = useAssistantMessageText(latest?.streaming ? threadRef : null, latest?.id);
  const text = liveText ?? latest?.text ?? "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- streams reply text to the desktop voice engine, outside React
  useEffect(() => {
    if (!latest || !text || latest.messageId === finishedAtOpen.current) return;
    bridge.reportReply({
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      messageId: latest.messageId,
      text,
      final: !latest.streaming,
    });
  }, [bridge, threadRef, latest, text]);
  return null;
}

function latestAssistantReply(items: ReturnType<typeof useThreadVisibleTurnItems>) {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!.item;
    if (item.type === "user_message") return null;
    if (item.type === "assistant_message") return item;
  }
  return null;
}
