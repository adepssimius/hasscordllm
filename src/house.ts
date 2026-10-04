import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";

/**
 * The house directory: the agent's working directory, shared by every thread.
 *
 * Its CLAUDE.md is the house notes. Claude Code loads a project CLAUDE.md
 * into every session by itself, so whatever the agent writes there — what
 * "the big lamp" means, whose room is whose — is known in the next thread
 * without anyone repeating it. Seeded once; never overwritten afterwards.
 */

export const NOTES_FILE = "CLAUDE.md";

export const NOTES_SEED = `# House notes

Kept by hasscordllm. Loaded into every conversation. Short, current, no secrets.

## People and rooms

## What things are called

## Conventions

## Known quirks

## Decisions
`;

export async function ensureHouse(cfg: Config): Promise<{ dir: string; seeded: boolean }> {
  const dir = cfg.houseDir;
  await mkdir(dir, { recursive: true });
  const notes = join(dir, NOTES_FILE);
  try {
    await access(notes);
    return { dir, seeded: false };
  } catch {
    // `wx`: if two processes race, the loser fails instead of clobbering.
    await writeFile(notes, NOTES_SEED, { flag: "wx" }).catch(() => undefined);
    return { dir, seeded: true };
  }
}
