import type { ApprovalLevel } from "../config.js";

/**
 * Sorts every Home Assistant tool call into a tier, which decides whether it
 * waits for a person to press Approve in Discord. Pure, so every rule is
 * unit tested.
 *
 *   read         looks, changes nothing — never asks
 *   control      routine device control in an allowed domain (a light, the
 *                TV, the shopping list) — asks only at HA_APPROVAL_LEVEL=control
 *   change       configuration, and control of anything outside the routine
 *                domains (a lock, a garage door, a script) — asks by default
 *   destructive  deletes, restarts, restores, installs — asks unless
 *                HA_APPROVAL_LEVEL=none
 *
 * It fails toward asking. A tool this file has never heard of — a newer
 * ha-mcp, say — is `change` unless its name says it only reads or that it
 * deletes, and an action value it does not recognise is treated the same way.
 * The names and action values here are ha-mcp 8.6's; the readOnlyHint and
 * destructiveHint annotations in its source were the starting point.
 */

export type Tier = "read" | "control" | "change" | "destructive";

export interface Classification {
  readonly tier: Tier;
  /** Why, in a phrase, for the approval card and the audit log. */
  readonly reason: string;
}

/** The MCP server name the bot registers ha-mcp under. Tool names arrive as `mcp__homeassistant__<tool>`. */
export const HA_SERVER = "homeassistant";
const PREFIX = `mcp__${HA_SERVER}__`;

export function isHaTool(toolName: string): boolean {
  return toolName.startsWith(PREFIX);
}

export function bareHaTool(toolName: string): string {
  return toolName.startsWith(PREFIX) ? toolName.slice(PREFIX.length) : toolName;
}

/** Read-only by annotation, where the name alone does not say so. */
const READ_TOOLS = new Set([
  "ha_search",
  "ha_eval_template",
  "ha_report_issue",
  "ha_read_file",
  "ha_get_operation_status",
]);

const READ_PREFIXES = ["ha_get_", "ha_list_", "ha_config_get_", "ha_config_list_"];

const DESTRUCTIVE_PREFIXES = ["ha_remove_", "ha_delete_", "ha_config_remove_", "ha_config_delete_"];

/**
 * Tools that are a general-purpose escape hatch rather than one operation:
 * proxying an add-on's API, running custom code, the dev server, the security
 * policy itself. There is no safe subset to carve out.
 */
const DESTRUCTIVE_TOOLS = new Set([
  "ha_restart",
  "ha_manage_app",
  "ha_manage_custom_tool",
  "ha_manage_security_policy",
  "ha_dev_manage_settings",
  "ha_dev_manage_server",
]);

/** Action values that only look, across the `ha_manage_*` tools. */
const READ_ACTIONS = new Set(["list", "get", "view", "diff", "get_engine_theme", "status", "info", "update_information"]);

const DESTRUCTIVE_ACTION = /delete|remove|restore|reset|install|download|exclude|factory|add_repository/;

