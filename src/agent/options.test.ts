import { describe, expect, it, vi } from "vitest";
import { createSdkMcpServer, type HookInput, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, type Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { ApprovalEvent, ApprovalRequest, Approver } from "./approval.js";
import { createGate } from "./gate.js";
import { answerPrompt, buildOptions, BUILTIN_DENY } from "./options.js";

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const signal = new AbortController().signal;
const prompt = { signal, toolUseID: "t1", requestId: "r1" };

const config = (over: Record<string, string> = {}): Config =>
  loadConfig({ DATA_DIR: "/data", HA_CONTROL_DOMAINS: "light,switch", ...over } as NodeJS.ProcessEnv);

const unlock = { domain: "lock", service: "unlock", entity_id: "lock.front_door" };
const lightOn = { domain: "light", service: "turn_on", entity_id: "light.kitchen" };
const SVC = "mcp__homeassistant__ha_call_service";

async function ask(
  toolName: string,
  input: Record<string, unknown>,
  opts: { cfg?: Config; approver?: Approver; interactive?: boolean; events?: ApprovalEvent[] } = {},
): Promise<PermissionResult> {
  const answer = answerPrompt({
    cfg: opts.cfg ?? config(),
    log,
    interactive: opts.interactive ?? true,
    approver: opts.approver,
    onApproval: (e) => opts.events?.push(e),
  });
  const r = await answer(toolName, input, prompt);
  if (!r) throw new Error("canUseTool returned no answer");
  return r;
}

const approving = (asked: ApprovalRequest[] = []): Approver => async (req) => {
  asked.push(req);
  return { approved: true, by: "u1" };
};
const refusing: Approver = async () => ({ approved: false, by: "u1", reason: "the person denied it" });

describe("approval of Home Assistant changes", () => {
  it("lets a read through without asking anyone", async () => {
    const asked: ApprovalRequest[] = [];
    const r = await ask("mcp__homeassistant__ha_get_state", { entity_id: "lock.front_door" }, { approver: approving(asked) });
    expect(r.behavior).toBe("allow");
    expect(asked).toEqual([]);
  });

  it("lets routine control through without asking at the default level", async () => {
    const asked: ApprovalRequest[] = [];
    expect((await ask(SVC, lightOn, { approver: approving(asked) })).behavior).toBe("allow");
    expect(asked).toEqual([]);
  });

  it("asks before unlocking a door, and goes ahead when approved", async () => {
    const asked: ApprovalRequest[] = [];
    const events: ApprovalEvent[] = [];
    const r = await ask(SVC, unlock, { approver: approving(asked), events });
    expect(r).toMatchObject({ behavior: "allow", updatedInput: unlock });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ toolName: SVC, tier: "change", toolUseId: "t1" });
    expect(events[0]?.answer).toEqual({ approved: true, by: "u1" });
  });

  it("refuses when the person says no, and tells the agent not to work around it", async () => {
    const r = await ask(SVC, unlock, { approver: refusing });
    expect(r.behavior).toBe("deny");
    if (r.behavior === "deny") {
      expect(r.message).toMatch(/denied/);
      expect(r.message).toMatch(/do not try to get the same effect another way/);
    }
  });

  it("refuses when there is nobody to ask", async () => {
    const r = await ask(SVC, unlock, {});
    expect(r.behavior).toBe("deny");
  });

  it("asks even for a light at level control, and for nothing at level none", async () => {
    const asked: ApprovalRequest[] = [];
    await ask(SVC, lightOn, { cfg: config({ HA_APPROVAL_LEVEL: "control" }), approver: approving(asked) });
    expect(asked).toHaveLength(1);

    const none: ApprovalRequest[] = [];
    const r = await ask("mcp__homeassistant__ha_restart", {}, { cfg: config({ HA_APPROVAL_LEVEL: "none" }), approver: approving(none) });
    expect(r.behavior).toBe("allow");
    expect(none).toEqual([]);
  });

  it("refuses every change in a scheduled run, without asking", async () => {
    const asked: ApprovalRequest[] = [];
    const r = await ask(SVC, lightOn, { interactive: false, approver: approving(asked) });
    expect(r.behavior).toBe("deny");
    expect(asked).toEqual([]);
  });

  it("keeps file tools inside the house notes", async () => {
    expect((await ask("Write", { file_path: "/data/house/CLAUDE.md", content: "x" })).behavior).toBe("allow");
    expect((await ask("Read", { file_path: "/proc/self/environ" })).behavior).toBe("deny");
  });
});

describe("the gate forces the prompt", () => {
  const gate = (cfg: Config, interactive = true) =>
    createGate({
      log,
      houseDir: cfg.houseDir,
      interactive,
      controlDomains: cfg.HA_CONTROL_DOMAINS,
      approvalLevel: cfg.HA_APPROVAL_LEVEL,
    });
  const pre = (tool_name: string, tool_input: unknown): HookInput =>
    ({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "" }) as unknown as HookInput;

  it("answers `ask` for a call that needs approval, so canUseTool cannot be skipped", async () => {
    const out = await gate(config())(pre(SVC, unlock), "t1", { signal });
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
  });

  it("stays out of the way of reads and routine control", async () => {
    expect(await gate(config())(pre(SVC, lightOn), "t1", { signal })).toEqual({});
    expect(await gate(config())(pre("mcp__homeassistant__ha_search", {}), "t1", { signal })).toEqual({});
  });

  it("denies outright in a scheduled run", async () => {
    const out = await gate(config(), false)(pre(SVC, lightOn), "t1", { signal });
    expect(out).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});

describe("buildOptions", () => {
  const cfg = config();
  const opts = buildOptions({
    cfg,
    log,
    systemAppend: "",
    externalServers: {},
    hassServer: createSdkMcpServer({ name: "hass", version: "0", tools: [] }),
    interactive: true,
    sessionId: "00000000-0000-4000-8000-000000000000",
  });

  it("routes prompts to canUseTool, where approvals happen", () => {
    // bypassPermissions would skip canUseTool — and every approval with it.
    expect(opts.permissionMode).toBe("default");
    expect(opts.canUseTool).toBeTypeOf("function");
  });

  it("keeps the allow list empty, so no Home Assistant tool is pre-approved", () => {
    expect(opts.allowedTools).toEqual([]);
  });

  it("removes subagents, WebFetch and the shell outright", () => {
    expect(opts.disallowedTools).toEqual([...BUILTIN_DENY]);
    for (const t of BUILTIN_DENY) expect(opts.tools).not.toContain(t);
    expect(opts.tools).not.toContain("Bash");
  });

  it("works in the house directory and loads only the bot's own MCP servers", () => {
    expect(opts.cwd).toBe("/data/house");
    expect(opts.strictMcpConfig).toBe(true);
  });

  it("does not hand the agent the Home Assistant token", () => {
    const withHa = buildOptions({
      cfg: config({ HOMEASSISTANT_URL: "http://ha", HOMEASSISTANT_TOKEN: "secret-token" }),
      log,
      systemAppend: "",
      externalServers: {},
      hassServer: createSdkMcpServer({ name: "hass", version: "0", tools: [] }),
      interactive: true,
    });
    expect(JSON.stringify(withHa.env)).not.toContain("secret-token");
  });
});
