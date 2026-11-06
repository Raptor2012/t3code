// @effect-diagnostics globalTimers:off globalDate:off -- The orb's 30 Hz tick and timestamps run outside Effect, like the standalone orb's engine loop.
// @effect-diagnostics nodeBuiltinImport:off -- Reads and writes the voice preferences file.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  DesktopVoiceActivity,
  DesktopVoiceDelivery,
  DesktopVoiceReply,
  DesktopVoiceThread,
} from "@t3tools/contracts";
import * as Electron from "electron";

import * as IpcChannels from "../ipc/channels.ts";
import type { VoiceEngineConfig } from "./engine/protocol.ts";
import { ReplyReader } from "./replyText.ts";
import { startVoiceEngineProcess, type VoiceEngineProcess } from "./VoiceEngineProcess.ts";
import { startVoiceHotkeys, type VoiceHotkeyEvent } from "./VoiceHotkeys.ts";

// The page keeps a constant 340x480 surface; everything outside its visible parts passes clicks.
const SURFACE = { width: 340, height: 480 };
const LINGER_MS = 1200;
const FADE_MS = 500;
const MIN_DICTATION_SAMPLES = 16000 * 0.25;
const TICK_MS = 33;

type Delivery = "immediate" | "review" | "composer";
type DictState = "" | "dictating" | "processing" | "done" | "failed";

interface Prefs {
  thread?: string;
  followActive?: boolean;
  delivery?: Delivery;
  cleanup?: boolean;
  voiceFx?: boolean;
  micMuted?: boolean;
  maeveMuted?: boolean;
  dock?: boolean;
  micDevice?: string;
  speakerDevice?: string;
  anchor?: [number, number];
  voiceThreads?: Record<string, boolean>;
  startup?: boolean;
}

interface Review {
  id: number;
  text: string;
  title: string;
  sending: boolean;
  error: string;
  editVersion: number;
  target: DesktopVoiceThread;
}

interface Bubble {
  id: number;
  who: "you" | "maeve";
  text: string;
  new: number;
}

interface HitRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface VoiceControllerOptions {
  readonly platform: NodeJS.Platform;
  /** Holds prefs.json and, by default, the models. */
  readonly voiceDirectory: string;
  readonly workerDirectory: string;
  readonly orbPage: string;
  readonly engineConfig: VoiceEngineConfig | undefined;
  /** What is missing when `engineConfig` is undefined. */
  readonly missingModels: readonly string[];
  readonly mainWindow: () => Electron.BrowserWindow | undefined;
  readonly createWindow: (
    options: Electron.BrowserWindowConstructorOptions,
  ) => Electron.BrowserWindow;
  readonly log: (message: string, detail?: Record<string, unknown>) => void;
}

const threadKey = (thread: Pick<DesktopVoiceThread, "environmentId" | "threadId">) =>
  `${thread.environmentId}/${thread.threadId}`;

export class VoiceController {
  private readonly prefsPath: string;
  private prefs: Prefs;
  private window: Electron.BrowserWindow | undefined;
  private engine: VoiceEngineProcess | undefined;
  private stopHotkeys: (() => void) | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;

  private state = "loading";
  private detail = "";
  private threads: DesktopVoiceThread[] = [];
  private activeThread: DesktopVoiceThread | null = null;
  private target: DesktopVoiceThread | null = null;
  private agentActivity: DesktopVoiceActivity = "";

  private dictState: DictState = "";
  private dictUntil = 0;
  private dictError = "";
  private dictSession = 0;
  private dictPreviewText = "";
  private dictPreviewUntil = 0;
  private recording = false;
  private recordedWaiter: ((samples: Float32Array | undefined) => void) | undefined;
  /** The last dictation placed in a composer, which the next one replaces while unsent. */
  private composerDraft: { key: string; text: string } | undefined;

  private review: Review | null = null;
  private reviewSeq = 0;
  private deliveries = new Map<number, (error?: string) => void>();
  private deliverySeq = 0;