function field(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

function str(input: unknown, key: string): string | undefined {
  const v = field(input, key);
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/** `light.kitchen` → `light`. */
function domainOf(entityId: string): string | undefined {
  const i = entityId.indexOf(".");
  return i > 0 ? entityId.slice(0, i).toLowerCase() : undefined;
}

function entityIds(v: unknown): string[] {
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

const read = (reason: string): Classification => ({ tier: "read", reason });
const control = (reason: string): Classification => ({ tier: "control", reason });
const change = (reason: string): Classification => ({ tier: "change", reason });
const destructive = (reason: string): Classification => ({ tier: "destructive", reason });

/** Device control, judged by the domains it touches. */
function byDomains(domains: readonly string[], allowed: readonly string[], what: string): Classification {
  const outside = [...new Set(domains.filter((d) => !allowed.includes(d)))];
  if (domains.length > 0 && outside.length === 0) return control(`${what} in routine domain(s) ${[...new Set(domains)].join(", ")}`);
  if (outside.length > 0) return change(`${what} touches ${outside.join(", ")}, which is not routine control`);
  return change(`${what} with no target that can be checked`);
}

function callService(input: unknown, allowed: readonly string[]): Classification {
  if (str(input, "ws_command")) return change("a raw WebSocket command");
  const domain = str(input, "domain")?.toLowerCase();
  const service = str(input, "service")?.toLowerCase() ?? "";
  if (!domain) return change("a service call with no domain");

  if (domain === "homeassistant" && ["restart", "stop"].includes(service)) {
    return destructive(`homeassistant.${service}`);
  }
  if (service === "reload" || service.startsWith("reload_")) return change(`${domain}.${service} reloads configuration`);

  // The service's domain decides, and so does every entity it targets:
  // `homeassistant.turn_on` aimed at a lock is a lock being worked.
  const targets = [
    ...entityIds(field(input, "entity_id")),
    ...entityIds(field(field(input, "data"), "entity_id")),
    ...entityIds(field(field(field(input, "data"), "target"), "entity_id")),
  ];
  const domains = domain === "homeassistant" ? targets.map(domainOf) : [domain, ...targets.map(domainOf)];
  return byDomains(
    domains.filter((d): d is string => d !== undefined),
    allowed,
    `${domain}.${service || "?"}`,
  );
}

function bulkControl(input: unknown, allowed: readonly string[]): Classification {
  if (field(input, "dry_run") === true) return read("a dry run");
  const ops = field(input, "operations");
  // A selector resolves to entities on the Home Assistant side; there is
  // nothing here to check them against before they are acted on.
  if (!Array.isArray(ops) || ops.length === 0) return change("bulk control by selector");
  const domains = ops.map((o) => domainOf(str(o, "entity_id") ?? ""));
  if (domains.some((d) => d === undefined)) return change("bulk control with an operation missing its entity");
  return byDomains(domains as string[], allowed, "bulk control");
}

function manage(tool: string, input: unknown): Classification {
  const action = (str(input, "action") ?? str(input, "mode") ?? "").toLowerCase();
  if (action === "") return change(`${tool} with no action`);
  if (READ_ACTIONS.has(action)) return read(`${tool} ${action}`);
  if (tool === "ha_manage_backup" && action === "create") return control("taking a backup");
  if (tool === "ha_manage_blueprints" && action === "substitute") return read("previewing a blueprint");
  if (DESTRUCTIVE_ACTION.test(action)) return destructive(`${tool} ${action}`);
  return change(`${tool} ${action}`);
}

export function classify(toolName: string, input: unknown, controlDomains: readonly string[]): Classification {
  const t = bareHaTool(toolName);

  if (READ_TOOLS.has(t) || READ_PREFIXES.some((p) => t.startsWith(p))) return read("only reads");
  // Before the deletion prefixes: ticking off the shopping list is not a
  // destructive act.
  if (t === "ha_set_todo_item" || t === "ha_remove_todo_item") {
    return controlDomains.includes("todo") ? control("editing a to-do list") : change("editing a to-do list");
  }
  if (DESTRUCTIVE_TOOLS.has(t)) return destructive(t);
  if (DESTRUCTIVE_PREFIXES.some((p) => t.startsWith(p))) return destructive(`${t} deletes`);

  switch (t) {
    case "ha_call_service":
      return callService(input, controlDomains);
    case "ha_bulk_control":
      return bulkControl(input, controlDomains);
    case "ha_call_event":
      return change("firing an event, which automations may act on");
    case "ha_reload_core":
      return change("reloading configuration");
  }

  if (t.startsWith("ha_manage_")) return manage(t, input);
  return change(`${t} changes configuration`);
}

const ASKS_FROM: Record<ApprovalLevel, readonly Tier[]> = {
  control: ["control", "change", "destructive"],
  change: ["change", "destructive"],
  destructive: ["destructive"],
  none: [],
};

/** Whether a call in this tier waits for a person at this approval level. */
export function needsApproval(tier: Tier, level: ApprovalLevel): boolean {
  return ASKS_FROM[level].includes(tier);
}
