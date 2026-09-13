import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { env } from "@/server/config/env";

/**
 * Guards outbound requests to operator-supplied URLs.
 *
 * A webhook URL is attacker-controlled in the sense that matters: setting one
 * needs only `device:update`, and a team Owner is not the server
 * administrator. Someone invited to Zenstier who creates their own team can
 * reach that level, and would otherwise be able to make the server POST to its
 * own network — cloud metadata at 169.254.169.254, an internal admin API, a
 * database port. `sendTestNotification` returning the HTTP status turns that
 * from blind into a usable service scanner.
 *
 * The check runs at request time rather than only on save, because DNS can
 * change between the two (rebinding), and redirects are not followed so a 302
 * cannot land somewhere the original host would not.
 */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/** CIDR blocks that must never be reachable from a user-supplied URL. */
const BLOCKED_V4: [string, number, string][] = [
  ["0.0.0.0", 8, "this host"],
  ["10.0.0.0", 8, "private network"],
  ["100.64.0.0", 10, "carrier-grade NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local / cloud metadata"],
  ["172.16.0.0", 12, "private network"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["192.168.0.0", 16, "private network"],
  ["198.18.0.0", 15, "benchmarking"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

function describeBlockedV4(ip: string): string | null {
  const value = ipv4ToInt(ip);
  if (value === null) return "malformed address";
  for (const [base, bits, label] of BLOCKED_V4) {
    const baseValue = ipv4ToInt(base)!;
    const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
    if ((value & mask) === (baseValue & mask)) return label;
  }
  return null;
}

function describeBlockedV6(ip: string): string | null {
  const address = ip.toLowerCase().split("%")[0]!;
  if (address === "::" || address === "::1") return "loopback";

  // IPv4-mapped addresses must be judged by their IPv4 value. Both spellings
  // have to be handled: WHATWG URL parsing rewrites ::ffff:127.0.0.1 into the
  // hex form ::ffff:7f00:1, so matching only the dotted form lets loopback and
  // cloud metadata straight through.
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return describeBlockedV4(dotted[1]!);

  const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    const ipv4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
    return describeBlockedV4(ipv4);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return "unique-local";
  if (/^fe[89ab][0-9a-f]:/.test(address)) return "link-local";
  if (address.startsWith("ff")) return "multicast";
  return null;
}

export function describeBlockedAddress(ip: string): string | null {
  const family = isIP(ip);
  if (family === 4) return describeBlockedV4(ip);
  if (family === 6) return describeBlockedV6(ip);
  return "malformed address";
}

/**
 * Validates a URL and resolves it, rejecting anything internal.
 *
 * Returns the parsed URL so callers do not re-parse and risk disagreeing with
 * what was checked.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("That is not a valid URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError("Only http:// and https:// URLs are allowed");
  }
  // Credentials in a webhook URL are almost always an attempt to reach
  // something that should not be reachable.
  if (url.username || url.password) {
    throw new BlockedUrlError("Credentials in the URL are not allowed");
  }

  // Self-hosters legitimately post to a Mattermost or Gotify on their own LAN,
  // so this is an explicit opt-in rather than a silent block.
  if (env.ALLOW_PRIVATE_WEBHOOKS) return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (isIP(host)) {
    const reason = describeBlockedAddress(host);
    if (reason) {
      throw new BlockedUrlError(`That address is not allowed (${reason})`);
    }
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BlockedUrlError(`Could not resolve ${host}`);
  }
  if (addresses.length === 0) {
    throw new BlockedUrlError(`Could not resolve ${host}`);
  }

  // Every resolved address must be acceptable: one internal A record is
  // enough to make the request internal.
  for (const { address } of addresses) {
    const reason = describeBlockedAddress(address);
    if (reason) {
      throw new BlockedUrlError(
        `${host} resolves to an internal address (${reason})`,
      );
    }
  }

  return url;
}

/**
 * `fetch` for operator-supplied URLs.
 *
 * Redirects are never followed: a 302 to 169.254.169.254 would otherwise walk
 * straight past the check above.
 */
export async function safeFetch(
  raw: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const url = await assertPublicUrl(raw);
  const { timeoutMs = 8000, ...rest } = init;
  return fetch(url, {
    ...rest,
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
}
