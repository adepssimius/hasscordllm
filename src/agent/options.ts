import type { CanUseTool, McpServerConfig, Options } from "@anthropic-ai/claude-agent-sdk";
import { sanitizedEnv, type Config } from "../config.js";
import type { Logger } from "../logger.js";
import { classify, isHaTool, needsApproval } from "../ha/classify.js";
import type { ApprovalEvent, Approver } from "./approval.js";
import { createGate, type GateEvent } from "./gate.js";
import { evaluate } from "./policy.js";
import { HASS_SERVER } from "./prompts.js";

/**
 * Every `Options` object in this process comes from `buildOptions`.
 *
 *  - `cwd` is the house directory, shared by every thread. Its CLAUDE.md is
 *    the house notes, which Claude Code loads by itself.
 *  - The only tools are file tools confined to that directory (agent/policy.ts),
 *    web search, and the MCP servers passed here. No shell.
 *  - `env` is a short allowlist with no Discord or Home Assistant token in it.
 *  - `strictMcpConfig` means the only MCP servers are the ones passed here.
 *  - `canUseTool` is where a Home Assistant change waits for a person — see
 *    `answerPrompt` below.
 */

/** Session continuity. `resume` continues an SDK session; `sessionId` names a new one. */
export interface SessionIo {
  readonly resume?: string;
  readonly sessionId?: string;
}

export interface RunSpec extends SessionIo {
  readonly cfg: Config;
  readonly log: Logger;
  /** Appended to Claude Code's own system prompt. */
  readonly systemAppend: string;
  /** ha-mcp, keyed by name. Empty when Home Assistant is not configured. */
  readonly externalServers: Readonly<Record<string, McpServerConfig>>;
  /** The bot's in-process server, built for this turn with this turn's tools. */
  readonly hassServer: McpServerConfig;
  /** False for a scheduled run: no Home Assistant writes at all. */
  readonly interactive: boolean;
  /** Who to ask. Absent means nobody can be asked, and anything needing approval is refused. */
  readonly approver?: Approver | undefined;
  readonly isAborted?: () => boolean;
  readonly onDecision?: (e: GateEvent) => void;
  readonly onApproval?: (e: ApprovalEvent) => void;
}

/**
 * Subagents run outside the gate, WebFetch makes requests from inside the pod
 * network to wherever the model points it, there are no notebooks, and there
 * is no shell.
 */
export const BUILTIN_DENY = ["Task", "Agent", "WebFetch", "NotebookEdit", "Bash", "BashOutput", "KillShell"] as const;

type PromptSpec = Pick<RunSpec, "cfg" | "log" | "interactive" | "approver" | "isAborted" | "onApproval">;

/**
 * Answers Claude Code's permission prompts.
 *
 * With `allowedTools` empty, every call that is not a plain read of the
 * working directory lands here — which makes this the place a Home Assistant
 * change can wait for a person. A PreToolUse hook could not: hooks time out,
 * and an approval may sit for minutes while someone finds their phone.
 *
 * In order:
 *  1. the synchronous policy (files inside the house directory, scheduled
 *     runs only look) — a refusal there is final;
 *  2. a Home Assistant call is classified (ha/classify.ts) and, if its tier
 *     needs approval at HA_APPROVAL_LEVEL, waits for the approver;
 *  3. everything else is allowed.
 */
export function answerPrompt(spec: PromptSpec): CanUseTool {
  const { cfg, log } = spec;
  return async (toolName, input, opts) => {
    const decision = evaluate({
      toolName,
      toolInput: input,
      houseDir: cfg.houseDir,
      interactive: spec.interactive,
      controlDomains: cfg.HA_CONTROL_DOMAINS,
      ...(spec.isAborted ? { aborted: spec.isAborted() } : {}),
    });
    if (!decision.allow) {
      log.warn({ tool: toolName, reason: decision.reason }, "permission prompt refused");
      return { behavior: "deny", message: decision.reason, toolUseID: opts.toolUseID };
    }

    if (isHaTool(toolName)) {
      const c = classify(toolName, input, cfg.HA_CONTROL_DOMAINS);
      if (needsApproval(c.tier, cfg.HA_APPROVAL_LEVEL)) {
        const req = { toolName, input, tier: c.tier, reason: c.reason, toolUseId: opts.toolUseID };
        const answer = spec.approver
          ? await spec.approver(req, opts.signal)
          : { approved: false as const, by: null, reason: "there is nobody here to approve it" };
        spec.onApproval?.({ ...req, answer });
        log.info({ tool: toolName, tier: c.tier, approved: answer.approved, by: answer.by }, "approval answered");
        if (!answer.approved) {
          return {
            behavior: "deny",
            message:
              `Not done: ${answer.reason}. Nothing was changed. Tell the person what you were going to do, ` +
              "and do not try to get the same effect another way.",
            toolUseID: opts.toolUseID,
          };
        }
        return { behavior: "allow", updatedInput: input, toolUseID: opts.toolUseID };
      }
      log.debug({ tool: toolName, tier: c.tier }, "home assistant call needs no approval");
    }

    return { behavior: "allow", updatedInput: input, toolUseID: opts.toolUseID };
  };
}

export function buildOptions(spec: RunSpec): Options {
  if (spec.resume && spec.sessionId) {
    throw new Error("buildOptions: `resume` and `sessionId` are mutually exclusive");
  }
  const { cfg } = spec;

  const denied = new Set<string>(BUILTIN_DENY);
  const builtins = cfg.AGENT_BUILTIN_TOOLS.filter((t) => !denied.has(t));

  return {
    ...(cfg.AGENT_MODEL ? { model: cfg.AGENT_MODEL } : {}),
    cwd: cfg.houseDir,
    systemPrompt: { type: "preset", preset: "claude_code", append: spec.systemAppend },
    // Project only: the house directory's CLAUDE.md is the house notes. Never
    // `user` — on a persistent volume a user-level settings file is something
    // an earlier run could have written.
    settingSources: ["project"],
    strictMcpConfig: true,
    // `default`, not `dontAsk`: what would be a prompt goes to canUseTool,
    // which is where approvals happen.
    permissionMode: "default",
    canUseTool: answerPrompt(spec),

    // allowedTools stays empty on purpose: any entry there approves its tool
    // before canUseTool is asked — which for a Home Assistant tool would skip
    // the approval step entirely.
    tools: [...builtins],
    disallowedTools: [...BUILTIN_DENY],
    allowedTools: [],

    mcpServers: { ...spec.externalServers, [HASS_SERVER]: spec.hassServer },

    // No `matcher`: a matcher-less hook runs for every event of its type,
    // which is what a universal gate needs.
    hooks: {
      PreToolUse: [
        {
          hooks: [
            createGate({
              log: spec.log,
              houseDir: cfg.houseDir,
              interactive: spec.interactive,
              controlDomains: cfg.HA_CONTROL_DOMAINS,
              approvalLevel: cfg.HA_APPROVAL_LEVEL,
              ...(spec.isAborted ? { isAborted: spec.isAborted } : {}),
              ...(spec.onDecision ? { onDecision: spec.onDecision } : {}),
            }),
          ],
        },
      ],
    },

    maxTurns: cfg.AGENT_MAX_TURNS,
    env: sanitizedEnv(cfg),
    ...(spec.resume ? { resume: spec.resume } : {}),
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
  };
}
