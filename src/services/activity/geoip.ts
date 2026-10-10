import { readFileSync } from "node:fs";
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

/**
 * Approximate location from a local MaxMind-format database (GeoLite2 City/Country,
 * DB-IP Lite, ...). Lookups never leave the machine; without a database the activity log
 * shows no location. Locations are approximate and often wrong for VPNs and mobile networks.
 */
export class GeoIp {
  private constructor(
    private readonly reader: Reader<Response> | undefined,
    readonly description: string,
  ) {}

  static disabled(): GeoIp {
    return new GeoIp(undefined, "disabled");
  }

  /** Opens the database; logs and falls back to "disabled" when it cannot be read. */
  static open(path: string | undefined, logger: Logger): GeoIp {
    if (!path) {
      return GeoIp.disabled();
    }
    try {
      const reader = new Reader<Response>(readFileSync(path));
      const description = `${reader.metadata.databaseType} (${reader.metadata.buildEpoch.toISOString().slice(0, 10)})`;
      logger.info("GeoIP database loaded", { database: description });
      return new GeoIp(reader, description);
    } catch (error) {
      logger.error("Could not open the GeoIP database; locations are disabled", { path, error: (error as Error).message });
      return GeoIp.disabled();
    }
  }

  get enabled(): boolean {
    return this.reader !== undefined;
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
