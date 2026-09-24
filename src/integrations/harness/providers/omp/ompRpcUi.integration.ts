import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import {
  OMP_OTHER_OPTION,
  parseExtensionUiRequest,
} from "../pi/piProtocol";

// Drives the installed omp binary over `--mode rpc-ui`, the way MonoCode's
// live sessions do. Run with `npm run test:integration`; skipped without omp.
const windows = process.platform === "win32";
const ompInstalled = !spawnSync("omp", ["--version"], { shell: windows }).error;
const TURN_MS = 120_000;

type Frame = Record<string, unknown>;

class Omp {
  private frames: Frame[] = [];
  private waiters = new Set<() => void>();
  private readonly child;

  constructor(mode: "rpc" | "rpc-ui", tools?: string) {
    const args = ["--mode", mode, "--no-session"];
    if (tools) args.push("--tools", tools);
    this.child = spawn("omp", args, {
      shell: windows,
      stdio: ["pipe", "pipe", "ignore"],
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.frames.push(JSON.parse(line) as Frame);
      } catch {
        return;
      }
      for (const wake of this.waiters) wake();
    });
  }

  send(command: Frame): void {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** Resolves with the first frame (seen or future) matching `match`. */
  next(match: (frame: Frame) => boolean, timeoutMs = TURN_MS): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const hit = this.frames.find(match);
        if (!hit) return;
        this.frames.splice(this.frames.indexOf(hit), 1);
        this.waiters.delete(check);
        clearTimeout(timer);
        resolve(hit);
      };
      // Real process I/O: a wall-clock bound is the only way to fail fast.
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error("omp frame not received in time"));
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  async state(): Promise<Frame> {
    this.send({ id: "state", type: "get_state" });
    const reply = await this.next((f) => f.id === "state", 60_000);
    return (reply.data ?? {}) as Frame;
  }

  kill(): void {
    this.child.kill();
  }
}

const running: Omp[] = [];
function start(mode: "rpc" | "rpc-ui", tools?: string): Omp {
  const omp = new Omp(mode, tools);
  running.push(omp);
  return omp;
}
afterEach(() => {
  for (const omp of running.splice(0)) omp.kill();
});

const toolNames = (state: Frame) =>
  Array.isArray(state.dumpTools)
    ? state.dumpTools.map((tool) => (tool as Frame).name)
    : [];
const isAsk = (method: string) => (f: Frame) =>
  f.type === "extension_ui_request" && f.method === method;
const ASK_PROMPT =
  "Use the ask tool exactly once: ask me 'Which database?' with options " +
  "Postgres (description: Relational) and MySQL. Then reply with only what I chose.";

// Turn tests need a model; omp reports none on a fresh install.
async function ompHasModel(): Promise<boolean> {
  if (!ompInstalled) return false;
  const probe = new Omp("rpc-ui");
  try {
    return Boolean((await probe.state()).model);
  } catch {
    return false;
  } finally {
    probe.kill();
  }
}
const hasModel = await ompHasModel();

describe.skipIf(!ompInstalled)("omp --mode rpc-ui (real binary)", () => {
  it("registers ask only in rpc-ui", async () => {
    const [ui, plain] = [start("rpc-ui"), start("rpc")];
    const [uiState, plainState] = await Promise.all([ui.state(), plain.state()]);
    expect(toolNames(uiState)).toContain("ask");
    expect(toolNames(plainState)).not.toContain("ask");
  }, 90_000);

  describe("with a configured model", () => {
    it.skipIf(!hasModel)(
      "sends ask's select and Other editor in the shapes MonoCode folds",
      async () => {
        const omp = start("rpc-ui", "ask");
        omp.send({ id: "turn", type: "prompt", message: ASK_PROMPT });
        const select = parseExtensionUiRequest(await omp.next(isAsk("select")));
        expect(select).toMatchObject({ method: "select" });
        if (select?.method !== "select") return;
        expect(select.options).toContain(OMP_OTHER_OPTION);
        expect(select.descriptions?.some(Boolean)).toBe(true);
        omp.send({
          type: "extension_ui_response",
          id: select.id,
          value: OMP_OTHER_OPTION,
        });
        const editor = parseExtensionUiRequest(await omp.next(isAsk("editor")));
        expect(editor).toMatchObject({ method: "editor", promptStyle: true });
        omp.send({
          type: "extension_ui_response",
          id: editor!.id,
          value: "SQLite",
        });
        const end = await omp.next((f) => f.type === "agent_end");
        expect(JSON.stringify(end.messages)).toContain("SQLite");
      },
      TURN_MS + 30_000,
    );

    it.skipIf(!hasModel)(
      "cancels a pending ask by targetId when the turn aborts",
      async () => {
        const omp = start("rpc-ui", "ask");
        omp.send({ id: "turn", type: "prompt", message: ASK_PROMPT });
        const select = await omp.next(isAsk("select"));
        omp.send({ id: "abort", type: "abort" });
        const cancel = await omp.next(isAsk("cancel"), 30_000);
        expect(cancel.targetId).toBe(select.id);
        expect(cancel.id).not.toBe(select.id);
      },
      TURN_MS + 30_000,
    );
  });
});
