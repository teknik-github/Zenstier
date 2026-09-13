import "server-only";
import { z } from "zod";

/**
 * Validated process environment.
 *
 * Parsed once at module load. Importing this module from a Client Component is
 * a build error thanks to `server-only`, so secrets can never leak into the
 * browser bundle.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 chars"),
  AUTH_URL: z.string().url().optional(),

  MQTT_URL: z.string().min(1).default("mqtt://localhost:1883"),
  MQTT_BACKEND_USERNAME: z.string().min(1),
  MQTT_BACKEND_PASSWORD: z.string().min(1),
  MQTT_CA_FILE: z.string().optional(),

  MQTT_ADMIN_USERNAME: z.string().min(1),
  MQTT_ADMIN_PASSWORD: z.string().min(1),

  MQTT_PROVISIONER_USERNAME: z.string().min(1),
  MQTT_PROVISIONER_PASSWORD: z.string().min(1),

  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),

  AGENT_MQTT_HOST: z.string().min(1).default("localhost"),
  AGENT_MQTT_PORT: z.coerce.number().int().positive().default(8883),

  COMMAND_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),

  /**
   * AI console. Any OpenAI-compatible endpoint works — DeepSeek, OpenAI,
   * Ollama, vLLM — so the provider is a deployment choice, not a code change.
   * Leaving AI_API_KEY unset simply disables the feature.
   */
  AI_BASE_URL: z.string().min(1).default("https://api.deepseek.com"),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().min(1).default("deepseek-chat"),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(1500),
  AI_RATE_LIMIT_PER_HOUR: z.coerce.number().int().positive().default(60),

  /**
   * Public sign-up. Off by default: this tool executes root commands, so an
   * open registration form is a liability. Accounts are created with
   * `pnpm user:create`, or by accepting an invite.
   */
  ALLOW_PUBLIC_REGISTRATION: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * Metric retention. Raw samples arrive every 30s per device, so without
   * pruning the table grows without bound — roughly 92M rows a year at 100
   * devices. Raw data is rolled up hourly, then deleted.
   */
  METRICS_RAW_RETENTION_HOURS: z.coerce.number().int().positive().default(48),
  METRICS_HOURLY_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  /**
   * Telegram API base. Overridable because the official host is blocked in
   * several countries and operators there run a mirror or egress proxy.
   */
  TELEGRAM_API_BASE: z.string().min(1).default("https://api.telegram.org"),

  /** Disables the MQTT worker; useful for `next build` and unit tests. */
  ZENSTIER_DISABLE_WORKER: z
    .union([z.literal("1"), z.literal("true")])
    .optional(),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === "production";

/** The AI console is only offered when a provider is actually configured. */
export const isAiConfigured = Boolean(env.AI_API_KEY);
export const isDevelopment = env.NODE_ENV === "development";
