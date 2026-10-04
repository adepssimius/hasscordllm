import { describe, expect, it } from "vitest";
import { hassToolNames } from "../tools/hass.js";
import {
  briefUserPrompt,
  chatUserPrompt,
  localStamp,
  pollAnswerContent,
  stripTurnHeader,
  systemAppend,
  turnHeader,
} from "./prompts.js";

const sys = (over: Partial<Parameters<typeof systemAppend>[0]> = {}) =>
  systemAppend({
    timeZone: "America/New_York",
    hasHomeAssistant: true,
    approvalLevel: "change",
    controlDomains: ["light", "switch"],
    notesFile: "CLAUDE.md",
    ...over,
  });

const turn = { now: new Date("2026-10-02T10:31:00Z"), timeZone: "America/New_York" };

describe("systemAppend", () => {
  it("explains that the approval button is the question", () => {
    const s = sys();
    expect(s).toMatch(/the button is the question/);
    expect(s).toMatch(/Do not retry it, and do not reach the\s+same result by another route/);
  });

  it("names the routine domains at the default level", () => {
    expect(sys()).toContain("`light`, `switch`");
  });

  it("describes each approval level differently", () => {
    const texts = (["control", "change", "destructive", "none"] as const).map((l) => sys({ approvalLevel: l }));
    expect(new Set(texts).size).toBe(4);
  });

  it("says plainly when Home Assistant is not connected", () => {
    const s = sys({ hasHomeAssistant: false });
    expect(s).toMatch(/No Home Assistant tools are connected/);
    expect(s).not.toMatch(/### Approval/);
  });

  it("tells the agent to keep secrets out of the house notes", () => {
    expect(sys()).toMatch(/Never write a token, password, code or other secret/);
  });

  it("only names tools that exist", () => {
    const named = [...sys().matchAll(/`mcp__hass__(\w+)`/g)].map((m) => `mcp__hass__${m[1]}`);
    const real = new Set(hassToolNames(true));
    for (const n of named) expect(real.has(n)).toBe(true);
  });
});

describe("turn header", () => {
  it("states the local time", () => {
    expect(turnHeader(turn)).toContain("Friday 2026-10-02 06:31 (America/New_York)");
  });

  it("does not open with a tag, or the SDK will not list the session for resume", () => {
    expect(chatUserPrompt({ authorDisplayName: "Ben", content: "hi" }, turn).charAt(0)).not.toBe("<");
    expect(briefUserPrompt({ name: "x", prompt: "y" }, turn).charAt(0)).not.toBe("<");
  });

  it("is stripped back out of a stored prompt", () => {
    const p = chatUserPrompt({ authorDisplayName: "Ben", content: "is the garage open?" }, turn);
    expect(stripTurnHeader(p)).toBe("Ben says:\n\nis the garage open?");
  });
});

describe("chatUserPrompt", () => {
  it("includes messages that arrived while the last run was going", () => {
    const p = chatUserPrompt({ authorDisplayName: "Ben", content: "turn off the porch", coalescedWith: ["and the hall"] }, turn);
    expect(p).toMatch(/They then added, before you replied:\n\nand the hall/);
  });
});

describe("briefUserPrompt", () => {
  it("says a scheduled run only looks", () => {
    const p = briefUserPrompt({ name: "morning", prompt: "anything unusual?" }, turn);
    expect(p).toMatch(/This run only looks/);
    expect(p.endsWith("anything unusual?")).toBe(true);
  });
});

describe("pollAnswerContent", () => {
  it("names the poll and the answer", () => {
    expect(pollAnswerContent({ key: "rooms", question: "Which rooms?" }, ["Kitchen", "Hall"])).toContain(
      "Answers:\n- Kitchen\n- Hall",
    );
  });
});

describe("localStamp", () => {
  it("formats in the given zone", () => {
    expect(localStamp(new Date("2026-01-01T05:00:00Z"), "UTC")).toBe("Thursday 2026-01-01 05:00");
  });
});