  private bubble: Bubble | null = null;
  private bubbleSeq = 0;
  private bubbleRun = "";
  private bubbleUntil = 0;
  private readonly reader = new ReplyReader();
  private speaking: { run: number; message: string; utterances: Set<number> } | undefined;
  private runIds = new Map<string, number>();
  private nextRun = 1;
  private playback: { run: number; total: number; final: boolean } | null = null;
  private visualEvents = { sent: 0, interrupt: 0 };
  private sentAt = 0;
  private errorAt = 0;

  private visible = false;
  private hideAt: number | undefined;
  private showUntil = 0;
  private pinUntil = 0;
  private expanded = false;
  private hovered = false;
  private panelExtra = false;
  private choosingDelivery = false;
  private hitRects: HitRect[] = [];
  private clickThrough: boolean | undefined;
  private dragGesture = 0;
  private dragOrigin: [number, number] | undefined;

  private readonly options: VoiceControllerOptions;

  constructor(options: VoiceControllerOptions) {
    this.options = options;
    this.prefsPath = NodePath.join(options.voiceDirectory, "prefs.json");
    this.prefs = this.readPrefs();
  }

  start(): void {
    this.createWindow();
    this.installIpc();
    this.startEngine();
    void startVoiceHotkeys(
      this.options.platform,
      NodePath.join(this.options.workerDirectory, "voice", "VoiceHotkeyWorker.cjs"),
      (event) => this.onHotkey(event),
      (error) => this.options.log("voice hotkeys stopped", { error: error.message }),
    ).then(
      (stop) => {
        this.stopHotkeys = stop;
      },
      (error: Error) => this.options.log("voice hotkeys unavailable", { error: error.message }),
    );
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.stopHotkeys?.();
    this.engine?.close();
    for (const channel of ["voice-orb:poll", "voice-orb:action"]) {
      Electron.ipcMain.removeHandler(channel);
    }
    this.window?.destroy();
  }

  private startEngine(): void {
    const config = this.options.engineConfig;
    if (!config) {
      this.setState("error", "");
      this.detail = `Voice is not set up yet (missing ${this.options.missingModels.join(", ")}).`;
      return;
    }
    this.engine = startVoiceEngineProcess(
      NodePath.join(this.options.workerDirectory, "voice", "VoiceEngineWorker.cjs"),
      config,
      (code) => {
        this.options.log("voice engine exited", { code });
        this.engine = undefined;
        this.setState("error");
        this.detail = "The voice engine stopped. Restart T3 Code to start it again.";
      },
    );
    this.engine.ready.then(
      (ready) => {
        this.options.log("voice engine ready", { ...ready });
        this.engine?.setFx(this.prefs.voiceFx !== false);
        this.setState(this.idleState());
        this.detail = "";
      },
      (error: Error) => {
        this.options.log("voice engine failed", { error: error.message });
        this.setState("error");
        this.detail = `Voice could not start: ${error.message}`;
      },
    );
  }

  private setState(state: string, _text = ""): void {
    this.state = state;
    if (state === "error") this.errorAt = Date.now();
  }

  private voiceOn(): boolean {
    const target = this.target;
    if (!target) return false;
    if (this.prefs.followActive !== false && this.activeThread === null) return false;
    return Boolean(this.prefs.voiceThreads?.[threadKey(target)]);
  }

  private idleState(): string {
    return this.voiceOn() ? "ready" : "off";
  }

  private onHotkey(event: VoiceHotkeyEvent): void {
    if (event === "toggle") {
      if (this.speaking || this.playback?.final === false) this.stopSpeech(true);
      else this.pinUntil = Date.now() + 4000;
      return;
    }
    if (event === "hold-down") void this.beginDictation();
    else this.endDictation();
  }

