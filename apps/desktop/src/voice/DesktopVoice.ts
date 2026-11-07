// @effect-diagnostics nodeBuiltinImport:off -- Checks bundled voice resources on disk.

import * as NodeFS from "node:fs";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { VoiceController } from "./VoiceController.ts";
import { resolveVoiceEngineConfig } from "./voiceModels.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-voice");

/** Local voice: hold-to-dictate into T3 threads and Maeve reading replies aloud. */
export class DesktopVoice extends Context.Service<
  DesktopVoice,
  {
    readonly initialize: Effect.Effect<void>;
    readonly dispose: Effect.Effect<void>;
  }
>()("@t3tools/desktop/voice/DesktopVoice") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
  const runSync = Effect.runSyncWith(context);
  const runFork = Effect.runForkWith(context);
  const controllerRef = yield* Ref.make<VoiceController | undefined>(undefined);
  const path = environment.path;

  // Electron reports files inside app.asar as existing, but an executable there cannot be spawned.
  const resource = (name: string, { executable = false } = {}) =>
    environment
      .resolveResourcePathCandidates(name)
      .find(
        (candidate) =>
          !(executable && /\.asar([\\/]|$)/.test(candidate)) && NodeFS.existsSync(candidate),
      );

  const initialize = Effect.gen(function* () {
    if ((yield* Ref.get(controllerRef)) !== undefined) return;
    const voiceDirectory = path.join(environment.baseDir, "voice");
    const speechBinary = resource(
      path.join("voice", environment.platform === "win32" ? "t3-maeve-tts.exe" : "t3-maeve-tts"),
      { executable: true },
    );
    const orbPage = resource(path.join("voice", "orb.html"));
    if (!orbPage) {
      yield* logWarning("voice orb page not found; voice is off");
      return;
    }
    const models = resolveVoiceEngineConfig({
      voiceDirectory,
      platform: environment.platform,
      speechBinary,
    });
    // Voice is opt-in: without its models there is no orb, hotkey or engine at all.
    if (!models.ok) {
      yield* logInfo("voice is off: models not installed", { missing: models.missing.join(", ") });
      return;
    }
    const controller = new VoiceController({
      platform: environment.platform,
      voiceDirectory,
      workerDirectory: environment.dirname,
      orbPage,
      engineConfig: models.config,
      missingModels: [],
      mainWindow: () => Option.getOrUndefined(runSync(electronWindow.main)),
      createWindow: (options) =>
        runSync(Effect.orDie(electronWindow.create(options, { auxiliary: true }))),
      log: (message, detail) => {
        // Log events outside a span never reach desktop.trace.ndjson.
        runFork(logInfo(message, detail ?? {}).pipe(Effect.withSpan("desktop.voice.event")));
      },
    });
    controller.start();
    yield* Ref.set(controllerRef, controller);
  }).pipe(Effect.withSpan("desktop.voice.initialize"));

  const dispose = Effect.gen(function* () {
    const controller = yield* Ref.get(controllerRef);
    controller?.dispose();
    yield* Ref.set(controllerRef, undefined);
  });

  return DesktopVoice.of({ initialize, dispose });
});

export const layer = Layer.effect(DesktopVoice, make);
