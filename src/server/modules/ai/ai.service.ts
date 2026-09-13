import "server-only";
import { env, isAiConfigured } from "@/server/config/env";
import { logger } from "@/server/infrastructure/logger/logger";
import { SYSTEM_PROMPT } from "./prompts";
import { buildFleetContext, buildHistoryContext } from "./context";

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

const MAX_HISTORY_TURNS = 12;
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

  const [fleet, recent] = await Promise.all([
    buildFleetContext(teamId, deviceIds),
    buildHistoryContext(teamId, deviceIds),
  ]);

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    {
      role: "system" as const,
      content: [fleet, recent].filter(Boolean).join("\n\n"),
    },
    ...history.slice(-MAX_HISTORY_TURNS).map((m) => ({
      role: m.role,
      content: m.content.slice(0, MAX_MESSAGE_CHARS),
    })),
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