  private async beginDictation(): Promise<void> {
    if (this.recording || !this.engine || this.prefs.micMuted || this.review?.sending) return;
    this.stopSpeech(true);
    this.recording = true;
    this.dictSession++;
    this.dictState = "dictating";
    this.dictPreviewText = "";
    this.window?.webContents.send("voice-orb:record-start");
  }

  private endDictation(): void {
    if (!this.recording) return;
    this.recording = false;
    this.dictState = "processing";
    const session = this.dictSession;
    const recorded = new Promise<Float32Array | undefined>((resolve) => {
      this.recordedWaiter = resolve;
    });
    this.window?.webContents.send("voice-orb:record-stop");
    void recorded.then((samples) => this.finishDictation(session, samples));
  }

  private async finishDictation(session: number, samples: Float32Array | undefined) {
    if (session !== this.dictSession) return;
    if (!samples || samples.length < MIN_DICTATION_SAMPLES || !this.engine) {
      this.dictState = "";
      return;
    }
    try {
      const result = await this.engine.dictate(samples, 16000, this.prefs.cleanup !== false);
      if (session !== this.dictSession) return;
      this.options.log("voice dictation", {
        words: result.text.split(/\s+/).filter(Boolean).length,
        speechToTextMs: Math.round(result.speechToTextMs),
        cleanupMs: Math.round(result.cleanupMs),
        cleanup: result.cleanup,
      });
      if (!result.text) {
        this.dictState = "";
        return;
      }
      this.dictPreviewText = result.text;
      this.dictPreviewUntil = Date.now() + 4000;
      await this.deliverDictation(result.text);
    } catch (error) {
      this.failDictation((error as Error).message);
    }
  }

  private failDictation(message: string) {
    this.dictState = "failed";
    this.dictError = message;
    this.dictUntil = Date.now() + 4000;
  }

  private async deliverDictation(text: string) {
    const target = this.target;
    if (!target) {
      this.failDictation("Open a thread in T3 Code first.");
      return;
    }
    const delivery = this.prefs.delivery ?? "review";
    if (delivery === "review") {
      this.review = {
        id: ++this.reviewSeq,
        text,
        title: target.title,
        sending: false,
        error: "",
        editVersion: 0,
        target,
      };
      this.dictState = "";
      this.window?.setFocusable(true);
      return;
    }
    try {
      await this.deliver(target, text, delivery === "immediate" ? "send" : "composer");
      this.dictState = "done";
      this.dictUntil = Date.now() + 1200;
    } catch (error) {
      this.failDictation((error as Error).message);
    }
  }

