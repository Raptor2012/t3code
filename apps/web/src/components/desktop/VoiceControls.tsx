import type { DesktopVoiceBridge, DesktopVoiceState } from "@t3tools/contracts";
import {
  AudioLinesIcon,
  MicIcon,
  MicOffIcon,
  Volume2Icon,
  VolumeXIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { ComposerControl } from "../chat/ComposerControl";
import { messageActionPillClassName } from "../chat/ComposerPrimaryActions";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The message box's voice buttons: dictate, talk to the agent, and control a conversation. */
export function VoiceControls() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.voice;
  return bridge ? <VoiceControlsWithBridge bridge={bridge} /> : null;
}

function VoiceControlsWithBridge({ bridge }: { bridge: DesktopVoiceBridge }) {
  const [state, setState] = useState<DesktopVoiceState | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop voice engine's state, outside React
  useEffect(() => bridge.onState(setState), [bridge]);
  if (state === null) return null;

  if (state.conversation) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <ControlButton
          label={state.outputMuted ? "Unmute the voice agent" : "Mute the voice agent"}
          icon={state.outputMuted ? VolumeXIcon : Volume2Icon}
          onClick={() => bridge.command("toggle-output")}
        />
        <ControlButton
          label={state.micMuted ? "Unmute your microphone" : "Mute your microphone"}
          icon={state.micMuted ? MicOffIcon : MicIcon}
          onClick={() => bridge.command("toggle-mic")}
        />
        <PrimaryButton
          label="End voice"
          icon={XIcon}
          onClick={() => bridge.command("end-conversation")}
        />
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-1">
      <ControlButton
        label={state.dictating ? "Stop dictating" : "Dictate"}
        icon={MicIcon}
        active={state.dictating}
        onClick={() => bridge.command("toggle-dictation")}
      />
      <PrimaryButton
        label="Talk to the voice agent"
        icon={AudioLinesIcon}
        onClick={() => bridge.command("start-conversation")}
      />
    </div>
  );
}

interface ButtonProps {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onClick: () => void;
}

function ControlButton({
  label,
  icon: Icon,
  active = false,
  onClick,
}: ButtonProps & { readonly active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            className={cn("shrink-0", active && "text-primary")}
            aria-label={label}
            aria-pressed={active}
            onClick={onClick}
          />
        }
      >
        <Icon className="size-4" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function PrimaryButton({ label, icon: Icon, onClick }: ButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(messageActionPillClassName, "size-8 sm:size-7")}
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        <Icon className="size-4" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
