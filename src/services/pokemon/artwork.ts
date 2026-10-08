import { existsSync } from "node:fs";
import { join } from "node:path";
import type { OutgoingFile } from "../../bot/ports.js";

/**
 * Pokemon artwork taken from the game client's own assets
 * (core/client-legacy/data/images/pictures/<dex>.png, the Pokedex pictures).
 * Without a configured folder no artwork is shown; nothing is fetched from the internet.
 */
export class ArtworkResolver {
  private readonly cache = new Map<number, string | null>();

  constructor(private readonly directory: string | undefined) {}

  get enabled(): boolean {
    return this.directory !== undefined;
  }

  /** Attachment for the given national dex number, or undefined when there is no artwork. */
  resolve(dexNumber: number | null | undefined): OutgoingFile | undefined {
    if (!this.directory || dexNumber === null || dexNumber === undefined || !Number.isInteger(dexNumber) || dexNumber <= 0) {
      return undefined;
    }
    let path = this.cache.get(dexNumber);
    if (path === undefined) {
      const candidate = join(this.directory, `${dexNumber}.png`);
      path = existsSync(candidate) ? candidate : null;
      this.cache.set(dexNumber, path);
    }
    return path ? { name: `pokemon-${dexNumber}.png`, path } : undefined;
  }
}
