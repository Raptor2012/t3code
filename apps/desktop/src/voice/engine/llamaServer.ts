// @effect-diagnostics globalTimers:off -- Plain Node helper run inside the voice engine process.
// @effect-diagnostics globalFetch:off globalDate:off -- Health polling in the plain Node voice engine process.
// @effect-diagnostics nodeBuiltinImport:off -- Owns a llama-server child process and its port.

import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";

export interface LlamaServerOptions {
  readonly binary: string;
  readonly model: string;
  readonly draftModel?: string | undefined;
  readonly gpuLayers?: number | undefined;
  readonly threads?: number | undefined;
  readonly contextSize?: number | undefined;
  readonly startupTimeoutMs?: number | undefined;
}

export interface LlamaServer {
  readonly url: string;
  readonly mode: "gpu+mtp" | "gpu" | "cpu";
  readonly stop: () => void;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });

async function waitHealthy(
  url: string,
  child: NodeChildProcess.ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`llama-server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("llama-server did not become healthy in time");
}

async function startOnce(
  options: LlamaServerOptions,
  extraArgs: readonly string[],
): Promise<{ url: string; child: NodeChildProcess.ChildProcess }> {
  const port = await freePort();
  const args = [
    "--model",
    options.model,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--threads",
    String(options.threads ?? 4),
    "--ctx-size",
    String(options.contextSize ?? 4096),
    "--jinja",
    ...extraArgs,
  ];
  const child = NodeChildProcess.spawn(options.binary, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitHealthy(url, child, options.startupTimeoutMs ?? 120_000);
    return { url, child };
  } catch (error) {
    child.kill();
    throw new Error(
      `${(error as Error).message}\n${stderr.trim().split("\n").slice(-5).join("\n")}`,
      { cause: error },
    );
  }
}

// GPU with the MTP draft, then GPU alone (a live GPU beats speculation), then CPU.
export async function startLlamaServer(options: LlamaServerOptions): Promise<LlamaServer> {
  const gpu = ["--n-gpu-layers", String(options.gpuLayers ?? 99)];
  const draft = options.draftModel
    ? ["--model-draft", options.draftModel, "--spec-type", "draft-mtp", "--spec-draft-n-max", "3"]
    : [];
  const rungs: Array<{ mode: LlamaServer["mode"]; args: readonly string[] }> = [
    ...(draft.length > 0 ? [{ mode: "gpu+mtp" as const, args: [...gpu, ...draft] }] : []),
    { mode: "gpu", args: gpu },
    { mode: "cpu", args: [] },
  ];
  let lastError: unknown;
  for (const rung of rungs) {
    try {
      const { url, child } = await startOnce(options, rung.args);
      return { url, mode: rung.mode, stop: () => child.kill() };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
