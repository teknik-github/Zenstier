import "server-only";
import { env, isAiConfigured } from "@/server/config/env";
import { logger } from "@/server/infrastructure/logger/logger";
import { SYSTEM_PROMPT } from "./prompts";
import {
  buildDeviceRoster,
  buildHistoryContext,
  buildMetricsSnapshot,
} from "./context";

const log = logger.child({ module: "ai" });

export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiError";
  }
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// Generous, because truncating shifts the cached prefix and forces a re-read
// of the whole conversation.
const MAX_HISTORY_TURNS = 24;
const MAX_MESSAGE_CHARS = 4000;

/**
 * Streams a completion from any OpenAI-compatible endpoint.
 *
 * Kept to plain fetch rather than a vendor SDK so swapping DeepSeek for
 * OpenAI, Ollama or vLLM is a change of base URL, not of code.
 */
export async function* streamChat(
  teamId: string,
  deviceIds: string[],
  history: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (!isAiConfigured) {
    throw new AiError(
      "No AI provider is configured. Set AI_API_KEY (and optionally AI_BASE_URL / AI_MODEL) in .env",
    );
  }

  const [roster, metrics, recent] = await Promise.all([
    buildDeviceRoster(teamId, deviceIds),
    buildMetricsSnapshot(teamId, deviceIds),
    buildHistoryContext(teamId, deviceIds),
  ]);

  /*
   * Message order is chosen for prefix caching, which providers key on the
   * longest identical leading run of tokens.
   *
   *   [0]    system prompt   — identical for every request, everywhere
   *   [1]    device roster   — stable for a team; excludes metrics on purpose
   *   [2..N] conversation    — byte-identical and append-only, so the cached
   *                            prefix grows with the conversation
   *   [N+1]  volatile block  — metrics and recent output, LAST so it can only
   *                            invalidate itself
   *
   * Two layouts look reasonable and both destroy the cache. Putting the
   * volatile block near the front makes every request a miss from position 1
   * onward. Appending it to the newest user turn is worse in a subtle way:
   * that turn becomes history on the next request, where it no longer carries
   * the block, so its bytes differ and the prefix breaks mid-conversation.
   */
  const turns = history.slice(-MAX_HISTORY_TURNS).map((m) => ({
    role: m.role,
    content: m.content.slice(0, MAX_MESSAGE_CHARS),
  }));

  const volatileBlock = [metrics, recent].filter(Boolean).join("\n\n");

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "system" as const, content: roster },
    ...turns,
    ...(volatileBlock
      ? [
          {
            role: "system" as const,
            content: `Live context as of this request:\n\n${volatileBlock}`,
          },
        ]
      : []),
  ];

  const url = `${env.AI_BASE_URL.replace(/\/$/, "")}/v1/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        messages,
        stream: true,
        // Ask for usage on the final chunk so cache effectiveness is visible.
        stream_options: { include_usage: true },
        temperature: 0.2,
        max_tokens: env.AI_MAX_OUTPUT_TOKENS,
      }),
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") return;
    throw new AiError(`Could not reach the AI provider: ${String(err)}`);
  }

  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    log.error("ai provider rejected the request", {
      status: response.status,
      detail: detail.slice(0, 300),
    });
    // Never surface the provider's raw body: it can echo the API key back.
    throw new AiError(
      `AI provider returned ${response.status}. Check AI_API_KEY, AI_BASE_URL and AI_MODEL.`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a chunk can split one.
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);

          // Arrives on the final chunk when include_usage is set.
          const usage = parsed?.usage;
          if (usage) {
            const hit = usage.prompt_cache_hit_tokens ?? 0;
            const total = usage.prompt_tokens ?? 0;
            log.info("ai usage", {
              model: env.AI_MODEL,
              promptTokens: total,
              completionTokens: usage.completion_tokens ?? 0,
              cachedTokens: hit,
              cacheHitRate: total ? `${Math.round((hit / total) * 100)}%` : "0%",
            });
          }

          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) yield delta;
        } catch {
          // A partial or non-JSON keepalive frame; ignore it.
        }
      }
    }
  }
}

/** Commands the assistant proposed, extracted from ```sh fences. */
export function extractProposedCommands(markdown: string): string[] {
  const out: string[] = [];
  const fence = /```(?:sh|bash|shell)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(markdown)) !== null) {
    const body = match[1]?.trim();
    if (body) out.push(body);
  }
  return out;
}
