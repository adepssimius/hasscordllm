import { isAbsolute, relative } from "node:path";

/**
 * What the agent is doing, in words, for the live progress message.
 *
 * The first version printed the tool call itself — `Bash command=cd /data/
 * threads/3134e30a-… && python3 scripts/verify_plan.py | tail -3` — which is
 * accurate and tells the person reading it on a phone nothing. What they want
 * is why: "Checking the plan still passes its checks".
 *
 * Two sources, used in turn:
 *
 *  - **The moment a call starts**, `describeToolCall` phrases it from its own
 *    input. Claude Code's Bash tool carries a `description` the model writes
 *    for exactly this purpose, TodoWrite carries the step in progress, and the
 *    file tools are phrased around the file.
 *  - **A few seconds later**, Claude Code emits its own summary of a group of
 *    calls ("Read AGENTS.md & verify_plan.py"). `Activity.summarise` folds the
 *    lines it covers into that one.
 *
 * Pure, so the phrasing is unit tested.
 */

export interface ActivityLine {
  /** The tool calls this line stands for. Empty once nothing can replace it. */
  readonly ids: readonly string[];
  readonly text: string;
}

const MAX_LINE = 90;

const clip = (s: string): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_LINE ? `${one.slice(0, MAX_LINE - 1)}…` : one;
};

function field(input: unknown, key: string): unknown {
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
}

