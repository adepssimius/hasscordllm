import { describe, expect, it } from "vitest";
import { classify, needsApproval, type Tier } from "./classify.js";

const ROUTINE = ["light", "switch", "media_player", "scene", "todo"];
const tier = (tool: string, input: unknown = {}, domains = ROUTINE): Tier =>
  classify(`mcp__homeassistant__${tool}`, input, domains).tier;

describe("reads", () => {
  it.each([
    "ha_get_state",
    "ha_get_history",
    "ha_list_services",
    "ha_config_get_automation",
    "ha_config_list_helpers",
    "ha_search",
    "ha_eval_template",
    "ha_get_logs",
  ])("%s only reads", (t) => {
    expect(tier(t)).toBe("read");
  });

  it("treats the list/get actions of the manage tools as reads", () => {
    expect(tier("ha_manage_backup", { action: "list" })).toBe("read");
    expect(tier("ha_manage_blueprints", { action: "get" })).toBe("read");
    expect(tier("ha_manage_energy_prefs", { mode: "get" })).toBe("read");
    expect(tier("ha_manage_updates", { action: "list" })).toBe("read");
  });

  it("treats a bulk dry run as a read", () => {
    expect(tier("ha_bulk_control", { dry_run: true, selector: { area: "kitchen" } })).toBe("read");
  });
});

describe("service calls", () => {
  it("is routine control for an allowed domain", () => {
    expect(tier("ha_call_service", { domain: "light", service: "turn_on", entity_id: "light.kitchen" })).toBe("control");
  });

  it("is a change for a lock, a cover, or a script", () => {
    expect(tier("ha_call_service", { domain: "lock", service: "unlock", entity_id: "lock.front" })).toBe("change");
    expect(tier("ha_call_service", { domain: "cover", service: "open_cover", entity_id: "cover.garage" })).toBe("change");
    expect(tier("ha_call_service", { domain: "script", service: "turn_on", entity_id: "script.bedtime" })).toBe("change");
  });

  it("judges homeassistant.turn_on by what it targets", () => {
    expect(tier("ha_call_service", { domain: "homeassistant", service: "turn_on", entity_id: "light.a" })).toBe("control");
    expect(tier("ha_call_service", { domain: "homeassistant", service: "turn_on", entity_id: ["light.a", "lock.b"] })).toBe(
      "change",
    );
  });

  it("does not let an allowed domain smuggle in a disallowed target", () => {
    expect(
      tier("ha_call_service", { domain: "light", service: "turn_on", data: { entity_id: "lock.front_door" } }),
    ).toBe("change");
  });

  it("treats restarting Home Assistant as destructive and a reload as a change", () => {
    expect(tier("ha_call_service", { domain: "homeassistant", service: "restart" })).toBe("destructive");
    expect(tier("ha_call_service", { domain: "automation", service: "reload" })).toBe("change");
  });

  it("asks about anything it cannot check", () => {
    expect(tier("ha_call_service", { service: "turn_on" })).toBe("change");
    expect(tier("ha_call_service", { domain: "light", service: "turn_on", ws_command: "config/x" })).toBe("change");
    expect(tier("ha_call_service", { domain: "homeassistant", service: "turn_on" })).toBe("change");
  });
});

describe("bulk control", () => {
  it("is routine when every operation is", () => {
    expect(
      tier("ha_bulk_control", {
        operations: [
          { entity_id: "light.a", action: "turn_off" },
          { entity_id: "switch.b", action: "turn_off" },
        ],
      }),
    ).toBe("control");
  });

  it("is a change when any operation is not, or when it goes by selector", () => {
    expect(
      tier("ha_bulk_control", { operations: [{ entity_id: "light.a" }, { entity_id: "lock.b" }] }),
    ).toBe("change");
    expect(tier("ha_bulk_control", { selector: { area: "garage" }, action: "turn_off" })).toBe("change");
  });
});

describe("configuration and deletion", () => {
  it.each(["ha_config_set_automation", "ha_set_entity", "ha_config_set_helper", "ha_reload_core", "ha_call_event"])(
    "%s is a change",
    (t) => {
      expect(tier(t)).toBe("change");
    },
  );

  it.each(["ha_config_remove_automation", "ha_remove_entity", "ha_config_delete_dashboard", "ha_restart", "ha_manage_app"])(
    "%s is destructive",
    (t) => {
      expect(tier(t)).toBe("destructive");
    },
  );

  it("sorts the manage tools by action", () => {
    expect(tier("ha_manage_backup", { action: "create" })).toBe("control");
    expect(tier("ha_manage_backup", { action: "restore" })).toBe("destructive");
    expect(tier("ha_manage_updates", { action: "install" })).toBe("destructive");
    expect(tier("ha_manage_hacs", { action: "download" })).toBe("destructive");
    expect(tier("ha_manage_pipeline", { action: "process" })).toBe("change");
    expect(tier("ha_manage_theme", {})).toBe("change");
  });

  it("treats the to-do list as routine, including ticking items off", () => {
    expect(tier("ha_set_todo_item", {})).toBe("control");
    expect(tier("ha_remove_todo_item", {})).toBe("control");
    expect(tier("ha_remove_todo_item", {}, ["light"])).toBe("change");
  });

  it("assumes an unknown tool changes something", () => {
    expect(tier("ha_frobnicate")).toBe("change");
  });
});

describe("needsApproval", () => {
  it("asks for changes and deletions by default, not for routine control", () => {
    expect(needsApproval("read", "change")).toBe(false);
    expect(needsApproval("control", "change")).toBe(false);
    expect(needsApproval("change", "change")).toBe(true);
    expect(needsApproval("destructive", "change")).toBe(true);
  });

  it("never asks about a read, at any level", () => {
    for (const level of ["control", "change", "destructive", "none"] as const) {
      expect(needsApproval("read", level)).toBe(false);
    }
  });

  it("asks about nothing at level none, and everything at level control", () => {
    expect(needsApproval("destructive", "none")).toBe(false);
    expect(needsApproval("control", "control")).toBe(true);
  });
});
