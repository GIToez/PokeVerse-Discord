/** IPv4 helpers for the activity log. The game protocol only carries IPv4 addresses. */

export function parseIpv4(ip: string): [number, number, number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (!match) {
    return undefined;
  }
  const octets = match.slice(1).map(Number) as [number, number, number, number];
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

/**
 * Describes addresses that have no public location: loopback, private ranges,
 * carrier-grade NAT, link-local and other reserved blocks. Undefined for public addresses.
 */
export function nonPublicRange(ip: string): string | undefined {
  const octets = parseIpv4(ip);
  if (!octets) {
    return "not an IPv4 address";
  }
  const [a, b] = octets;
  if (a === 127) {
    return "this machine (loopback)";
  }
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return "private network";
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return "carrier-grade NAT (shared address)";
  }
  if (a === 169 && b === 254) {
    return "link-local";
  }
  if (a === 0 || a >= 224) {
    return "reserved address";
  }
  return undefined;
}

/** Keeps the first two octets: "203.0.113.45" -> "203.0.x.x". */
export function maskIp(ip: string | undefined): string {
  if (!ip) {
    return "unknown";
  }
  const octets = parseIpv4(ip);
  return octets ? `${octets[0]}.${octets[1]}.x.x` : "hidden";
}
