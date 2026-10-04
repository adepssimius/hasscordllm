import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError, credentialSource, loadConfig, requireDiscord } from "./config.js";
import { createLogger } from "./logger.js";
import { openStore } from "./store/index.js";
import { QuotaGuard } from "./quota/budget.js";
import { SessionManager, recoverInterrupted } from "./session/manager.js";
import { DiscordBot } from "./discord/bot.js";
import { Scheduler } from "./schedule/scheduler.js";
import { createServer } from "./http/server.js";
import { authorisesSomeone } from "./discord/authz.js";
import { haServer } from "./ha/mcp.js";
import { ensureHouse } from "./house.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger({ level: cfg.LOG_LEVEL, pretty: cfg.LOG_PRETTY });
  const creds = credentialSource(cfg);

  if (creds === "none") {
    log.error(
      "no Anthropic credentials configured — set CLAUDE_CODE_OAUTH_TOKEN " +
        "(generate with `claude setup-token`) or ANTHROPIC_API_KEY",
    );
    process.exit(1);
  }
  if (creds === "inherited-env") {
    log.warn("AGENT_INHERIT_ENV is on — dev only; the agent can read every env var this process holds");
  }

  // Either a channel of its own (Discord's permissions decide who is in it) or
  // an explicit allowlist. Neither would mean anyone on the server could spend
  // the subscription and work the house.
  if (
    !authorisesSomeone({
      userIds: cfg.DISCORD_CHAT_USER_IDS,
      roleIds: cfg.DISCORD_CHAT_ROLE_IDS,
      channelGated: cfg.DISCORD_CHAT_CHANNEL_IDS.length > 0,
    })
  ) {
    log.error("no DISCORD_CHAT_CHANNEL_IDS and no DISCORD_CHAT_USER_IDS / DISCORD_CHAT_ROLE_IDS — anyone could use this bot");
    process.exit(1);
  }

  const discord = requireDiscord();

  mkdirSync(dirname(cfg.sqlitePath), { recursive: true });
  const house = await ensureHouse(cfg);

  const store = openStore(cfg.sqlitePath);
  const quota = new QuotaGuard(cfg, log, store);

  // Without Home Assistant the bot still starts and says so in every answer
  // that needs it — a missing token is a configuration problem to report, not
  // a reason to crash-loop.
  const external = haServer(cfg);
  if (Object.keys(external).length === 0) {
    log.error("HOMEASSISTANT_URL or HOMEASSISTANT_TOKEN is unset — Home Assistant tools disabled");
  }

  const manager = new SessionManager({ cfg, log, store, external, quota });

  log.info(
    {
      model: cfg.AGENT_MODEL ?? "default",
      credentials: creds,
      homeAssistant: cfg.HOMEASSISTANT_URL ?? "disabled",
      haMcp: cfg.HA_MCP_COMMAND,
      approvalLevel: cfg.HA_APPROVAL_LEVEL,
      controlDomains: cfg.HA_CONTROL_DOMAINS.length,
      approvers:
        cfg.DISCORD_APPROVER_USER_IDS.length + cfg.DISCORD_APPROVER_ROLE_IDS.length || "same as chat",
      channels: cfg.DISCORD_CHAT_CHANNEL_IDS.length || "any",
      house: house.dir,
      houseNotesSeeded: house.seeded,
      db: cfg.sqlitePath,
      timeZone: cfg.BOT_TIMEZONE,
      turnsPerHour: cfg.AGENT_TURNS_PER_HOUR,
      maxConcurrent: cfg.AGENT_MAX_CONCURRENT_RUNS,
    },
    "hasscordllm starting",
  );

  // Recovery runs before the gateway connects, so nothing races it.
  const recovered = recoverInterrupted(store, log);

  const bot = new DiscordBot({ cfg, discord, log, store, manager });
  await bot.start(recovered.interrupted);

  const scheduler = new Scheduler(cfg, log, store, cfg.BOT_TIMEZONE, (s) => {
    void bot.postBrief(s).catch((e: unknown) => log.error({ err: e, schedule: s.name }, "brief failed"));
  });
  scheduler.start();

  // HTTP binds after Discord so /readyz is only green once the bot can be reached.
  const server = createServer({ quota, isReady: () => bot.isConnected() });
  server.listen(cfg.HTTP_PORT, cfg.HTTP_BIND, () => {
    log.info({ port: cfg.HTTP_PORT, bind: cfg.HTTP_BIND }, "http listening");
  });

  const shutdown = (signal: string): void => {
    log.info({ signal }, "shutting down");
    scheduler.stop();
    server.close();
    void bot
      .stop()
      .catch(() => undefined)
      .finally(() => {
        store.close();
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // A misconfigured environment is an operator error; a stack trace buries the
  // one line that says which variable is missing.
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err instanceof Error ? err.stack : String(err));
  }
  process.exit(1);
});
