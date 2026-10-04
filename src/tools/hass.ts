import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Config } from "../config.js";
import { HASS_SERVER, localStamp } from "../agent/prompts.js";
import { checkCron } from "../schedule/cron.js";
import type { PollRequest, Schedule } from "../session/types.js";
import type { Store } from "../store/index.js";

/**
 * The bot's own tools, served in-process to the agent: polls, and schedules
 * that have to outlive the conversation that asked for them.
 *
 * A server is built per turn and closes over that turn, so there is no
 * session argument for the model to get wrong.
 */

export interface HassToolDeps {
  readonly cfg: Config;
  readonly store: Store;
  readonly actorId: string | null;
  /**
   * False for a scheduled run. A brief nobody is watching gets the poll tool
   * and nothing else: the scheduling tools are not registered at all, rather
   * than registered and trusted not to be called.
   */
  readonly interactive: boolean;
  /** The channel this conversation hangs off; a schedule created here posts there. */
  readonly defaultChannelId?: string | undefined;
  /** Queues a poll to be posted after this turn's reply. False when the turn has asked for enough. */
  readonly requestPoll: (poll: PollRequest) => boolean;
  /** Posts a schedule's brief now. Absent in the dev REPL, which has no channel. */
  readonly runScheduleNow?: ((schedule: Schedule) => void) | undefined;
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const failure = (s: string) => ({ content: [{ type: "text" as const, text: s }], isError: true });

function describeSchedule(s: Schedule, timeZone: string): string {
  const next = s.nextRunAt ? localStamp(new Date(s.nextRunAt), timeZone) : "never";
  const last = s.lastRunAt ? localStamp(new Date(s.lastRunAt), timeZone) : "not yet";
  return [
    `**${s.name}** — \`${s.cron}\` (${timeZone})${s.enabled ? "" : " — paused"}`,
    `  next: ${next} · last: ${last}${s.channelId ? ` · channel ${s.channelId}` : ""}`,
    `  prompt: ${s.prompt.length > 300 ? `${s.prompt.slice(0, 300)}…` : s.prompt}`,
  ].join("\n");
}

/** Discord's limits on a poll. */
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_OPTION_CHARS = 55;
export const POLL_MAX_QUESTION_CHARS = 300;
/** More than this in one turn is a questionnaire, not a question. */
export const POLLS_PER_TURN = 3;

export const READ_TOOL_NAMES = ["poll"] as const;
export const INTERACTIVE_TOOL_NAMES = ["schedule_list", "schedule_set", "schedule_delete", "schedule_run_now"] as const;

export function hassToolNames(interactive: boolean): string[] {
  const names: string[] = [...READ_TOOL_NAMES, ...(interactive ? INTERACTIVE_TOOL_NAMES : [])];
  return names.map((n) => `mcp__${HASS_SERVER}__${n}`);
}

export function createHassServer(deps: HassToolDeps) {
  const { cfg, store } = deps;
  const tz = cfg.BOT_TIMEZONE;

  const poll = tool(
    "poll",
    "Ask the person a multiple-choice question as a native Discord poll they answer with one tap. " +
      "The poll is posted right after your reply, and their answer arrives later as a new message in " +
      "this conversation. Not for asking permission to make a change — approval has its own buttons.",
    {
      key: z
        .string()
        .min(1)
        .max(32)
        .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, dashes and underscores")
        .describe("What the answer is, in a word — `rooms`, `approach`. It comes back with the answer."),
      question: z.string().min(3).max(POLL_MAX_QUESTION_CHARS).describe("The question, as they will read it."),
      options: z
        .array(z.string().min(1).max(POLL_MAX_OPTION_CHARS))
        .min(2)
        .max(POLL_MAX_OPTIONS)
        .describe(
          `Two to ${POLL_MAX_OPTIONS} answers, each at most ${POLL_MAX_OPTION_CHARS} characters, in the order to show them.`,
        ),
      multi: z.boolean().default(false).describe("True to let them pick several answers — e.g. which rooms."),
    },
    async (a) => {
      if (new Set(a.options).size !== a.options.length) return failure("Not posted: two options are identical.");
      const queued = deps.requestPoll({ key: a.key, question: a.question, options: a.options, multi: a.multi });
      if (!queued) {
        return failure(`Not posted: at most ${POLLS_PER_TURN} polls per reply. Ask the most useful ones first.`);
      }
      return text(
        "Queued. The poll appears directly under your reply, so say in the reply that it is there. " +
          "Do not guess the answer or act as if you have it — it arrives as their next message.",
      );
    },
  );

  if (!deps.interactive) {
    return createSdkMcpServer({ name: HASS_SERVER, version: "0.1.0", tools: [poll] });
  }

  const scheduleList = tool(
    "schedule_list",
    "List the scheduled briefs.",
    {},
    async () => {
      const all = store.schedules.list();
      if (all.length === 0) return text("No schedules.");
      return text(all.map((s) => describeSchedule(s, tz)).join("\n\n"));
    },
    { annotations: { readOnlyHint: true } },
  );

  const scheduleSet = tool(
    "schedule_set",
    "Create a scheduled brief, or replace the one with the same name. On schedule, the prompt is run " +
      "in a fresh, read-only conversation and the answer is posted to the channel.",
    {
      name: z
        .string()
        .min(2)
        .max(40)
        .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes")
        .describe("Short identifier, e.g. `morning-check`."),
      cron: z
        .string()
        .describe(`Five-field cron in ${tz}: minute hour day-of-month month day-of-week. "0 7 * * *" is 07:00 daily.`),
      prompt: z
        .string()
        .min(10)
        .max(4000)
        .describe(
          "What to produce each time. It runs with no memory of this conversation, so it must stand " +
            "alone: say what to check and what the message should contain.",
        ),
      channel_id: z
        .string()
        .regex(/^\d{5,25}$/)
        .optional()
        .describe("Discord channel id to post in. Omit to post in the channel this conversation belongs to."),
      enabled: z.boolean().default(true),
    },
    async (a) => {
      const check = checkCron(a.cron, tz, cfg.SCHEDULE_MIN_INTERVAL_MIN);
      if (!check.ok) return failure(`Not scheduled: ${check.reason}.`);
      const saved = store.schedules.upsert({
        name: a.name,
        cron: a.cron.trim(),
        prompt: a.prompt,
        channelId: a.channel_id ?? deps.defaultChannelId ?? null,
        enabled: a.enabled,
        createdBy: deps.actorId,
        nextRunAt: a.enabled ? check.next.getTime() : null,
      });
      return text(`Saved.\n\n${describeSchedule(saved, tz)}`);
    },
  );

  const scheduleDelete = tool(
    "schedule_delete",
    "Remove a scheduled brief by name. Briefs it already posted are unaffected.",
    { name: z.string().min(1) },
    async (a) =>
      store.schedules.delete(a.name)
        ? text(`Schedule \`${a.name}\` removed.`)
        : failure(`There is no schedule named \`${a.name}\`.`),
  );

  const scheduleRunNow = tool(
    "schedule_run_now",
    "Post a scheduled brief right now, without changing when it next runs. Use it to test a schedule.",
    { name: z.string().min(1) },
    async (a) => {
      const s = store.schedules.byName(a.name);
      if (!s) return failure(`There is no schedule named \`${a.name}\`.`);
      if (!deps.runScheduleNow) return failure("Briefs can only be posted when the bot is connected to Discord.");
      deps.runScheduleNow(s);
      return text(`Started \`${s.name}\`. It will appear in the brief channel as its own message when it is done.`);
    },
  );

  return createSdkMcpServer({
    name: HASS_SERVER,
    version: "0.1.0",
    tools: [poll, scheduleList, scheduleSet, scheduleDelete, scheduleRunNow],
  });
}
