import type { ApprovalRequest } from "../agent/approval.js";
import { bareHaTool, type Tier } from "../ha/classify.js";

/**
 * What an approval request looks like in Discord. Pure, so the wording is
 * unit tested; discord/approvals.ts turns it into an embed with buttons.
 *
 * The card has to be decidable on a phone in a few seconds: one line saying
 * what will happen, one saying why it is being asked, and the exact input
 * underneath for anyone who wants to check it.
 */

export interface Card {
  readonly title: string;
  readonly summary: string;
  readonly reason: string;
  /** The tool input, pretty-printed and clipped to fit an embed. */
  readonly detail: string;
  readonly color: number;
  /** Whether to offer "approve the rest of this reply". Never for destructive calls. */
  readonly offerApproveRest: boolean;
}

const TIER_LOOK: Record<Tier, { label: string; color: number }> = {
  read: { label: "Read", color: 0x95a5a6 },
  control: { label: "Control", color: 0x2ecc71 },
  change: { label: "Change", color: 0xf39c12 },
  destructive: { label: "Destructive", color: 0xe74c3c },
};

const MAX_DETAIL = 3500;

function field(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

function str(input: unknown, key: string): string | undefined {
  const v = field(input, key);
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function list(v: unknown): string[] {
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

function targets(ids: readonly string[]): string {
  if (ids.length === 0) return "";
  const shown = ids.slice(0, 4).map((id) => `\`${id}\``).join(", ");
  return ids.length > 4 ? `${shown} and ${ids.length - 4} more` : shown;
}

/** `ha_config_set_automation` → "config set automation". */
const words = (tool: string): string => tool.replace(/^ha_/, "").replace(/_/g, " ");

/** One line saying what the call will do. */
export function summarizeCall(toolName: string, input: unknown): string {
  const t = bareHaTool(toolName);

  if (t === "ha_call_service") {
    const svc = `\`${str(input, "domain") ?? "?"}.${str(input, "service") ?? "?"}\``;
    const ids = [...list(field(input, "entity_id")), ...list(field(field(input, "data"), "entity_id"))];
    return ids.length > 0 ? `Call ${svc} on ${targets(ids)}` : `Call ${svc}`;
  }
  if (t === "ha_bulk_control") {
    const ops = field(input, "operations");
    if (Array.isArray(ops)) {
      const ids = ops.map((o) => str(o, "entity_id")).filter((x): x is string => x !== undefined);
      return `Control ${ops.length} entit${ops.length === 1 ? "y" : "ies"}: ${targets(ids)}`;
    }
    return `Bulk control by selector${str(input, "action") ? ` (${str(input, "action")})` : ""}`;
  }

  const name = str(input, "alias") ?? str(input, "name") ?? str(field(input, "config"), "alias");
  const id =
    str(input, "identifier") ??
    str(input, "automation_id") ??
    str(input, "script_id") ??
    str(input, "entity_id") ??
    str(input, "url_path");
  const action = str(input, "action") ?? str(input, "mode");
  const what = [words(t), action ? `(${action})` : ""].filter(Boolean).join(" ");
  const subject = name ? `“${name}”` : id ? `\`${id}\`` : "";
  const line = subject ? `${what} — ${subject}` : what;
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export function renderDetail(input: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(input ?? null, null, 2);
  } catch {
    json = String(input);
  }
  // A literal fence in the input would close ours early.
  json = json.replace(/```/g, "ˋˋˋ");
  if (json.length > MAX_DETAIL) json = `${json.slice(0, MAX_DETAIL)}\n… (${json.length - MAX_DETAIL} more characters)`;
  return `\`\`\`json\n${json}\n\`\`\``;
}

export function buildCard(req: ApprovalRequest): Card {
  const look = TIER_LOOK[req.tier];
  return {
    title: `${look.label} — needs approval`,
    summary: summarizeCall(req.toolName, req.input),
    reason: req.reason,
    detail: renderDetail(req.input),
    color: look.color,
    offerApproveRest: req.tier !== "destructive",
  };
}

/** The line the card is left with once it is decided. */
export function outcomeLine(
  outcome:
    | { kind: "approved"; by: string; rest?: boolean }
    | { kind: "denied"; by: string }
    | { kind: "timeout"; minutes: number }
    | { kind: "stopped" },
): string {
  switch (outcome.kind) {
    case "approved":
      return outcome.rest
        ? `✅ Approved by <@${outcome.by}>, with the rest of this reply`
        : `✅ Approved by <@${outcome.by}>`;
    case "denied":
      return `🚫 Denied by <@${outcome.by}>`;
    case "timeout":
      return `⏱️ Nobody answered within ${outcome.minutes} min — not done`;
    case "stopped":
      return "🛑 Stopped — not done";
  }
}
