import type {
  DesktopVoiceActivity,
  DesktopVoiceBridge,
  DesktopVoiceDelivery,
  DesktopVoiceThread,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  composeDictatedPrompt,
  dispatchVoiceDictation,
  focusedTextField,
  ReplyOpenGate,
} from "../../lib/desktopVoice";
import { newMessageId } from "../../lib/utils";
import {
  useAssistantMessageText,
  useThreadShell,
  useThreadVisibleTurnItems,
  useVisibleThreadShells,
} from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

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

  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });

  // Open composer if the thread is showing, otherwise that thread's saved draft.
  const writeComposer = (delivery: DesktopVoiceDelivery, text: string) => {
    const { environmentId, threadId, replaces } = delivery;
    if (dispatchVoiceDictation({ environmentId, threadId, text, replaces }).handled) return true;
    const ref = { environmentId, threadId } as ScopedThreadRef;
    const store = useComposerDraftStore.getState();
    store.setPrompt(
      ref,
      composeDictatedPrompt(store.getComposerDraft(ref)?.prompt ?? "", text, replaces),
    );
    return false;
  };

  const placeDictation = (delivery: DesktopVoiceDelivery) => {
    const field = focusedTextField();
    const inComposer = field?.closest("[data-chat-composer-form]") != null;
    if (field && !inComposer && document.execCommand("insertText", false, delivery.text)) return;
    writeComposer(delivery, delivery.text);
  };

  // Sends straight to the thread, like any agent message: it never depends on the thread being
  // open, on what the composer holds, or on the window being visible.
  const sendDictation = async (delivery: DesktopVoiceDelivery) => {
    const shell = shells.find(
      (candidate) =>
        candidate.environmentId === delivery.environmentId && candidate.id === delivery.threadId,
    );
    if (!shell) throw new Error("That thread is no longer available.");
    const result = await startTurn({
      environmentId: shell.environmentId,
      input: {
        threadId: shell.id,
        message: { messageId: newMessageId(), role: "user", text: delivery.text, attachments: [] },
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt: new Date().toISOString(),
      },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  };

  const deliver = useStableCallback(async (delivery: DesktopVoiceDelivery) => {
    try {
      if (delivery.mode === "send") await sendDictation(delivery);
      else placeDictation(delivery);
      bridge.completeDelivery(delivery.id, undefined);
      if (delivery.mode === "send" && delivery.replaces) writeComposer(delivery, "");
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
  const [gate] = useState(() => new ReplyOpenGate(Date.now()));
  const hasItems = items.length > 0;
  const liveText = useAssistantMessageText(latest?.streaming ? threadRef : null, latest?.id);
  const text = liveText ?? latest?.text ?? "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- streams reply text to the desktop voice engine, outside React
  useEffect(() => {
    const live = gate.allows(
      hasItems,
      latest
        ? { messageId: latest.messageId, updatedAtMs: DateTime.toEpochMillis(latest.updatedAt) }
        : null,
    );
    if (!latest || !text || !live) return;
    bridge.reportReply({
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      messageId: latest.messageId,
      text,
      final: !latest.streaming,
    });
  }, [bridge, threadRef, latest, text, gate, hasItems]);
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