function str(input: unknown, key: string): string | undefined {
  const v = field(input, key);
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

/** A path as the person thinks of it: relative to the house notes, not the pod. */
export function displayPath(path: string, root?: string): string {
  if (root) {
    const rel = relative(root, path);
    if (rel === "") return "the house notes";
    if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  // Outside the house directory (a scratch file in /tmp): the file name is what matters.
  return isAbsolute(path) ? (path.split("/").filter(Boolean).pop() ?? path) : path;
}

const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;

/** `ha_config_list_groups` → "config list groups". */
const words = (name: string): string => name.replace(/^ha_/, "").replace(/[_-]+/g, " ").trim();

/** Phrases for the tools whose names alone would read as jargon. */
const MCP_PHRASES: Record<string, Record<string, string>> = {
  homeassistant: {
    ha_search: "Searching Home Assistant",
    ha_get_overview: "Getting an overview of the house",
    ha_get_state: "Checking current state",
    ha_get_entity: "Looking at an entity",
    ha_get_device: "Looking at a device",
    ha_get_history: "Looking back through history",
    ha_get_logs: "Reading the logs",
    ha_get_automation_traces: "Reading automation traces",
    ha_get_system_health: "Checking system health",
    ha_get_camera_image: "Grabbing a camera snapshot",
    ha_list_floors_areas: "Listing floors and areas",
    ha_list_services: "Looking up available services",
    ha_eval_template: "Evaluating a template",
    ha_get_skill_guide: "Reading Home Assistant best practices",
    ha_config_get_automation: "Reading an automation",
    ha_config_get_script: "Reading a script",
    ha_config_get_scene: "Reading a scene",
    ha_config_get_dashboard: "Reading a dashboard",
    ha_config_list_helpers: "Listing helpers",
    ha_call_service: "Calling a service",
    ha_bulk_control: "Controlling several devices",
    ha_config_set_automation: "Saving an automation",
    ha_config_set_script: "Saving a script",
    ha_config_set_scene: "Saving a scene",
    ha_config_set_helper: "Saving a helper",
    ha_config_set_dashboard: "Saving a dashboard",
    ha_restart: "Restarting Home Assistant",
    ha_reload_core: "Reloading configuration",
  },
  hass: {
    poll: "Preparing a poll",
    schedule_list: "Looking at the schedules",
    schedule_set: "Saving a schedule",
    schedule_delete: "Removing a schedule",
    schedule_run_now: "Starting a scheduled brief",
  },
};

const SERVICE: Record<string, string> = { homeassistant: "Home Assistant" };

/** One line saying what a tool call is for. */
export function describeToolCall(name: string, input: unknown, root?: string): string {
  const path = (key = "file_path"): string => {
    const p = str(input, key);
    return p ? code(displayPath(p, root)) : "a file";
  };

  switch (name) {
    case "Bash": {
      // Claude Code asks the model for this description on every Bash call,
      // precisely so a person can see what a command is for.
      const d = str(input, "description");
      return clip(d ?? "Running a command");
    }
    case "Read":
      return clip(`Reading ${path()}`);
    case "Edit":
    case "MultiEdit":
      return clip(`Editing ${path()}`);
    case "Write":
      return clip(`Writing ${path()}`);
    case "NotebookEdit":
      return clip(`Editing ${path("notebook_path")}`);
    case "Glob":
      return clip(`Looking for files matching ${code(str(input, "pattern") ?? "*")}`);
    case "Grep": {
      const where = str(input, "path");
      return clip(
        `Searching for ${code(str(input, "pattern") ?? "")}${where ? ` in ${code(displayPath(where, root))}` : ""}`,
      );
    }
    case "WebSearch":
      return clip(`Searching the web for “${str(input, "query") ?? ""}”`);
    case "Skill":
      return clip(`Using the ${str(input, "skill") ?? str(input, "command") ?? ""} skill`);
    case "TodoWrite": {
      // The step being worked on, in the model's own words.
      const todos = field(input, "todos");
      if (Array.isArray(todos)) {
        const active = todos.find((t) => field(t, "status") === "in_progress");
        const phrase = str(active, "activeForm") ?? str(active, "content");
        if (phrase) return clip(phrase);
      }
      return "Planning the next steps";
    }
  }

  // Said from its input: which service, on what, is the whole point.
  if (name === "mcp__homeassistant__ha_call_service") {
    const svc = `${str(input, "domain") ?? "?"}.${str(input, "service") ?? "?"}`;
    const target = field(input, "entity_id");
    const first = typeof target === "string" ? target : Array.isArray(target) ? target[0] : undefined;
    const more = Array.isArray(target) && target.length > 1 ? ` and ${target.length - 1} more` : "";
    return clip(`Calling ${code(svc)}${typeof first === "string" ? ` on ${code(first)}${more}` : ""}`);
  }
  if (name === "ReadMcpResourceTool" || name === "ListMcpResourcesTool") {
    return "Reading Home Assistant best practices";
  }

  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) {
    const [, server = "", tool = ""] = mcp;
    const known = MCP_PHRASES[server]?.[tool];
    if (known) return known;
    const service = SERVICE[server];
    return clip(service ? `${service}: ${words(tool)}` : words(tool));
  }

  return clip(words(name));
}

/**
 * The running list of activity lines for one turn.
 *
 * A line is added when a call starts and replaced when Claude Code summarises
 * the calls it covers. Repeats collapse — reading three files in a row is
 * three lines, but the same Bash description five times is one.
 */
export class Activity {
  private lines: ActivityLine[] = [];

  add(id: string, text: string): void {
    const last = this.lines[this.lines.length - 1];
    if (last && last.text === text) {
      this.lines[this.lines.length - 1] = { ids: [...last.ids, id], text };
      return;
    }
    this.lines.push({ ids: [id], text });
  }

  /** Replaces the lines covering `ids` with one line, where the first of them stood. */
  summarise(summary: string, ids: readonly string[]): void {
    const covered = new Set(ids);
    const first = this.lines.findIndex((l) => l.ids.some((id) => covered.has(id)));
    if (first === -1) return;
    const kept = this.lines.filter((l, i) => i < first || !l.ids.some((id) => covered.has(id)));
    kept.splice(first, 0, { ids: [], text: clip(summary) });
    this.lines = kept;
  }

  /** The most recent lines, oldest first. */
  recent(n: number): string[] {
    return this.lines.slice(-n).map((l) => l.text);
  }
}
