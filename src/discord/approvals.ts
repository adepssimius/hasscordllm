import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type Interaction,
  type Message,
} from "discord.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { ApprovalAnswer, ApprovalRequest, Approver } from "../agent/approval.js";
import { checkActor, type AuthzConfig } from "./authz.js";
import { buildCard, outcomeLine, type Card } from "./approvalCard.js";

/**
 * Turns an approval request into a message with buttons, and a button press
 * back into an answer.
 *
 * The agent's tool call is parked inside canUseTool while this waits, so a
 * request always ends: approved, denied, timed out, or stopped with `stop`.
 * Every one of those leaves the card edited to say which, with the buttons
 * gone — a card that still offers Approve after the moment has passed is an
 * invitation to approve something that is no longer going to happen.
 */

const PREFIX = "hass-approval";
type Choice = "approve" | "rest" | "deny";

interface Pending {
  readonly sessionId: string;
  readonly card: Card;
  readonly timer: NodeJS.Timeout;
  readonly finish: (answer: ApprovalAnswer, line: string, color: number) => void;
  /** Records who pressed "approve rest of reply", for the turn's later calls. */
  readonly onRest: (by: string) => void;
}

/** What the desk needs to post a card. Threads and text channels both fit. */
export interface CardTarget {
  send(options: { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] }): Promise<Message>;
}

function embedFor(card: Card, footer?: string, color?: number): EmbedBuilder {
  const e = new EmbedBuilder()
    .setTitle(card.title)
    .setColor(color ?? card.color)
    .setDescription(`**${card.summary}**\n-# ${card.reason}\n${card.detail}`);
  // A mention inside an embed renders as the person's name without pinging them.
  if (footer) e.setFields({ name: "Outcome", value: footer });
  return e;
}

function buttons(id: string, card: Card): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}:${id}:approve`).setLabel("Approve").setStyle(ButtonStyle.Success),
  );
  if (card.offerApproveRest) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:${id}:rest`)
        .setLabel("Approve rest of reply")
        .setStyle(ButtonStyle.Primary),
    );
  }
  row.addComponents(new ButtonBuilder().setCustomId(`${PREFIX}:${id}:deny`).setLabel("Deny").setStyle(ButtonStyle.Danger));
  return row;
}

/** Role ids from either shape discord.js may hand over for an interaction's member. */
function memberRoles(member: Interaction["member"]): string[] {
  if (!member) return [];
  const roles = (member as { roles: unknown }).roles;
  if (Array.isArray(roles)) return roles.filter((r): r is string => typeof r === "string");
  const cache = (roles as { cache?: Map<string, unknown> } | undefined)?.cache;
  return cache ? [...cache.keys()] : [];
}

