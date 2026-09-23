import type { HarnessId } from "../../../../features/sessions/model/session";
import { resolveOmpBinary, resolvePiBinary } from "../../core/child";

/**
 * omp (oh-my-pi) is a fork of Pi and speaks the same `--mode rpc` NDJSON
 * protocol, so both harnesses run on one adapter core. A flavor carries the
 * handful of details that actually differ between the two CLIs.
 */
export type PiFlavor = {
  id: HarnessId;
  /** Name used in error messages and debug logs. */
  label: string;
  /** Resolve the CLI binary. Swappable so tests can avoid Tauri. */
  resolveBinary: () => Promise<{ path: string }>;
  /** Flag that resumes a stored session by id. */
  resumeFlag: string;
  /** Flags that strip tools, skills, and project context for one-shot jobs. */
  isolateFlags: readonly string[];
  /** `--mode` for the user-facing session; probes and text jobs stay on `rpc`. */
  liveMode: "rpc" | "rpc-ui";
  /** Read-only tools exposed while the shared composer is in Plan mode. */
  planTools: readonly string[];
  /** Child id for the shared catalog probe. */
  probeChildId: string;
  /** Child id for the shared one-shot text generator. */
  textChildId: string;
};

export const PI_FLAVOR: PiFlavor = {
  id: "pi",
  label: "Pi",
  resolveBinary: resolvePiBinary,
  resumeFlag: "--session",
  isolateFlags: ["--no-tools", "--no-skills", "--no-context-files"],
  liveMode: "rpc",
  planTools: ["read", "grep", "find", "ls"],
  probeChildId: "monocode-pi-probe",
  textChildId: "monocode-pi-text",
};

/**
 * omp renamed two of Pi's flags: sessions resume through `--resume` (Pi uses
 * `--session`), and project context is stripped with `--no-rules` (Pi uses
 * `--no-context-files`). Verified against omp 18.0.6 `--help`. Live sessions
 * run `--mode rpc-ui`, which registers the `ask` tool over extension UI frames.
 */
export const OMP_FLAVOR: PiFlavor = {
  id: "omp",
  label: "omp",
  resolveBinary: resolveOmpBinary,
  resumeFlag: "--resume",
  isolateFlags: ["--no-tools", "--no-skills", "--no-rules"],
  liveMode: "rpc-ui",
  planTools: ["read", "grep", "glob", "lsp", "ask"],
  probeChildId: "monocode-omp-probe",
  textChildId: "monocode-omp-text",
};
