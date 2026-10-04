import { describe, expect, it } from "vitest";
import { buildCard, outcomeLine, renderDetail, summarizeCall } from "./approvalCard.js";

const SVC = "mcp__homeassistant__ha_call_service";

describe("summarizeCall", () => {
  it("says which service, on what", () => {
    expect(summarizeCall(SVC, { domain: "lock", service: "unlock", entity_id: "lock.front_door" })).toBe(
      "Call `lock.unlock` on `lock.front_door`",
    );
  });

  it("caps a long target list", () => {
    const ids = ["a", "b", "c", "d", "e", "f"].map((x) => `light.${x}`);
    expect(summarizeCall(SVC, { domain: "light", service: "turn_off", entity_id: ids })).toMatch(/and 2 more$/);
  });

  it("names a configuration change by what it is called", () => {
    expect(
      summarizeCall("mcp__homeassistant__ha_config_set_automation", { config: { alias: "Porch light at dusk" } }),
    ).toBe("Config set automation — “Porch light at dusk”");
  });

  it("includes the action of a manage tool", () => {
    expect(summarizeCall("mcp__homeassistant__ha_manage_backup", { action: "restore", backup_id: "x" })).toBe(
      "Manage backup (restore)",
    );
  });
});

describe("renderDetail", () => {
  it("cannot be broken out of its code fence", () => {
    const d = renderDetail({ yaml: "```\n@everyone" });
    expect(d.match(/```/g)).toHaveLength(2);
  });

  it("clips very large inputs", () => {
    expect(renderDetail({ big: "x".repeat(10_000) }).length).toBeLessThan(3700);
  });
});

describe("buildCard", () => {
  it("never offers approve-the-rest on a destructive call", () => {
    const base = { toolName: SVC, input: {}, reason: "r", toolUseId: "t" };
    expect(buildCard({ ...base, tier: "change" }).offerApproveRest).toBe(true);
    expect(buildCard({ ...base, tier: "destructive" }).offerApproveRest).toBe(false);
  });
});

describe("outcomeLine", () => {
  it("says who decided", () => {
    expect(outcomeLine({ kind: "approved", by: "42" })).toBe("✅ Approved by <@42>");
    expect(outcomeLine({ kind: "denied", by: "42" })).toBe("🚫 Denied by <@42>");
    expect(outcomeLine({ kind: "timeout", minutes: 15 })).toMatch(/15 min — not done/);
  });
});
