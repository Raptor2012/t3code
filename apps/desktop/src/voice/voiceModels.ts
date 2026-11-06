// @effect-diagnostics nodeBuiltinImport:off -- Checks model files on disk before the engine starts.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { VoiceEngineConfig } from "./engine/protocol.ts";

/** `<voice dir>/models.json` overrides any of these; paths default to the starter-pack layout. */
export interface VoiceModelPaths {
  readonly speechToText: string;
  readonly cleanupModel?: string | undefined;
  readonly cleanupDraft?: string | undefined;
  readonly llamaServer?: string | undefined;
  readonly voiceModel: string;
  readonly voice: string;
}

const executable = (platform: NodeJS.Platform, name: string) =>
  platform === "win32" ? `${name}.exe` : name;

function defaultVoiceModelPaths(
  voiceDirectory: string,
  platform: NodeJS.Platform,
): VoiceModelPaths {
  const models = NodePath.join(voiceDirectory, "models");
  return {
    speechToText: NodePath.join(models, "parakeet-unified-en-0.6b"),
    cleanupModel: NodePath.join(models, "gemma-4-E4B_q4_0-it.gguf"),
    cleanupDraft: NodePath.join(models, "mtp-gemma-4-E4B-it.gguf"),
    llamaServer: NodePath.join(models, "llama", executable(platform, "llama-server")),
    voiceModel: NodePath.join(models, "phonon-31m-en-maeve"),
    voice: "Maeve",
  };
}

export type VoiceModelResolution =
  | { readonly ok: true; readonly config: VoiceEngineConfig }
  | { readonly ok: false; readonly missing: readonly string[] };

export function resolveVoiceEngineConfig(input: {
  readonly voiceDirectory: string;
  readonly platform: NodeJS.Platform;
  /** The bundled t3-maeve-tts helper. */
  readonly speechBinary: string | undefined;
}): VoiceModelResolution {
  let paths = defaultVoiceModelPaths(input.voiceDirectory, input.platform);
  try {
    const override = JSON.parse(
      NodeFS.readFileSync(NodePath.join(input.voiceDirectory, "models.json"), "utf8"),
    ) as Partial<VoiceModelPaths>;
    paths = { ...paths, ...override };
  } catch {}
  const exists = (path: string | undefined) => path !== undefined && NodeFS.existsSync(path);
  const missing = [
    ...(exists(NodePath.join(paths.speechToText, "encoder.int8.onnx")) ? [] : ["speech to text"]),
    ...(exists(NodePath.join(paths.voiceModel, "config.json")) ? [] : ["Maeve's voice"]),
    ...(exists(input.speechBinary) ? [] : ["the speech helper"]),
  ];
  if (missing.length > 0) return { ok: false, missing };
  const cleanup =
    exists(paths.cleanupModel) && exists(paths.llamaServer)
      ? {
          llamaServer: paths.llamaServer!,
          model: paths.cleanupModel!,
          draftModel: exists(paths.cleanupDraft) ? paths.cleanupDraft : undefined,
        }
      : undefined;
  return {
    ok: true,
    config: {
      speechToText: { modelDir: paths.speechToText, threads: 8 },
      cleanup,
      speech: {
        binary: input.speechBinary!,
        modelDir: paths.voiceModel,
        voice: paths.voice,
        threads: 4,
      },
    },
  };
}
