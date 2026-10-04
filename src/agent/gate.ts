import type { HookCallback, HookInput, PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../logger.js";
import type { ApprovalLevel } from "../config.js";
import { classify, isHaTool, needsApproval } from "../ha/classify.js";
import { evaluate, type Decision } from "./policy.js";

export interface GateContext {
  readonly log: Logger;
  readonly houseDir: string;
  readonly interactive: boolean;
  readonly controlDomains: readonly string[];
  readonly approvalLevel: ApprovalLevel;
  /** Consulted per call so a `stop` in Discord takes effect mid-run. */
  readonly isAborted?: () => boolean;
  readonly onDecision?: (event: GateEvent) => void;
}

export interface GateEvent {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly decision: Decision;
}

/**
 * PreToolUse hook factory.
 *
 * This runs before deny rules, the permission mode, and allow rules, so it is
 * the one gate that sees every tool call. Register it with no `matcher`: a
 * matcher-less hook runs for every event of its type.
 */
export function createGate(ctx: GateContext): HookCallback {
  return async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const pre = input as PreToolUseHookInput;

    const decision = evaluate({
      toolName: pre.tool_name,
      toolInput: pre.tool_input,
      houseDir: ctx.houseDir,
      interactive: ctx.interactive,
      controlDomains: ctx.controlDomains,
      ...(ctx.isAborted ? { aborted: ctx.isAborted() } : {}),
    });

    ctx.onDecision?.({ toolName: pre.tool_name, toolInput: pre.tool_input, decision });

    if (decision.allow) {
      // A Home Assistant call that needs a person is forced through the
      // permission prompt, so canUseTool — where the approval happens — is
      // asked even if Claude Code would otherwise have let the tool through
      // on its own (an MCP tool annotated read-only, a future default).
      if (ctx.interactive && isHaTool(pre.tool_name)) {
        const c = classify(pre.tool_name, pre.tool_input, ctx.controlDomains);
        if (needsApproval(c.tier, ctx.approvalLevel)) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "ask" as const,
              permissionDecisionReason: `needs approval: ${c.reason}`,
            },
          };
        }
      }
      return {};
    }

    ctx.log.warn({ tool: pre.tool_name, reason: decision.reason }, "tool denied by policy");
    return {
      systemMessage: `Blocked: ${decision.reason}`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: decision.reason,
      },
    };
  };
}
