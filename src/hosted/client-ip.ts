/**
 * Strict parsing of the forwarded shopper IP (x-dinkus-client-ip) used as the
 * playground per-IP rate-limit key. No dependency: Workers-safe string parsing.
 *
 * - IPv4: exactly four dotted decimal octets 0..255, no leading zeros.
 * - IPv6: RFC 4291 text form, at most one "::", optional trailing dotted IPv4,
 *   no zone id. IPv4-mapped addresses (::ffff:a.b.c.d) are keyed as IPv4.
 * - Keys are canonical and lowercase; IPv6 is keyed by its /64 prefix so one
 *   end site cannot rotate addresses inside its own subnet to reset the limit.
 */
export const CLIENT_IP_MAX_LENGTH = 45;

function parseIpv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function parseIpv6(text: string): number[] | null {
  if (!/^[0-9a-f:.]+$/.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (side: string, allowIpv4Tail: boolean): number[] | null => {
    if (side === "") return [];
    const pieces = side.split(":");
    const groups: number[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      if (allowIpv4Tail && index === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseIpv4(piece);
        if (!v4) return null;
        groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  if (halves.length === 1) {
    const groups = toGroups(halves[0], true);
    return groups && groups.length === 8 ? groups : null;
  }
  const head = toGroups(halves[0], false);
  const tail = toGroups(halves[1], true);
  if (!head || !tail || head.length + tail.length > 7) return null;
  return [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
}

/** Returns the canonical rate-limit key, or null when the value is not a valid IP. */
export function clientIpRateKey(raw: string): string | null {
  if (raw.length === 0 || raw.length > CLIENT_IP_MAX_LENGTH) return null;
  const text = raw.toLowerCase();
  if (!text.includes(":")) {
    const v4 = parseIpv4(text);
    return v4 ? `v4:${v4.join(".")}` : null;
  }
  const groups = parseIpv6(text);
  if (!groups) return null;
  if (groups.slice(0, 5).every(value => value === 0) && groups[5] === 0xffff) {
    return `v4:${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  return `v6:${groups.slice(0, 4).map(value => value.toString(16)).join(":")}::/64`;
}