  private deliver(target: DesktopVoiceThread, text: string, mode: "composer" | "send") {
    const main = this.options.mainWindow();
    if (!main || main.isDestroyed()) {
      return Promise.reject(new Error("T3 Code's window is closed."));
    }
    const key = threadKey(target);
    const replaces = this.composerDraft?.key === key ? this.composerDraft.text : undefined;
    const id = ++this.deliverySeq;
    const delivery: DesktopVoiceDelivery = {
      id,
      environmentId: target.environmentId,
      threadId: target.threadId,
      text,
      mode,
      ...(replaces ? { replaces } : {}),
    };
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.deliveries.delete(id);
        reject(new Error("T3 Code did not take the dictation."));
      }, 10_000);
      this.deliveries.set(id, (error) => {
        clearTimeout(timeout);
        if (error) reject(new Error(error));
        else {
          this.composerDraft = mode === "composer" ? { key, text } : undefined;
          if (mode === "send") {
            this.visualEvents.sent++;
            this.sentAt = Date.now();
            this.setState("waiting");
          }
          resolve();
        }
      });
      main.webContents.send(IpcChannels.VOICE_DELIVERY_CHANNEL, delivery);
    });
  }

  private confirmReview(id: number, text: string) {
    const review = this.review;
    if (!review || review.id !== id || review.sending || !text.trim()) return;
    review.text = text.trim();
    review.sending = true;
    review.error = "";
    this.deliver(review.target, review.text, "send").then(
      () => {
        if (this.review?.id === id) this.review = null;
        this.window?.setFocusable(false);
      },
      (error: Error) => {
        if (this.review?.id !== id) return;
        this.review.sending = false;
        this.review.error = error.message;
      },
    );
  }

  private cancelReview() {
    if (this.review?.sending) return;
    this.review = null;
    this.window?.setFocusable(false);
  }

  private onReply(reply: DesktopVoiceReply) {
    const target = this.target;
    if (!target || threadKey(target) !== threadKey(reply)) return;
    if (!this.voiceOn() || this.prefs.maeveMuted || !this.engine) return;
    const chunk = this.reader.next(reply.messageId, reply.text, reply.final);
    if (!chunk) return;
    this.speak(reply.messageId, chunk);
  }

  private speak(messageId: string, text: string) {
    const engine = this.engine;
    if (!engine) return;
    let run = this.runIds.get(messageId);
    if (run === undefined) {
      run = this.nextRun++;
      this.runIds.set(messageId, run);
    }
    if (!this.speaking || this.speaking.run !== run) {
      this.speaking = { run, message: messageId, utterances: new Set() };
      this.playback = { run, total: 0, final: false };
    } else if (this.playback) {
      this.playback.final = false;
    }
    this.showBubble(
      "maeve",
      text,
      messageId,
      Math.max(2500, (text.split(/\s+/).length / 2.8) * 1000),
    );
    this.setState("speaking");
    const speaking = this.speaking;
    const job = engine.speak(text, (pcm) => {
      if (this.speaking !== speaking) return;
      if (this.playback?.run === run) this.playback.total += pcm.length;
      this.window?.webContents.send("voice-orb:audio", { id: run, pcm });
    });
    speaking.utterances.add(job.id);
    void job.done
      .catch(() => undefined)
      .finally(() => {
        speaking.utterances.delete(job.id);
        if (this.speaking === speaking && speaking.utterances.size === 0) {
          if (this.playback?.run === run) this.playback.final = true;
          this.speaking = undefined;
          this.setState(this.idleState());
        }
      });
  }

  private stopSpeech(interrupt: boolean) {
    if (!this.speaking && !this.playback) return;
    this.engine?.stop();
    this.window?.webContents.send("voice-orb:flush");
    if (this.speaking) this.reader.silence(this.speaking.message);
    this.speaking = undefined;
    this.playback = null;
    if (interrupt) this.visualEvents.interrupt++;
    this.setState(this.idleState());
  }

  private showBubble(who: Bubble["who"], text: string, run: string, ms: number) {
    const now = Date.now();
    if (who === "maeve") this.dictPreviewUntil = 0;
    const same =
      who === "maeve" &&
      this.bubble?.who === "maeve" &&
      run === this.bubbleRun &&
      (now < this.bubbleUntil + LINGER_MS || this.speaking?.message === run);
    if (same && this.bubble) {
      const joined = `${this.bubble.text} ${text}`;
      const cut = Math.max(0, joined.length - 1200);
      this.bubble = {
        ...this.bubble,
        text: joined.slice(cut),
        new: Math.max(0, this.bubble.text.length + 1 - cut),
      };
      this.bubbleUntil = Math.max(this.bubbleUntil, now + ms);
    } else {
      this.bubble = { id: ++this.bubbleSeq, who, text: text.slice(-1200), new: 0 };
      this.bubbleUntil = now + ms;
    }
    this.bubbleRun = run;
  }

  private replyPlaying(): boolean {
    return Boolean(this.speaking || (this.playback && !this.playback.final));
  }

  private onThreads(threads: DesktopVoiceThread[], active: DesktopVoiceThread | null) {
    this.threads = threads;
    this.activeThread = active;
    const pinned = this.prefs.thread
      ? threads.find((thread) => threadKey(thread) === this.prefs.thread)
      : undefined;
    const next = this.prefs.followActive !== false ? active : (pinned ?? this.target);
    // Never move a dictation, review or reply to another thread mid-flight.
    if (
      next &&
      (!this.target || threadKey(next) !== threadKey(this.target)) &&
      !this.review &&
      !this.dictState &&
      !this.speaking
    ) {
      this.target = next;
      this.reader.reset();
      this.agentActivity = "";
    } else if (next && this.target && threadKey(next) === threadKey(this.target)) {
      this.target = next;
    }
    if (this.state === "ready" || this.state === "off") this.setState(this.idleState());
  }

  private select(id: string) {
    const thread = this.threads.find((candidate) => threadKey(candidate) === id);
    if (!thread || this.review?.sending) return;
    this.cancelReview();
    this.stopSpeech(false);
    this.target = thread;
    this.reader.reset();
    this.setPrefs({ thread: id, followActive: false });
    this.setState(this.idleState());
  }

  private createWindow() {
    const window = this.options.createWindow({
      width: SURFACE.width,
      height: SURFACE.height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      fullscreenable: false,
      backgroundColor: "#00000000",
      title: "Maeve",
      webPreferences: {
        preload: NodePath.join(this.options.workerDirectory, "orb-preload.cjs"),
        contextIsolation: true,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    window.setAlwaysOnTop(true, "screen-saver");
    if (this.options.platform === "darwin") {
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    window.setIgnoreMouseEvents(true, { forward: true });
    this.clickThrough = true;
    window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === "media"),
    );
    void window.loadFile(this.options.orbPage);
    window.webContents.once("did-finish-load", () => {
      window.webContents.send("voice-orb:devices", {
        mic: this.prefs.micDevice ?? "",
        speaker: this.prefs.speakerDevice ?? "",
      });
    });
    this.window = window;
    this.place(this.prefs.anchor ?? this.defaultAnchor());
  }

  private defaultAnchor(): [number, number] {
    const area = Electron.screen.getPrimaryDisplay().workArea;
    return [area.x + area.width - 120, area.y + area.height - 8];
  }

  private anchor(): [number, number] {
    const bounds = this.window?.getBounds();
    if (!bounds) return this.defaultAnchor();
    return [bounds.x + bounds.width / 2, bounds.y + bounds.height];
  }

  private place([cx, bottom]: [number, number]) {
    const display = Electron.screen.getDisplayNearestPoint({
      x: Math.round(cx),
      y: Math.round(bottom) - 20,
    });
    const area = display.workArea;
    const x = Math.max(
      area.x - SURFACE.width / 2 + 90,
      Math.min(cx - SURFACE.width / 2, area.x + area.width - SURFACE.width / 2 - 90),
    );
    const y = Math.max(
      area.y,
      Math.min(bottom - SURFACE.height, area.y + area.height - SURFACE.height),
    );
    this.window?.setBounds({ x: Math.round(x), y: Math.round(y), ...SURFACE });
  }

  private wantsVisible(now: number): boolean {
    if (this.agentActivity === "approval" || this.agentActivity === "input") return true;
    if (
      this.review ||
      this.prefs.dock ||
      this.dictState ||
      this.expanded ||
      this.hovered ||
      now < this.pinUntil ||
      this.dictationBubble(now)
    ) {
      return true;
    }
    if (this.state === "speaking") return true;
    if (this.state === "waiting" && now < this.sentAt + 2500) return true;
    if (this.state === "error" && now < this.errorAt + 4000) return true;
    return this.replyBubbleVisible(now);
  }

  private tick() {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const now = Date.now();
    if ((this.dictState === "done" || this.dictState === "failed") && now >= this.dictUntil) {
      this.dictState = "";
    }
    if (this.state === "waiting" && now > this.sentAt + 2500 && this.agentActivity === "") {
      this.setState(this.idleState());
    }
    if (this.wantsVisible(now)) {
      this.showUntil = now + LINGER_MS;
      this.hideAt = undefined;
      if (!this.visible) {
        this.visible = true;
        if (!window.isVisible()) window.showInactive();
      }
    } else if (this.visible && now >= this.showUntil) {
      this.visible = false;
      this.hideAt = now + FADE_MS;
    }
    if (this.hideAt !== undefined && now >= this.hideAt) {
      this.hideAt = undefined;
      window.hide();
    }
    this.updateClickThrough();
  }

  private updateClickThrough() {
    const window = this.window;
    if (!window || !window.isVisible()) return;
    const cursor = Electron.screen.getCursorScreenPoint();
    const bounds = window.getBounds();
    const x = cursor.x - bounds.x;
    const y = cursor.y - bounds.y;
    const inside = this.hitRects.some(
      (rect) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom,
    );
    const through = !inside;
    if (through === this.clickThrough) return;
    window.setIgnoreMouseEvents(through, { forward: true });
    this.clickThrough = through;
  }

  private setHitRegions(regions: unknown) {
    const rects: HitRect[] = [];
    for (const item of Array.isArray(regions) ? regions.slice(0, 16) : []) {
      if (typeof item !== "object" || item === null) continue;
      const { id, x, y, width, height } = item as Record<string, unknown>;
      if (!["orbwrap", "bar", "card", "bubble", "review"].includes(String(id))) continue;
      if (
        ![x, y, width, height].every((value) => typeof value === "number" && Number.isFinite(value))
      )
        continue;
      if ((width as number) <= 0 || (height as number) <= 0) continue;
      const pad = id === "card" || id === "bubble" || id === "review" ? 40 : id === "bar" ? 24 : 0;
      rects.push({
        left: Math.max(0, (x as number) - pad),
        top: Math.max(0, (y as number) - pad),
        right: Math.min(SURFACE.width, (x as number) + (width as number) + pad),
        bottom: Math.min(SURFACE.height, (y as number) + (height as number) + pad),
      });
    }
    this.hitRects = rects;
  }

  private dragWindow(gesture: number, dx: number, dy: number) {
    if (gesture < this.dragGesture) return;
    if (gesture !== this.dragGesture) {
      this.dragGesture = gesture;
      this.dragOrigin = this.anchor();
    }
    if (!this.dragOrigin) return;
    this.pinUntil = Date.now() + LINGER_MS;
    const anchor: [number, number] = [this.dragOrigin[0] + dx, this.dragOrigin[1] + dy];
    this.place(anchor);
    this.setPrefs({ anchor: this.anchor() });
  }

  private dictationBubble(now: number) {
    if (this.expanded || this.review) return null;
    const live = this.dictState === "dictating";
    const processing = this.dictState === "processing";
    if (live || processing || (this.dictPreviewText && now < this.dictPreviewUntil)) {
      return {
        id: `dict-${this.dictSession}`,
        who: "you",
        live,
        processing,
        text: this.dictPreviewText || (live ? "Listening…" : "Transcribing…"),
      };
    }
    return null;
  }

  private replyBubbleVisible(now: number): boolean {
    return Boolean(
      !this.expanded &&
      !this.review &&
      this.bubble &&
      (now < this.bubbleUntil || this.replyPlaying()),
    );
  }

  private snapshot(): Record<string, unknown> {
    const now = Date.now();
    const following = this.prefs.followActive !== false;
    let hint = this.detail || "Hold Mouse Forward to dictate. Ctrl+Alt+M stops Maeve.";
    hint = following
      ? `${this.detail ? `${this.detail} · ` : ""}${this.activeThread ? "Following open T3 thread" : "Open a thread in T3 to speak to it"}`
      : `Pinned thread · ${hint}`;
    const dictating = this.dictState !== "";
    return {
      agent: this.agentActivity ? { activity: this.agentActivity } : {},
      visualEvents: { ...this.visualEvents },
      highContrast: false,
      reducedMotion: false,
      playback: this.playback ? { ...this.playback } : null,
      state: dictating ? this.dictState : this.state,
      text: this.dictState === "failed" ? this.dictError : "",
      speaking: Boolean(this.speaking) && !this.prefs.maeveMuted,
      voiceOn: this.voiceOn(),
      mode: "openwhispr",
      thread: this.target ? threadKey(this.target) : "",
      threadTitle: this.target?.title ?? "",
      threads: this.threads.slice(0, 40).map((thread) => ({
        id: threadKey(thread),
        title: thread.title.slice(0, 60),
      })),
      detail: hint,
      cleanup: this.prefs.cleanup !== false,
      startup: this.prefs.startup !== false,
      openwhispr: true,
      visible: this.visible,
      micMuted: Boolean(this.prefs.micMuted),
      maeveMuted: Boolean(this.prefs.maeveMuted),
      dock: Boolean(this.prefs.dock),
      hidePill: true,
      dictKey: "Mouse Forward",
      dictActivation: "push",
      followActive: following,
      expanded: this.expanded,
      hovered: this.hovered,
      settingsCloseRequest: 0,
      viewportTarget: [SURFACE.width, SURFACE.height],
      voiceFx: this.prefs.voiceFx !== false,
      delivery: this.prefs.delivery ?? "review",
      review: this.review
        ? {
            id: this.review.id,
            text: this.review.text,
            title: this.review.title,
            sending: this.review.sending,
            error: this.review.error,
            editVersion: this.review.editVersion,
          }
        : null,
      bubble: this.dictationBubble(now) ?? (this.replyBubbleVisible(now) ? this.bubble : null),
    };
  }

  private installIpc() {
    const fromOrb = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) =>
      this.window !== undefined && event.sender.id === this.window.webContents.id;
    const fromMain = (event: Electron.IpcMainEvent) =>
      event.sender.id === this.options.mainWindow()?.webContents.id;

    Electron.ipcMain.handle(
      "voice-orb:poll",
      (event, choosingDelivery: unknown, regions: unknown) => {
        if (!fromOrb(event)) return {};
        this.choosingDelivery = Boolean(choosingDelivery);
        if (regions !== undefined && regions !== null) this.setHitRegions(regions);
        return this.snapshot();
      },
    );
    Electron.ipcMain.handle("voice-orb:action", (event, name: unknown, args: unknown) => {
      if (!fromOrb(event)) return undefined;
      return this.action(String(name), Array.isArray(args) ? args : []);
    });
    Electron.ipcMain.on(
      "voice-orb:recorded",
      (event, message: { samples?: Float32Array; error?: string }) => {
        if (!fromOrb(event)) return;
        if (message.error) this.failDictation(`Microphone: ${message.error}`);
        this.recordedWaiter?.(message.samples);
        this.recordedWaiter = undefined;
      },
    );
    Electron.ipcMain.on(
      IpcChannels.VOICE_THREADS_CHANNEL,
      (event, threads: DesktopVoiceThread[], active: DesktopVoiceThread | null) => {
        if (fromMain(event) && Array.isArray(threads)) this.onThreads(threads, active);
      },
    );
    Electron.ipcMain.on(IpcChannels.VOICE_REPLY_CHANNEL, (event, reply: DesktopVoiceReply) => {
      if (fromMain(event)) this.onReply(reply);
    });
    Electron.ipcMain.on(
      IpcChannels.VOICE_ACTIVITY_CHANNEL,
      (event, thread: DesktopVoiceThread, activity: DesktopVoiceActivity) => {
        if (!fromMain(event) || !this.target || threadKey(thread) !== threadKey(this.target))
          return;
        this.agentActivity = activity;
        if (activity === "thinking" && this.state !== "speaking") this.setState("waiting");
      },
    );
    Electron.ipcMain.on(
      IpcChannels.VOICE_DELIVERY_DONE_CHANNEL,
      (event, id: number, error?: string) => {
        if (!fromMain(event)) return;
        this.deliveries.get(id)?.(error);
        this.deliveries.delete(id);
      },
    );
  }

  private action(name: string, args: unknown[]): unknown {
    switch (name) {
      case "select":
        this.select(String(args[0] ?? ""));
        return undefined;
      case "toggle_voice": {
        if (!this.target) return undefined;
        const key = threadKey(this.target);
        const voiceThreads = { ...this.prefs.voiceThreads, [key]: !this.prefs.voiceThreads?.[key] };
        this.setPrefs({ voiceThreads });
        if (!voiceThreads[key]) this.stopSpeech(false);
        this.setState(this.idleState());
        return undefined;
      }
      case "toggle_follow_active":
        this.setPrefs({ followActive: this.prefs.followActive === false });
        if (this.prefs.followActive !== false && this.activeThread)
          this.onThreads(this.threads, this.activeThread);
        return undefined;
      case "set_delivery":
        if (["immediate", "review", "composer"].includes(String(args[0]))) {
          this.setPrefs({ delivery: args[0] as Delivery });
        }
        return undefined;
      case "update_review_text": {
        const [id, text, revision] = args as [number, string, number];
        if (
          this.review &&
          this.review.id === id &&
          !this.review.sending &&
          revision > this.review.editVersion
        ) {
          this.review.text = String(text);
          this.review.editVersion = revision;
        }
        return undefined;
      }
      case "confirm_review":
        this.confirmReview(Number(args[0]), String(args[1] ?? ""));
        return undefined;
      case "cancel_review":
        this.cancelReview();
        return undefined;
      case "toggle_cleanup":
        this.setPrefs({ cleanup: this.prefs.cleanup === false });
        return undefined;
      case "toggle_voice_fx":
        this.setPrefs({ voiceFx: this.prefs.voiceFx === false });
        this.engine?.setFx(this.prefs.voiceFx !== false);
        return undefined;
      case "toggle_mic_mute":
        this.setPrefs({ micMuted: !this.prefs.micMuted });
        return undefined;
      case "toggle_maeve_mute":
        this.setPrefs({ maeveMuted: !this.prefs.maeveMuted });
        if (this.prefs.maeveMuted) this.stopSpeech(false);
        return undefined;
      case "toggle_dock":
        this.setPrefs({ dock: !this.prefs.dock });
        return undefined;
      case "toggle_startup":
        this.setPrefs({ startup: this.prefs.startup === false });
        return undefined;
      case "set_panel_extra":
        this.panelExtra = Boolean(args[0]);
        return undefined;
      case "set_hit_regions":
        this.setHitRegions(args[0]);
        return undefined;
      case "drag_window":
        this.dragWindow(Number(args[0]), Number(args[1]), Number(args[2]));
        return undefined;
      case "set_mic_device":
        this.setPrefs({ micDevice: String(args[0] ?? "") });
        return undefined;
      case "set_speaker_device":
        this.setPrefs({ speakerDevice: String(args[0] ?? "") });
        return undefined;
      case "stop":
        this.stopSpeech(true);
        return undefined;
      case "test_voice":
        this.speak(
          `voice-test-${Date.now()}`,
          "Hello. I am Maeve. Speak, and I will send it to this thread and read the reply.",
        );
        return undefined;
      case "quit":
        this.window?.hide();
        return undefined;
      default:
        return undefined;
    }
  }

  private readPrefs(): Prefs {
    try {
      return JSON.parse(NodeFS.readFileSync(this.prefsPath, "utf8")) as Prefs;
    } catch {
      return {};
    }
  }

  private setPrefs(patch: Partial<Prefs>) {
    this.prefs = { ...this.prefs, ...patch };
    try {
      NodeFS.mkdirSync(this.options.voiceDirectory, { recursive: true });
      const temporary = `${this.prefsPath}.tmp`;
      NodeFS.writeFileSync(temporary, JSON.stringify(this.prefs, null, 2));
      NodeFS.renameSync(temporary, this.prefsPath);
    } catch (error) {
      this.options.log("voice preferences not saved", { error: (error as Error).message });
    }
  }
}
