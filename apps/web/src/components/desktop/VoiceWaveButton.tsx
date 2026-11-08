import type { DesktopVoiceBridge, DesktopVoiceIconState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { ComposerControl } from "../chat/ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const BARS = [0.45, 0.85, 0.6, 0.35];

const LABELS: Record<DesktopVoiceIconState, string> = {
  off: "Maeve is off for this thread",
  ready: "Maeve is on for this thread",
  listening: "Listening",
  processing: "Transcribing",
  speaking: "Maeve is speaking",
};

/** Maeve in the message box: her state as waves, and a click for her settings. */
export function VoiceWaveButton() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.voice;
  return bridge ? <VoiceWaveButtonWithBridge bridge={bridge} /> : null;
}

function VoiceWaveButtonWithBridge({ bridge }: { bridge: DesktopVoiceBridge }) {
  const [state, setState] = useState<DesktopVoiceIconState | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the voice engine's state, outside React
  useEffect(() => bridge.onState(setState), [bridge]);
  if (state === null) return null;

  const active = state === "listening" || state === "processing" || state === "speaking";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            className="shrink-0"
            aria-label={`${LABELS[state]}. Open Maeve's settings`}
            onClick={(event) => {
              const { x, y, width } = event.currentTarget.getBoundingClientRect();
              bridge.openSettings({ x, y, width });
            }}
          />
        }
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex h-4 w-4 items-center justify-center gap-0.5",
            active ? "text-foreground" : "text-muted-foreground",
            state === "off" && "opacity-50",
          )}
        >
          {BARS.map((scale, index) => (
            <span
              key={scale}
              className={cn("h-3.5 w-0.5 rounded-full bg-current", active && "t3-voice-wave-bar")}
              style={{ transform: `scaleY(${scale})`, animationDelay: `${index * 120}ms` }}
            />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{LABELS[state]}</TooltipPopup>
    </Tooltip>
  );
}
