import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { classify, isHaTool } from "../ha/classify.js";

/**
 * The synchronous gate on tool calls. Pure, so every rule is unit tested.
 *
 * Two jobs:
 *  - keep the file tools inside the house directory (the agent's notes and
 *    scratch space) — and away from the volume's database, other processes'
 *    files under /proc, and anything else in the pod;
 *  - keep a scheduled run to looking. Nobody is there to approve a change, so
 *    a scheduled run is refused every Home Assistant call that is not a read,
 *    whatever the approval level says.
 *
 * Whether an interactive change goes ahead is not decided here. That waits for
 * a person (agent/options.ts `answerPrompt`, discord/approvals.ts), which a
 * synchronous hook cannot do.
 */

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export interface PolicyInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  /** Absolute path of the house directory — the agent's working directory. */
  readonly houseDir: string;
  /** False for a scheduled run. */
  readonly interactive: boolean;
  readonly controlDomains: readonly string[];
  readonly aborted?: boolean;
}

const ALLOW: Decision = { allow: true };
const deny = (reason: string): Decision => ({ allow: false, reason });

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
/** Never registered (see options.ts); refused here too in case that ever drifts. */
const SHELL_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "KillBash"]);

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function fieldString(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function confined(raw: string, houseDir: string): boolean {
  const target = resolve(houseDir, raw);
  return inside(houseDir, target) || inside(resolve(tmpdir()), target);
}

export function evaluate(i: PolicyInput): Decision {
  if (i.aborted) return deny("this run was stopped from Discord");

  if (SHELL_TOOLS.has(i.toolName)) return deny("there is no shell here — Home Assistant is reached through its tools");

  if (WRITE_TOOLS.has(i.toolName)) {
    const raw = fieldString(i.toolInput, "file_path") ?? fieldString(i.toolInput, "notebook_path");
    if (!raw) return deny(`${i.toolName} was called without a file path`);
    if (!confined(raw, i.houseDir)) return deny(`'${raw}' is outside the house notes — files stay inside ${i.houseDir}`);
    return ALLOW;
  }

  if (READ_TOOLS.has(i.toolName)) {
    // Glob and Grep default to the working directory when no path is given.
    const raw = fieldString(i.toolInput, "file_path") ?? fieldString(i.toolInput, "path");
    if (raw && !confined(raw, i.houseDir)) return deny(`'${raw}' is outside the house notes — only ${i.houseDir} is readable`);
    return ALLOW;
  }

  if (!i.interactive && isHaTool(i.toolName)) {
    const c = classify(i.toolName, i.toolInput, i.controlDomains);
    if (c.tier !== "read") {
      return deny(
        `a scheduled run only looks — ${c.reason}. Say in the brief what you would change, ` +
          "and the person can ask for it from the thread",
      );
    }
  }

  return ALLOW;
}

/** Exposed for tests: the directory separator makes path fixtures platform-shaped. */
export const PATH_SEP = sep;
