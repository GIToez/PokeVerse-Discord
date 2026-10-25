import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { Reader, type Response } from "mmdb-lib";
import type { Logger } from "../../utils/logger.js";
import { nonPublicRange } from "./ip.js";

export interface GeoResult {
  /** Text for the activity log, e.g. "Lyon, Auvergne-Rhone-Alpes, France". */
  label: string;
  /** True when the address is not public (no lookup was made). */
  nonPublic: boolean;
  /** Set when the database marks the address as an anonymous proxy, VPN or hosting network. */
  anonymizer?: string;
}

interface Named {
  names?: Record<string, string>;
}

interface GeoRecord {
  city?: Named;
  subdivisions?: Named[];
  country?: Named & { iso_code?: string };
  registered_country?: Named & { iso_code?: string };
  traits?: { is_anonymous_proxy?: boolean; is_anonymous_vpn?: boolean; is_hosting_provider?: boolean; is_tor_exit_node?: boolean };
  autonomous_system_organization?: string;
}

/** DB-IP's free databases are CC BY 4.0: wherever their locations are shown, DB-IP is credited. */
export const DBIP_ATTRIBUTION = "IP geolocation by DB-IP (db-ip.com)";

/**
 * Approximate location from a local MaxMind-format database (GeoLite2 City/Country,
 * DB-IP Lite, ...). Lookups never leave the machine; without a database the activity log
 * shows no location. Locations are approximate and often wrong for VPNs and mobile networks.
 * A replaced file is picked up by `reloadIfChanged`, so a monthly refresh needs no restart.
 */
export class GeoIp {
  private reader: Reader<Response> | undefined;
  private modifiedMs = 0;
  /** e.g. "DBIP-City-Lite (2026-10-01)", or "disabled". */
  description = "disabled";
  /** Credit to show next to the locations, when the database's licence asks for one. */
  attribution: string | undefined;
  /** When the loaded database was built. */
  builtAt: Date | undefined;

  private constructor(
    private readonly path: string | undefined,
    private readonly logger: Logger | undefined,
  ) {}

  static disabled(): GeoIp {
    return new GeoIp(undefined, undefined);
  }

  /** Opens the database; logs and falls back to "disabled" when it cannot be read. */
  static open(path: string | undefined, logger: Logger): GeoIp {
    const geo = new GeoIp(path, logger);
    const error = path ? geo.load() : undefined;
    if (error) {
      logger.error("Could not open the GeoIP database; locations are disabled", { path, error });
    }
    return geo;
  }

  get enabled(): boolean {
    return this.reader !== undefined;
  }

  /**
   * Reloads the database when its file changed (a monthly download). A file that can't be read
   * keeps the database already loaded. Returns true when a new database was loaded.
   */
  reloadIfChanged(): boolean {
    if (!this.path) {
      return false;
    }
    let modifiedMs: number;
    try {
      modifiedMs = statSync(this.path).mtimeMs;
    } catch {
      return false;
    }
    if (modifiedMs === this.modifiedMs) {
      return false;
    }
    const error = this.load();
    if (error) {
      this.modifiedMs = modifiedMs;
      this.logger?.warn("The GeoIP database file changed but can't be read; keeping the one loaded", {
        path: this.path, database: this.description, error,
      });
      return false;
    }
    return true;
  }

  /** Undefined when loaded, otherwise why not. */
  private load(): string | undefined {
    if (!this.path) {
      return "no path";
    }
    try {
      const modifiedMs = statSync(this.path).mtimeMs;
      const reader = new Reader<Response>(readFileSync(this.path));
      const type = reader.metadata.databaseType;
      this.reader = reader;
      this.modifiedMs = modifiedMs;
      this.builtAt = reader.metadata.buildEpoch;
      this.description = `${type} (${reader.metadata.buildEpoch.toISOString().slice(0, 10)})`;
      this.attribution = /db-?ip/i.test(type) || /db-?ip/i.test(basename(this.path)) ? DBIP_ATTRIBUTION : undefined;
      this.logger?.info("GeoIP database loaded", { database: this.description });
      return undefined;
    } catch (error) {
      return (error as Error).message;
    }
  }

  lookup(ip: string | undefined): GeoResult | undefined {
    if (!ip) {
      return undefined;
    }
    const range = nonPublicRange(ip);
    if (range) {
      return { label: `No location (${range})`, nonPublic: true };
    }
    if (!this.reader) {
      return undefined;
    }
    let record: GeoRecord | null;
    try {
      record = this.reader.get(ip) as GeoRecord | null;
    } catch {
      return undefined;
    }
    if (!record) {
      return { label: "Unknown location", nonPublic: false };
    }
    const english = (named: Named | undefined) => named?.names?.en;
    const parts = [english(record.city), english(record.subdivisions?.[0]), english(record.country) ?? english(record.registered_country)]
      .filter((part): part is string => Boolean(part));
    const label = parts.length > 0 ? parts.join(", ") : record.autonomous_system_organization ?? "Unknown location";
    const traits = record.traits ?? {};
    const anonymizer = traits.is_tor_exit_node
      ? "Tor exit node"
      : traits.is_anonymous_vpn
        ? "VPN"
        : traits.is_anonymous_proxy
          ? "anonymous proxy"
          : traits.is_hosting_provider
            ? "hosting provider"
            : undefined;
    return anonymizer ? { label, nonPublic: false, anonymizer } : { label, nonPublic: false };
  }
}
