import "server-only";
import { redis } from "@/server/infrastructure/events/bus";
import { env } from "@/server/config/env";

/**
 * Token-bucket rate limiter.
 *
 * Evaluated atomically in Redis so it holds across multiple app instances.
 * A broadcast consumes one user token per target device — otherwise the
 * per-user limit would be trivially bypassed by broadcasting.
 */
const SCRIPT = `
local now = tonumber(ARGV[1])
local userCap, userRate = tonumber(ARGV[2]), tonumber(ARGV[3])
local devCap,  devRate  = tonumber(ARGV[4]), tonumber(ARGV[5])

local function take(key, cap, rate)
  local h = redis.call('HMGET', key, 't', 's')
  local tokens = tonumber(h[1])
  local stamp  = tonumber(h[2])
  if tokens == nil then tokens = cap; stamp = now end
  tokens = math.min(cap, tokens + (now - stamp) / 1000.0 * rate)
  local ttl = math.ceil(cap / rate * 1000)
  if tokens < 1 then
    redis.call('HMSET', key, 't', tokens, 's', now)
    redis.call('PEXPIRE', key, ttl)
    return math.ceil((1 - tokens) / rate * 1000)
  end
  redis.call('HMSET', key, 't', tokens - 1, 's', now)
  redis.call('PEXPIRE', key, ttl)
  return 0
end

local out = {}
for i = 2, #KEYS do
  out[i - 1] = take(KEYS[i], devCap, devRate)
end
out[#KEYS] = take(KEYS[1], userCap, userRate)
return out
`;

export interface RateLimitResult {
  /** Device ids that may proceed. */
  allowed: string[];
  /** Device ids that were throttled, with the wait in milliseconds. */
  limited: { deviceId: string; retryAfterMs: number }[];
  /** Set when the per-user budget is exhausted. */
  userRetryAfterMs: number;
}

export async function checkCommandRateLimit(
  userId: string,
  deviceIds: string[],
): Promise<RateLimitResult> {
  const perMinute = env.COMMAND_RATE_LIMIT_PER_MINUTE;
  const userCap = perMinute;
  const userRate = perMinute / 60;
  const devCap = Math.max(2, Math.ceil(perMinute / 3));
  const devRate = Math.max(0.2, perMinute / 60 / 3);

  const keys = [
    `zenstier:rl:user:${userId}`,
    ...deviceIds.map((d) => `zenstier:rl:dev:${d}`),
  ];

  const raw = (await redis().eval(
    SCRIPT,
    keys.length,
    ...keys,
    Date.now().toString(),
    userCap.toString(),
    userRate.toString(),
    devCap.toString(),
    devRate.toString(),
  )) as (number | string)[];

  const results = raw.map((n) => Number(n));
  const userRetryAfterMs = results[results.length - 1] ?? 0;

  const allowed: string[] = [];
  const limited: { deviceId: string; retryAfterMs: number }[] = [];

  deviceIds.forEach((deviceId, i) => {
    const wait = results[i] ?? 0;
    if (wait > 0) limited.push({ deviceId, retryAfterMs: wait });
    else allowed.push(deviceId);
  });

  return {
    allowed: userRetryAfterMs > 0 ? [] : allowed,
    limited,
    userRetryAfterMs,
  };
}


/**
 * Generic fixed-window limiter for endpoints that are not command dispatch:
 * login attempts, enrollment, invite redemption.
 *
 * Evaluated atomically in Redis so it holds across app instances. Returns the
 * milliseconds to wait, or 0 when the caller may proceed.
 */
const WINDOW_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local current = redis.call('INCR', key)
if current == 1 then
  redis.call('PEXPIRE', key, windowMs)
end
if current > limit then
  local ttl = redis.call('PTTL', key)
  if ttl < 0 then ttl = windowMs end
  return ttl
end
return 0
`;

/**
 * Reads the current count WITHOUT consuming budget.
 *
 * Auth paths check first and only charge on failure, so a user signing in
 * successfully many times is never locked out.
 */
export async function isRateLimited(
  key: string,
  limit: number,
): Promise<boolean> {
  try {
    const current = await redis().get(`zenstier:rl:${key}`);
    return current !== null && Number(current) >= limit;
  } catch {
    // Fail closed on auth paths.
    return true;
  }
}

/** Clears a counter, e.g. after a successful sign-in. */
export async function resetRateLimit(key: string): Promise<void> {
  try {
    await redis().del(`zenstier:rl:${key}`);
  } catch {
    /* best effort */
  }
}

export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<number> {
  try {
    const wait = (await redis().eval(
      WINDOW_SCRIPT,
      1,
      `zenstier:rl:${key}`,
      limit.toString(),
      windowMs.toString(),
    )) as number | string;
    return Number(wait);
  } catch {
    // Fail CLOSED for auth paths: if the limiter is unavailable we would
    // rather reject than silently allow unlimited attempts.
    return windowMs;
  }
}

/** Best-effort client IP from common proxy headers. */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? "unknown";
}
