// @effect-diagnostics globalTimers:off -- Child-process shutdown watchdogs run outside any Effect fiber.
// @effect-diagnostics nodeBuiltinImport:off -- Owns the per-platform global hotkey helper processes.

import * as NodeChildProcess from "node:child_process";

export type VoiceHotkeyEvent = "hold-down" | "hold-up" | "toggle";

// macOS: CoreGraphics reports button and key state without an event tap, so this needs no
// Input Monitoring permission. Button 4 is Mouse Forward; key 46 is M.
const MAC_POLLER_SCRIPT = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function run() {
  const CONTROL = 0x40000, OPTION = 0x80000;
  let holding = false, chord = false;
  console.log("ready");
  while ($.getppid() !== 1) {
    const hold = $.CGEventSourceButtonState(0, 4);
    if (hold !== holding) { holding = hold; console.log(hold ? "hold-down" : "hold-up"); }
    const flags = $.CGEventSourceFlagsState(0);
    const pressed = (flags & CONTROL) !== 0 && (flags & OPTION) !== 0 && $.CGEventSourceKeyState(0, 46);
    if (pressed && !chord) console.log("toggle");
    chord = pressed;
    delay(0.01);
  }
  return "orphaned";
}`;

const isEvent = (value: string): value is VoiceHotkeyEvent =>
  value === "hold-down" || value === "hold-up" || value === "toggle";

/**
 * Starts the global voice hotkeys and resolves with a stop function once they are live. Linux
 * has no portable way to read a mouse button system-wide, so it resolves undefined there.
 */
export function startVoiceHotkeys(
  platform: NodeJS.Platform,
  windowsWorkerPath: string,
  onEvent: (event: VoiceHotkeyEvent) => void,
  onFailure: (error: Error) => void,
): Promise<(() => void) | undefined> {
  if (platform === "win32") {
    const worker = NodeChildProcess.fork(windowsWorkerPath, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      execArgv: [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    return supervise(
      worker,
      (listener) => worker.on("message", (m) => listener(String(m))),
      onEvent,
      onFailure,
    );
  }
  if (platform === "darwin") {
    const poller = NodeChildProcess.spawn(
      "osascript",
      ["-l", "JavaScript", "-e", MAC_POLLER_SCRIPT],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let buffered = "";
    return supervise(
      poller,
      (listener) =>
        poller.stdout.on("data", (chunk: Buffer) => {
          buffered += chunk.toString();
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) listener(line.trim());
        }),
      onEvent,
      onFailure,
    );
  }
  return Promise.resolve(undefined);
}

function supervise(
  child: NodeChildProcess.ChildProcess,
  listen: (listener: (message: string) => void) => void,
  onEvent: (event: VoiceHotkeyEvent) => void,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill();
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref?.();
      child.once("exit", () => clearTimeout(forceKill));
    };
    const fail = (error: Error) => {
      if (stopped) return;
      stop();
      if (settled) onFailure(error);
      else {
        settled = true;
        reject(error);
      }
    };
    listen((message) => {
      if (message === "ready" && !settled) {
        settled = true;
        resolve(stop);
      } else if (settled && !stopped && isEvent(message)) {
        onEvent(message);
      }
    });
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`Voice hotkey helper exited with code ${code}`)));
  });
}
