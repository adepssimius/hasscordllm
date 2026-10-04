# Deploying

hasscordllm is one container, one replica, one persistent volume. There is no
ingress. Its only way in is the Discord gateway, which it dials out to.

## What it needs

| | |
| --- | --- |
| **Image** | `ghcr.io/<owner>/hasscordllm:main-<run>-<sha>`, published by CI on every push to `main`. ha-mcp is baked in, pinned by the `HA_MCP_VERSION` build arg. |
| **Volume** | Mounted at `/data`, ReadWriteOnce. Holds the database, the house notes and the SDK transcripts. Small: 1–2Gi. |
| **`HOME`** | Must be on the volume (the image sets `/data/home`). Without it, threads forget everything on restart. |
| **`/tmp`** | Writable (an `emptyDir` if the root filesystem is read-only). |
| **Strategy** | `Recreate`. Two replicas would both answer every message. |
| **Egress** | Discord, `api.anthropic.com`, and Home Assistant. |
| **Probes** | `GET /healthz` (liveness), `GET /readyz` (ready once Discord is connected), `GET /metrics`. Port 8080. |
| **Kubernetes API** | None. Set `automountServiceAccountToken: false`. |

## Secrets

| Variable | |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token` |
| `DISCORD_BOT_TOKEN` | this bot's own application |
| `HOMEASSISTANT_TOKEN` | long-lived token for a dedicated `hasscordllm` HA user |

Everything else in [`.env.example`](../.env.example) is plain configuration.

## The reference deployment

The manifests for the author's cluster live in the GitOps repository
(`apps/hasscordllm/prod/`), not here. Flux's `ImageUpdateAutomation` rewrites
the image tag in place, so a copy here would drift. A merge to `main` here is
the deploy there.

## First start

1. The house directory is created and `CLAUDE.md` is seeded if it's missing.
2. If `HOMEASSISTANT_URL` or `HOMEASSISTANT_TOKEN` is unset, the bot logs an
   error and runs without Home Assistant tools, saying so when asked.
3. It connects to Discord, then starts the scheduler.

The startup log line `hasscordllm starting` states what it ended up with: the
HA URL, the approval level, how many routine domains, and who approves.

## Upgrading ha-mcp

Bump `HA_MCP_VERSION` in the Dockerfile and merge. Then check the new version's
tool list against [`src/ha/classify.ts`](../src/ha/classify.ts). A tool it
doesn't recognise counts as a *change*, which asks, unless its name follows
ha-mcp's read-only convention (`ha_get_*`, `ha_list_*`, `ha_config_get_*`,
`ha_config_list_*`). That convention is the one thing an upgrade could break
silently, so check that new tools with those prefixes really are read-only.
