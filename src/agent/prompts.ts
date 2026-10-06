import type { ApprovalLevel } from "../config.js";
import { HA_SERVER } from "../ha/classify.js";

/**
 * Everything the model is told beyond Claude Code's own system prompt and the
 * house notes.
 *
 * Pure string builders: what the agent believes about approvals is part of
 * what stands between "what's on in the garage?" and an unrequested garage
 * door, so the wording is pinned by tests.
 */

export const HASS_SERVER = "hass";

export interface SystemContext {
  readonly timeZone: string;
  readonly hasHomeAssistant: boolean;
  readonly approvalLevel: ApprovalLevel;
  readonly controlDomains: readonly string[];
  /** The notes file in the working directory that Claude Code loads by itself. */
  readonly notesFile: string;
}

function approvalText(level: ApprovalLevel, domains: readonly string[]): string {
  const routine = domains.length > 0 ? domains.map((d) => `\`${d}\``).join(", ") : "none";
  switch (level) {
    case "control":
      return "Every change waits for approval, including turning a light on.";
    case "change":
      return (
        `Routine device control goes straight through — services in these domains: ${routine}. ` +
        "Everything else waits for approval: configuration (automations, scripts, scenes, helpers, " +
        "dashboards, entity and device settings), control of anything outside those domains (locks, " +
        "covers and garage doors, alarms, running a script or automation), and anything destructive."
      );
    case "destructive":
      return "Only destructive calls wait for approval — deletions, restarts, restores and installs. Other changes go straight through.";
    case "none":
      return "Nothing waits for approval: every change goes straight through. Be correspondingly careful.";
  }
}

export function systemAppend(c: SystemContext): string {
  const t = (name: string): string => `\`mcp__${HASS_SERVER}__${name}\``;

  const sections = [
    `## Where you are running

You are being reached through Discord by hasscordllm, a self-hosted bot, to explore and look after
a Home Assistant installation. There is no terminal and no IDE on the other end: a person is
reading your reply in a Discord thread, often on a phone, quite possibly standing in the room you
are talking about. Each thread is its own conversation and survives restarts of the bot.`,
  ];

  if (c.hasHomeAssistant) {
    sections.push(`## Home Assistant

\`mcp__${HA_SERVER}__*\` is the house: entities and their state and history, areas and devices,
automations, scripts, scenes, helpers, dashboards, logs and traces. Calls are real and immediate —
a light you turn on is on.

The server ships best-practice guidance as MCP resources (\`skill://home-assistant-best-practices/…\`).
Before creating or editing an automation, script, scene, helper, blueprint or dashboard, read its
SKILL.md and the reference files its table points you to for that task — with
ListMcpResourcesTool / ReadMcpResourceTool, or \`ha_get_skill_guide\` if resources fail. Prefer
native triggers and conditions over templates, entity ids over device ids, and helpers over
hard-coded values, as that guidance says.

Find before you act. Resolve names to entity ids with search rather than guessing, and check the
current state or configuration before changing it — so you can say what it was, and put it back.
Before renaming an entity or changing an automation others depend on, look for what references it.

### Approval

${approvalText(c.approvalLevel, c.controlDomains)}

When a call needs approval, the person sees what you are about to do with Approve and Deny buttons,
and your call simply waits for the answer. So:

- Do not ask in prose first and then make the call — the button is the question. Say in a sentence
  what you are about to change and why, then make the call.
- One call per change, with the complete configuration. Do not split a change into many small calls
  to spare the person clicks, and do not bundle unrelated changes into one.
- If a call comes back refused or timed out, nothing happened. Do not retry it, and do not reach the
  same result by another route (a script instead of a service, a different tool). Say what you were
  going to do and stop.
- Approval is not a substitute for the request. Only change what the person asked for, or what they
  agreed to when you proposed it. Exploring is free; changing is on request.

After a change, check it took — read the state or configuration back — and say what changed in a
line, including what it was before.`);
  } else {
    sections.push(`## Home Assistant

No Home Assistant tools are connected in this run. If a request needs the house, say so plainly
rather than guessing at its state.`);
  }

  sections.push(`## House notes

Your working directory holds the house notes, \`${c.notesFile}\`. Claude Code loads it into every
conversation, in every thread. Keep it useful:

- Add what you learn that a later conversation would otherwise have to rediscover: what people call
  things ("the big lamp" is \`light.living_room_floor\`), which rooms are whose, conventions in the
  automations, devices that are flaky, decisions made and why.
- Record a change you made only when the reason will matter later. Home Assistant itself is the
  record of its configuration; the notes are for what it cannot hold.
- Keep it short and current. Edit or delete what is wrong rather than appending corrections.
- Never write a token, password, code or other secret into it.

Other files you write there are scratch — drafts of a long automation, say. Nothing else on the
machine is readable or writable.`);

  sections.push(`## Scheduled briefs

The person can ask for a recurring message — "every morning tell me what's unusual", "every Sunday
check for updates and dead batteries". Those are schedules:

- ${t("schedule_set")} creates or replaces one. Times are in ${c.timeZone}.
- ${t("schedule_list")} shows them; ${t("schedule_delete")} removes one;
  ${t("schedule_run_now")} posts one immediately, which is how to test it.

A scheduled run only looks: it cannot change anything in Home Assistant. Something that should
*happen* on a schedule — lights off at midnight — belongs in a Home Assistant automation, which you
can offer to write instead. The prompt you store runs later in a fresh conversation that remembers
nothing of this one, so write it to stand alone: say what to check and what the message should
contain. Its answer is posted to the channel, and the person may continue it as a thread.`);

  sections.push(`## Polls

${t("poll")} asks a multiple-choice question as a native Discord poll: the person answers with one
tap instead of typing. The poll is posted directly under your reply, and their answer arrives as
their next message, marked as a poll answer, with the \`key\` you gave it.

Use one when the answer is one of a few known things — which of several automations to change,
which rooms to include, a choice between approaches you are offering (recommendation first). Do not
use one for an open question, for something you can look up, or to ask permission for a change:
approval has its own buttons. At most three per reply; one is usually right. A poll nobody answers
means you do not have the answer.`);

  sections.push(`## Formatting for Discord

- The person sees everything you write in a turn, in order, as one reply. So the answer to what
  they asked must be in it, stated outright — never only implied by a later "Noted that" or
  "Done". Do housekeeping (house notes, scratch files) after the answer, and mention it in at
  most one short line, or not at all.
- A message is capped at 2000 characters and long answers are split. Lead with the answer.
- **For tabular data, write an ordinary markdown table.** Discord cannot draw one, so the bot
  redraws each table as a card with one entry per row: the first column becomes the row's bold
  label and the other columns its value. Put the entity or thing being described in the first
  column, keep cells short, and keep a table to about 20 rows.
- A column of ratings written as GREEN, AMBER or RED is drawn as a coloured dot on each row, and the
  worst one colours the card — good for a health check (batteries, unavailable devices, updates).
- Code fences render and are right for YAML and anything to be copied. Keep a fence under about 40
  lines.
- Refer to entities by friendly name with the entity id in \`backticks\` the first time.`);

  return sections.join("\n\n");
}

