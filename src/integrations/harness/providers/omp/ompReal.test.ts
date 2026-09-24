// Real-binary integration test: drives the actual omp adapter against the
// installed `omp` over `--mode rpc-ui`. Skipped unless OMP_REAL=1 and the
// binary runs; needs a configured model. CI and other machines are unaffected.
import { spawnSync, type ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { HarnessEvent, SendTurnInput } from "../../core/types";

const BIN = process.env.OMP_BIN ?? "omp";
const REAL =
  process.env.OMP_REAL === "1" && !spawnSync(BIN, ["--version"]).error;

const live = vi.hoisted(() => ({
  children: new Map<string, ChildProcess>(),
  listeners: new Map<string, (line: string) => void>(),
  exits: new Map<string, (code: number | null) => void>(),
  spawnArgs: [] as string[][],
}));

vi.mock("../../core/child", async () => {
  // vi.mock factories are hoisted above top-level imports; load them lazily.
  const { spawn } = await import("node:child_process");
  const readline = await import("node:readline");
  return {
    resolveOmpBinary: async () => ({ path: BIN }),
    resolvePiBinary: async () => ({ path: "pi" }),
    acquireHarnessBridge: async () => () => undefined,
    spawnChild: async (
      id: string,
      command: string,
      args: string[],
      cwd: string,
    ) => {
      const child = spawn(command, args, { cwd });
      live.children.set(id, child);
      live.spawnArgs.push(args);
      readline
        .createInterface({ input: child.stdout })
        .on("line", (line) => live.listeners.get(id)?.(line));
      child.on("exit", (code) => live.exits.get(id)?.(code));
    },
    killChild: async (id: string) => {
      live.children.get(id)?.kill("SIGKILL");
      live.children.delete(id);
    },
    writeChild: async (id: string, line: string) => {
      const child = live.children.get(id);
      if (!child) throw new Error(`no child for ${id}`);
      await new Promise<void>((resolve, reject) =>
        child.stdin.write(line + "\n", (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    },
    watchChild: (
      id: string,
      onLine: (line: string) => void,
      onExit?: (code: number | null) => void,
    ) => {
      live.listeners.set(id, onLine);
      if (onExit) live.exits.set(id, onExit);
    },
    unwatchChild: (id: string) => {
      live.listeners.delete(id);
      live.exits.delete(id);
    },
  };
});

import { cancelOmpTurn, forgetOmpSession, sendOmpTurn } from "./omp";
import { respondQuestion } from "../pi/piFamily";
import { OMP_FLAVOR } from "../pi/piFlavor";

// vi.waitFor retries until the callback stops throwing — a falsy return
// counts as success, so wrap predicates in an assertion.
const waitFor = (predicate: () => boolean, ms = 120_000) =>
  vi.waitFor(() => expect(predicate()).toBe(true), {
    timeout: ms,
    interval: 200,
  });

const ASK_PROMPT =
  "Use the ask tool exactly once: ask me 'Which database?' with options " +
  "Postgres (description: Relational) and MySQL. " +
  "Then reply with only what I chose.";

describe.skipIf(!REAL)("omp real rpc-ui endpoint", () => {
  const turn = (sessionId: string, events: HarnessEvent[]): Promise<void> => {
    const input: SendTurnInput = {
      sessionId,
      cwd: process.cwd(),
      model: "omp:default",
      text: ASK_PROMPT,
      runtimeMode: "supervised",
      onEvent: (event) => events.push(event),
    };
    return sendOmpTurn(input);
  };
  const asked = (events: HarnessEvent[]) =>
    events.find(
      (e): e is Extract<HarnessEvent, { type: "question.asked" }> =>
        e.type === "question.asked",
    );

  it(
    "folds ask's Other editor into one question and delivers the typed answer",
    async () => {
      const events: HarnessEvent[] = [];
      const pending = turn("real-ask", events);
      await waitFor(() => asked(events) !== undefined);
      expect(live.spawnArgs.at(-1)?.slice(0, 2)).toEqual(["--mode", "rpc-ui"]);
      const question = asked(events)!;
      const [first] = question.questions;
      expect(first?.allowCustom).toBe(true);
      expect(first?.options.some((option) => option.description)).toBe(true);
      respondQuestion(OMP_FLAVOR, "real-ask", question.requestId, {
        kind: "answered",
        answers: { [first!.id]: ["__custom__"] },
        custom: { [first!.id]: "SQLite" },
      });
      await pending;
      // omp's follow-up editor was answered for the user, not asked again.
      expect(events.filter((e) => e.type === "question.asked")).toHaveLength(1);
      const reply = events
        .map((e) => (e.type === "message.delta" ? e.text : ""))
        .join("");
      expect(reply).toContain("SQLite");
      await forgetOmpSession("real-ask");
    },
    240_000,
  );

  it(
    "closes the pending question when omp cancels it by targetId",
    async () => {
      const events: HarnessEvent[] = [];
      const pending = turn("real-cancel", events);
      await waitFor(() => asked(events) !== undefined);
      // Abort on omp's side so the close can only come from its cancel frame.
      live.children
        .get("real-cancel")!
        .stdin.write(JSON.stringify({ id: "abort", type: "abort" }) + "\n");
      await waitFor(
        () => events.some((e) => e.type === "question.resolved"),
        30_000,
      );
      await cancelOmpTurn("real-cancel");
      await pending;
      await forgetOmpSession("real-cancel");
    },
    240_000,
  );
});
