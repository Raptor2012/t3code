// @effect-diagnostics globalTimers:off -- A plain Node child; the poll runs outside any Effect fiber.
// Windows: watches the dictation button (held) and the voice toggle chord, system-wide.
// GetAsyncKeyState reads mouse buttons too, so no input hook is installed and nothing is swallowed.
import { loadWindowsForegroundApi } from "../electron/WindowsForeground.ts";

const POLL_INTERVAL_MS = 10;
const VK_XBUTTON2 = 0x06; // Mouse Forward
const VK_CONTROL = 0x11;
const VK_MENU = 0x12; // Alt
const VK_M = 0x4d;

async function poll() {
  const api = await loadWindowsForegroundApi();
  let holding = false;
  let chord = false;
  process.send?.("ready");
  const timer = setInterval(() => {
    const hold = api.isKeyDown(VK_XBUTTON2);
    if (hold !== holding) {
      holding = hold;
      try {
        process.send?.(hold ? "hold-down" : "hold-up");
      } catch {}
    }
    const pressed = api.isKeyDown(VK_CONTROL) && api.isKeyDown(VK_MENU) && api.isKeyDown(VK_M);
    if (pressed && !chord) {
      try {
        process.send?.("toggle");
      } catch {}
    }
    chord = pressed;
  }, POLL_INTERVAL_MS);
  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.once("disconnect", shutdown);
  process.once("SIGTERM", shutdown);
}

void poll().catch(() => process.exit(1));
