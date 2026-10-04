import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { HA_SERVER } from "./classify.js";

/**
 * The Home Assistant MCP server ([ha-mcp](https://github.com/homeassistant-ai/ha-mcp)),
 * run as a stdio subprocess of the agent.
 *
 * Defined here rather than read from any `.mcp.json`: `strictMcpConfig` in
 * agent/options.ts makes this the whole list. The token goes into this
 * server's environment and nowhere else — the agent's own environment
 * (config.ts `sanitizedEnv`) does not carry it, and the agent has no shell to
 * go looking for it.
 */
export function haServer(cfg: Config): Record<string, McpServerConfig> {
  if (!cfg.HOMEASSISTANT_URL || !cfg.HOMEASSISTANT_TOKEN) return {};
  return {
    [HA_SERVER]: {
      type: "stdio",
      command: cfg.HA_MCP_COMMAND,
      args: cfg.HA_MCP_ARGS.split(/\s+/).filter((a) => a.length > 0),
      env: {
        HOMEASSISTANT_URL: cfg.HOMEASSISTANT_URL,
        HOMEASSISTANT_TOKEN: cfg.HOMEASSISTANT_TOKEN,
        ENABLED_TOOL_MODULES: cfg.HA_MCP_ENABLED_TOOL_MODULES,
        // ha-mcp reads a .env from its working directory if one exists. Point
        // it at a path that never does, so nothing on the volume can override
        // what is set here.
        HAMCP_ENV_FILE: "/nonexistent/.env",
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
      },
    },
  };
}