export class ApprovalDesk {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly deps: {
      readonly cfg: Config;
      readonly log: Logger;
    },
  ) {}

  /** Who may press Approve: the approver lists, or — both empty — whoever may chat. */
  private get authz(): AuthzConfig {
    const { cfg } = this.deps;
    const own = cfg.DISCORD_APPROVER_USER_IDS.length > 0 || cfg.DISCORD_APPROVER_ROLE_IDS.length > 0;
    return own
      ? { userIds: cfg.DISCORD_APPROVER_USER_IDS, roleIds: cfg.DISCORD_APPROVER_ROLE_IDS, channelGated: false }
      : {
          userIds: cfg.DISCORD_CHAT_USER_IDS,
          roleIds: cfg.DISCORD_CHAT_ROLE_IDS,
          channelGated: cfg.DISCORD_CHAT_CHANNEL_IDS.length > 0,
        };
  }

  /**
   * An approver for one turn in one thread. "Approve rest of reply" lasts
   * until the turn ends, which is when this closure is dropped — it never
   * carries into the next message.
   */
  approverFor(target: CardTarget, sessionId: string): Approver {
    let restApprovedBy: string | null = null;

    return async (req: ApprovalRequest, signal: AbortSignal): Promise<ApprovalAnswer> => {
      if (restApprovedBy && req.tier !== "destructive") {
        this.deps.log.info({ tool: req.toolName, by: restApprovedBy }, "covered by approve-rest");
        return { approved: true, by: restApprovedBy };
      }
      return this.ask(target, sessionId, req, signal, (by) => {
        restApprovedBy = by;
      });
    };
  }

  private async ask(
    target: CardTarget,
    sessionId: string,
    req: ApprovalRequest,
    signal: AbortSignal,
    onRest: (by: string) => void,
  ): Promise<ApprovalAnswer> {
    const { cfg, log } = this.deps;
    const id = randomUUID();
    const card = buildCard(req);

    let message: Message;
    try {
      message = await target.send({ embeds: [embedFor(card)], components: [buttons(id, card)] });
    } catch (e) {
      log.error({ err: e, tool: req.toolName }, "could not post an approval request");
      return { approved: false, by: null, reason: "the approval request could not be posted in Discord" };
    }

    return new Promise<ApprovalAnswer>((resolve) => {
      let done = false;
      const finish = (answer: ApprovalAnswer, line: string, color: number): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        void message.edit({ embeds: [embedFor(card, line, color)], components: [] }).catch(() => undefined);
        resolve(answer);
      };

      const minutes = Math.round(cfg.APPROVAL_TIMEOUT_MS / 60_000);
      const timer = setTimeout(
        () =>
          finish(
            { approved: false, by: null, reason: `nobody approved it within ${minutes} minutes` },
            outcomeLine({ kind: "timeout", minutes }),
            0x95a5a6,
          ),
        cfg.APPROVAL_TIMEOUT_MS,
      );
      timer.unref?.();

      const onAbort = (): void =>
        finish({ approved: false, by: null, reason: "the run was stopped" }, outcomeLine({ kind: "stopped" }), 0x95a5a6);
      signal.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, { sessionId, card, timer, finish, onRest });
    });
  }

  /** `stop` in the thread: every card waiting in that session ends as stopped. */
  cancelSession(sessionId: string): void {
    for (const p of [...this.pending.values()]) {
      if (p.sessionId === sessionId) {
        p.finish({ approved: false, by: null, reason: "the run was stopped" }, outcomeLine({ kind: "stopped" }), 0x95a5a6);
      }
    }
  }

  /** True when the interaction was one of ours (whether or not it was allowed). */
  async handle(interaction: Interaction): Promise<boolean> {
    if (!interaction.isButton() || !interaction.customId.startsWith(`${PREFIX}:`)) return false;
    const [, id = "", choice = ""] = interaction.customId.split(":");
    await this.press(interaction, id, choice as Choice);
    return true;
  }

  private async press(interaction: ButtonInteraction, id: string, choice: Choice): Promise<void> {
    const { log } = this.deps;
    const p = this.pending.get(id);
    if (!p) {
      await interaction
        .reply({ content: "That request is no longer waiting — it was already answered, timed out, or the bot restarted.", flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
      return;
    }

    const who = checkActor(this.authz, { userId: interaction.user.id, roleIds: memberRoles(interaction.member) });
    if (!who.allowed) {
      log.warn({ user: interaction.user.id, request: id }, "approval pressed by someone who may not approve");
      await interaction
        .reply({ content: "You're not on the list of people who can approve changes.", flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
      return;
    }

    // Acknowledge first: Discord fails the interaction after three seconds.
    await interaction.deferUpdate().catch(() => undefined);
    const by = interaction.user.id;

    if (choice === "deny") {
      p.finish({ approved: false, by, reason: "the person denied it" }, outcomeLine({ kind: "denied", by }), 0xe74c3c);
      return;
    }
    if (choice === "rest" && p.card.offerApproveRest) {
      p.onRest(by);
      p.finish({ approved: true, by }, outcomeLine({ kind: "approved", by, rest: true }), 0x2ecc71);
      return;
    }
    p.finish({ approved: true, by }, outcomeLine({ kind: "approved", by }), 0x2ecc71);
  }
}
