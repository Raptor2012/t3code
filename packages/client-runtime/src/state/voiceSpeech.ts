import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createVoiceSpeechEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    synthesize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:synthesize",
      tag: WS_METHODS.voiceSynthesize,
    }),
    dictationStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:dictation-start",
      tag: WS_METHODS.voiceDictationStart,
    }),
    dictationPush: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:dictation-push",
      tag: WS_METHODS.voiceDictationPush,
    }),
    dictationFinish: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:dictation-finish",
      tag: WS_METHODS.voiceDictationFinish,
    }),
    dictationCancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice:dictation-cancel",
      tag: WS_METHODS.voiceDictationCancel,
    }),
  };
}
