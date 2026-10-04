# hasscordllm

Claude, in Discord, looking after your Home Assistant. Self-hosted.

You mention the bot in a channel and it opens a thread. In the thread it can see
the whole house through [ha-mcp](https://github.com/homeassistant-ai/ha-mcp):
entities, history, areas, devices, automations, scripts, scenes, dashboards,
logs and traces. Ask *"why did the hall light come on at 3am?"*, *"which
batteries are low?"*, or *"make the porch light come on at sunset"*. It
explores freely. Before it changes anything that matters, it posts the exact
change with **Approve** and **Deny** buttons and waits for you.

Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), in
the same shape as fitcordllm and disk8sllm.

## Approval

Every Home Assistant tool call is sorted into a tier
([`src/ha/classify.ts`](src/ha/classify.ts)):

| Tier | What | At the default level |
| --- | --- | --- |
| **read** | state, history, search, configs, logs, traces | goes straight through |
| **control** | services in a routine domain: lights, switches, media, scenes, climate, the to-do list | goes straight through |
| **change** | configuration (automations, scripts, scenes, helpers, dashboards, entity settings), and control of anything *outside* the routine domains: locks, covers and garage doors, alarms, running a script | **waits for Approve** |
| **destructive** | deletes, `ha_restart`, backup restores, update and HACS installs, the add-on API escape hatch | **waits for Approve** |

`HA_APPROVAL_LEVEL` moves the line (`control` / `change` / `destructive` /
`none`), and `HA_CONTROL_DOMAINS` decides what counts as routine. A service
call is judged by its own domain **and** every entity it targets, so
`homeassistant.turn_on` aimed at a lock is treated as working a lock. Anything
the classifier doesn't recognise, such as a new ha-mcp tool or an unfamiliar
`action` value, counts as a change.

The card shows a one-line summary (*Call `lock.unlock` on `lock.front_door`*),
why it was asked, and the exact input. It offers three buttons:

- **Approve**: this call goes ahead.
- **Approve rest of reply**: this call and the rest of this reply's non-destructive
  calls. It ends when the reply does, and it is never offered on a destructive call.
- **Deny**: nothing happens. The agent is told not to reach the same result some
  other way.

An unanswered card counts as a refusal after `APPROVAL_TIMEOUT_MS` (15 minutes).
`stop` in the thread ends any waiting card. Only people on
`DISCORD_APPROVER_USER_IDS` / `ROLE_IDS` can press the buttons. With both
empty, anyone allowed to chat can. Every decision is recorded in the
`approvals` table with who made it.

Why it can't be skipped: the approval happens in the SDK's `canUseTool`, and
`allowedTools` is empty, so no HA tool is pre-approved. The `PreToolUse` gate
also answers `ask` for any call that needs approval. That forces the prompt
even if Claude Code would otherwise have let an MCP tool through on its own.

## Scheduled briefs

Ask in a thread: *"every morning at 7, tell me anything unusual: open doors,
unavailable devices, low batteries"*. The prompt runs on schedule in a fresh
conversation, and the answer is posted to the channel. Reply to it or start a
thread from it to continue.

**A scheduled run only looks.** Every HA call that isn't a read is refused,
whatever the approval level, because nobody is there to approve it. Anything
that should *happen* on a schedule belongs in a Home Assistant automation, which
the agent will offer to write.

Mention the bot with `schedules` to list them, or `threads` to list recent
conversations.

## House notes

The agent's working directory is `DATA_DIR/house`, shared by every thread. Its
`CLAUDE.md` is the house notes. Claude Code loads that file into every
conversation, and the agent keeps it current: what people call things ("the big
lamp" is `light.living_room_floor`), whose room is whose, flaky devices,
decisions and why. It's seeded empty on first start. Pasting in what you
already know is a good first message.

## What the agent can and cannot do

- **Home Assistant**, through ha-mcp, under the approval rules above.
- **Files**: Read, Write and Edit, confined to the house directory and `/tmp`. A
  `PreToolUse` gate refuses anything else, including the database and
  `/proc/*/environ`.
- **Web search.** No `WebFetch`, no subagents.
- **No shell.** That's what keeps the Home Assistant token away from the agent.
  The token is in the ha-mcp subprocess's environment only, not the agent's
  ([`sanitizedEnv`](src/config.ts)). With a shell, the agent could read it out of
  `/proc`.
- **Only the MCP servers the bot defines.** `strictMcpConfig` is on.

What it *can* reach, and you should know it: the Anthropic credential (the
agent subprocess is what uses it), and everything the Home Assistant token can
do, subject to approval. ha-mcp can read HA's config files, `secrets.yaml`
included, if the filesystem tools are available on your install. Use a
dedicated HA user, so its changes are attributed and its token can be revoked
on its own.

## Running it

### Discord

1. Create a **new** application and bot. Don't reuse another bot's token: two
   processes on one token both receive every message.
2. **Enable the Message Content privileged intent.**
3. Invite it with `View Channel`, `Send Messages`, `Create Public Threads`,
   `Send Messages in Threads`, `Add Reactions`, `Read Message History`,
   `Embed Links`, and `Create Polls`.
4. Give it a private channel: `DISCORD_CHAT_CHANNEL_IDS`. Startup refuses to run
   with neither a channel nor an allowlist.

### Home Assistant

Create a user called `hasscordllm` (administrator, if it is to edit
automations). Log in as it and make a long-lived access token. That token is
`HOMEASSISTANT_TOKEN`.

### Configuration

Everything is environment variables. [`.env.example`](.env.example) lists them.
The essentials:

| Variable | |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | from `claude setup-token` |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_CHAT_CHANNEL_IDS` | |
| `HOMEASSISTANT_URL`, `HOMEASSISTANT_TOKEN` | |
| `DATA_DIR`, `HOME` | both on persistent storage |

[`deploy/README.md`](deploy/README.md) describes the Kubernetes shape.

## Local development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

`pnpm chat` runs the same session manager, policy and tools from stdin, with no
Discord needed. Approval cards are printed. `CHAT_APPROVE=never` (the default)
refuses every change that needs approval, so exploring is safe.
`CHAT_APPROVE=always` lets them through.

```bash
DATA_DIR="$PWD/.local" AGENT_INHERIT_ENV=true \
HOMEASSISTANT_URL=https://hass.example HOMEASSISTANT_TOKEN=… \
HA_MCP_COMMAND=uvx HA_MCP_ARGS="--python 3.13 --from ha-mcp==8.6.0 ha-mcp" \
  pnpm chat
```

(`AGENT_INHERIT_ENV=true` uses your own Claude Code login. Leave `HOME` alone
when you set it.)

## Quota

Turns bill against the Claude subscription. Three guards: an hourly SDK-turn
budget (`AGENT_TURNS_PER_HOUR`), a concurrency cap that drops to 1 under
pressure, and a cooldown driven by the SDK's own rate-limit events. Scheduled
briefs draw on the same budget.