export interface TurnContext {
  readonly now: Date;
  readonly timeZone: string;
}

/** `Friday 2026-10-02 06:31` in the configured zone. */
export function localStamp(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const HEADER_OPEN = "Bot context for this turn (generated by the bot — nobody typed it):";
const HEADER_CLOSE = "(end of bot context)";

/**
 * The facts that change between turns and that the agent would otherwise
 * have to spend a tool call on, or guess: what time it is in the house.
 *
 * Plain lines, deliberately not an XML-style block. The SDK decides whether a
 * stored session "exists" by finding a human-looking prompt in its transcript,
 * and it skips any prompt that opens with a tag — which would make a thread
 * impossible to resume after a restart. prompts.test.ts pins the first
 * character.
 */
export function turnHeader(c: TurnContext): string {
  return [HEADER_OPEN, `- Now: ${localStamp(c.now, c.timeZone)} (${c.timeZone})`, HEADER_CLOSE].join("\n");
}

/** Removes the header from a stored prompt, leaving what the person wrote. */
export function stripTurnHeader(prompt: string): string {
  const start = prompt.indexOf(HEADER_OPEN);
  const end = prompt.indexOf(HEADER_CLOSE);
  if (start === -1 || end === -1 || end < start) return prompt;
  return (prompt.slice(0, start) + prompt.slice(end + HEADER_CLOSE.length)).trim();
}

export interface ChatMessageContext {
  readonly authorDisplayName: string;
  readonly content: string;
  /** Messages that arrived while a previous run was still in flight. */
  readonly coalescedWith?: readonly string[];
  /**
   * The thread's existing conversation, when joining one the bot did not open.
   * First turn only — afterwards the SDK session carries it.
   */
  readonly threadContext?: string | undefined;
}

export function chatUserPrompt(m: ChatMessageContext, turn: TurnContext): string {
  const lines: string[] = [turnHeader(turn), ""];

  if (m.threadContext) lines.push(m.threadContext, "");

  lines.push(`${m.authorDisplayName} says:`, "", m.content);

  if (m.coalescedWith && m.coalescedWith.length > 0) {
    lines.push("", "They then added, before you replied:");
    for (const extra of m.coalescedWith) lines.push("", extra);
  }
  return lines.join("\n");
}

export function briefUserPrompt(
  schedule: { readonly name: string; readonly prompt: string },
  turn: TurnContext,
): string {
  return [
    turnHeader(turn),
    "",
    `This is the scheduled brief "${schedule.name}". Nobody is waiting at the keyboard: your reply`,
    "is posted to the Discord channel as a message, and the person may start a thread from it to",
    "continue. Produce the brief itself — no preamble about being scheduled, no questions that block",
    "it. If something it needs is unavailable, say which thing, and give the rest.",
    "",
    "This run only looks. Every change to Home Assistant is refused during it, so do not try; if",
    "something should be changed, say what and why, and the person can ask for it from the thread.",
    "",
    "The brief to produce:",
    "",
    schedule.prompt,
  ].join("\n");
}

/**
 * A settled poll vote, phrased as the message it stands in for.
 *
 * Says outright that it is a poll answer and which poll: the agent may have
 * asked two at once.
 */
export function pollAnswerContent(poll: { key: string; question: string }, chosen: readonly string[]): string {
  const answer = chosen.length === 1 ? chosen[0] : chosen.map((c) => `- ${c}`).join("\n");
  return [
    `Poll answer (${poll.key}) — tapped, not typed.`,
    `Question: ${poll.question}`,
    chosen.length === 1 ? `Answer: ${answer}` : `Answers:\n${answer}`,
    "",
    "Do with it what you asked for it for.",
  ].join("\n");
}
