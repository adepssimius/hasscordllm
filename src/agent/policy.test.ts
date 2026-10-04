import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate } from "./policy.js";

const house = "/data/house";
const call = (toolName: string, toolInput: unknown, opts: { interactive?: boolean; aborted?: boolean } = {}) =>
  evaluate({
    toolName,
    toolInput,
    houseDir: house,
    interactive: opts.interactive ?? true,
    controlDomains: ["light"],
    aborted: opts.aborted ?? false,
  });

describe("files stay inside the house notes", () => {
  it("allows editing the notes, relative or absolute", () => {
    expect(call("Edit", { file_path: "CLAUDE.md" }).allow).toBe(true);
    expect(call("Write", { file_path: `${house}/drafts/porch.yaml` }).allow).toBe(true);
  });

  it("allows scratch files under the temp directory", () => {
    expect(call("Write", { file_path: join(tmpdir(), "x.json") }).allow).toBe(true);
  });

  it("refuses the database and anything else on the volume", () => {
    expect(call("Write", { file_path: "/data/hasscordllm.db" }).allow).toBe(false);
    expect(call("Edit", { file_path: "../hasscordllm.db" }).allow).toBe(false);
    // Shares a prefix with the house directory; a startsWith check would pass it.
    expect(call("Write", { file_path: "/data/house-other/x" }).allow).toBe(false);
  });

  it("refuses reading outside it — another process's environment included", () => {
    expect(call("Read", { file_path: "/proc/1/environ" }).allow).toBe(false);
    expect(call("Grep", { pattern: "TOKEN", path: "/proc" }).allow).toBe(false);
    expect(call("Glob", { pattern: "**/*", path: "/data" }).allow).toBe(false);
  });

  it("allows reading the notes, and searching with no path", () => {
    expect(call("Read", { file_path: `${house}/CLAUDE.md` }).allow).toBe(true);
    expect(call("Grep", { pattern: "garage" }).allow).toBe(true);
  });

  it("refuses a write with no path", () => {
    expect(call("Write", { content: "x" }).allow).toBe(false);
  });
});

describe("there is no shell", () => {
  it("refuses Bash even if it were registered", () => {
    expect(call("Bash", { command: "env" }).allow).toBe(false);
  });
});

describe("scheduled runs only look", () => {
  const light = { domain: "light", service: "turn_off", entity_id: "light.porch" };

  it("allows reads", () => {
    expect(call("mcp__homeassistant__ha_get_state", { entity_id: "light.porch" }, { interactive: false }).allow).toBe(
      true,
    );
  });

  it("refuses even routine control, which is the place for an automation", () => {
    const d = call("mcp__homeassistant__ha_call_service", light, { interactive: false });
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/scheduled run only looks/);
  });

  it("leaves interactive Home Assistant calls to the approval step", () => {
    expect(call("mcp__homeassistant__ha_call_service", light).allow).toBe(true);
    expect(call("mcp__homeassistant__ha_restart", {}).allow).toBe(true);
  });
});

describe("stop", () => {
  it("refuses everything once the run is stopped", () => {
    expect(call("mcp__homeassistant__ha_get_state", {}, { aborted: true }).allow).toBe(false);
  });
});
