import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, sanitizedEnv } from "./config.js";

const env = (o: Record<string, string> = {}): NodeJS.ProcessEnv => ({ DATA_DIR: "/tmp/hass-test", ...o });

describe("loadConfig", () => {
  it("derives the database and house paths from DATA_DIR", () => {
    const c = loadConfig(env());
    expect(c.sqlitePath).toBe("/tmp/hass-test/hasscordllm.db");
    expect(c.houseDir).toBe("/tmp/hass-test/house");
  });

  it("asks for approval on changes by default, with locks and covers outside routine control", () => {
    const c = loadConfig(env());
    expect(c.HA_APPROVAL_LEVEL).toBe("change");
    expect(c.HA_CONTROL_DOMAINS).toContain("light");
    for (const d of ["lock", "cover", "alarm_control_panel", "script", "automation", "siren", "valve"]) {
      expect(c.HA_CONTROL_DOMAINS).not.toContain(d);
    }
  });

  it("reads lists, trimming and lower-casing domains", () => {
    const c = loadConfig(env({ HA_CONTROL_DOMAINS: " Light , switch,", DISCORD_APPROVER_USER_IDS: "1, 2" }));
    expect(c.HA_CONTROL_DOMAINS).toEqual(["light", "switch"]);
    expect(c.DISCORD_APPROVER_USER_IDS).toEqual(["1", "2"]);
  });

  it("treats an empty ConfigMap value as unset", () => {
    expect(loadConfig(env({ HOMEASSISTANT_URL: "" })).HOMEASSISTANT_URL).toBeUndefined();
  });

  it("refuses an approval level that does not exist", () => {
    expect(() => loadConfig(env({ HA_APPROVAL_LEVEL: "sometimes" }))).toThrow(ConfigError);
  });

  it("refuses a time zone that does not exist", () => {
    expect(() => loadConfig(env({ BOT_TIMEZONE: "Mars/Olympus" }))).toThrow(/BOT_TIMEZONE/);
  });

  it("has no shell among the default built-in tools", () => {
    expect(loadConfig(env()).AGENT_BUILTIN_TOOLS).not.toContain("Bash");
  });
});

describe("sanitizedEnv", () => {
  it("never carries the Discord or Home Assistant token", () => {
    const c = loadConfig(env({ HOMEASSISTANT_TOKEN: "ha-secret", CLAUDE_CODE_OAUTH_TOKEN: "oauth" }));
    const out = sanitizedEnv(c, {}, { PATH: "/bin", DISCORD_BOT_TOKEN: "discord-secret", HOMEASSISTANT_TOKEN: "ha-secret" });
    const all = JSON.stringify(out);
    expect(all).not.toContain("discord-secret");
    expect(all).not.toContain("ha-secret");
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth");
  });
});
