import type { DesktopVoiceBridge, DesktopVoiceState } from "@t3tools/contracts";
import { AudioLinesIcon, MicIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { ComposerControl } from "../chat/ComposerControl";
import { messageActionPillClassName } from "../chat/ComposerPrimaryActions";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function useVoiceState(bridge: DesktopVoiceBridge | undefined) {
  const [state, setState] = useState<DesktopVoiceState | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop voice engine's state, outside React
  useEffect(() => bridge?.onState(setState), [bridge]);
  return state;
}

const voiceBridge = () => (typeof window === "undefined" ? undefined : window.desktopBridge?.voice);

/** Keeps a band clear above the message box where the voice orb sits, so text ends above it. */
export function VoiceOrbSlot() {
  const state = useVoiceState(voiceBridge());
  if (state === null) return null;
  return (
    <div
      aria-hidden="true"
      data-voice-orb-slot="true"
      className={cn(
        "pointer-events-none bg-linear-to-t from-background from-85% to-transparent transition-all duration-200",
        state.orb ? "h-24" : "h-0",
      )}
    />
  );
}

/** The message box's voice buttons: click to dictate, or to dictate and hear the reply. */
export function VoiceControls() {
  const bridge = voiceBridge();
  const state = useVoiceState(bridge);
  if (!bridge || state === null) return null;

  const dictateLabel = state.dictating && !state.talking ? "Stop dictating" : "Dictate";
  const talkLabel = state.talking ? "Stop talking" : "Talk to the voice agent";
  return (
    <div className="flex shrink-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              className={cn("shrink-0", state.dictating && !state.talking && "text-primary")}
              aria-label={dictateLabel}
              aria-pressed={state.dictating && !state.talking}
              onClick={() => bridge.command("toggle-dictation")}
            />
          }
        >
          <MicIcon className="size-4" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="top">{dictateLabel}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(
                messageActionPillClassName,
                "size-8 sm:size-7",
                state.talking && "ring-2 ring-primary/40",
              )}
              aria-label={talkLabel}
              aria-pressed={state.talking}
              onClick={() => bridge.command("toggle-talk")}
            />
          }
        >
          <AudioLinesIcon className="size-4" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="top">{talkLabel}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
