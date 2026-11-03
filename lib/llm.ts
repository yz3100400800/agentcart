import { getLlmConfig } from "@/lib/config";

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type LlmToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type LlmMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; tool_calls: LlmToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type LlmTurn = {
  content: string | null;
  toolCalls: LlmToolCall[];
};

export type LlmClient = {
  complete(messages: LlmMessage[], tools: ToolDefinition[]): Promise<LlmTurn>;
};

export function createLlmClient(fetchImpl: typeof fetch = fetch): LlmClient {
  const config = getLlmConfig();
  return {
    async complete(messages, tools) {
      if (!config.apiKey) {
        throw new Error("LLM_API_KEY is not set.");
      }
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0.2,
          messages: messages.map(toApiMessage),
          tools: tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }),
        signal: AbortSignal.timeout(45_000),
      });
      const body = await readBody(response);
      if (!response.ok) {
        const message = errorMessage(body) || `The model request failed (${response.status}).`;
        throw new Error(message);
      }
      return parseTurn(body);
    },
  };
}

export function parseTurn(body: unknown): LlmTurn {
  const record = asRecord(body);
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const message = asRecord(asRecord(choices[0]).message);
  const content = typeof message.content === "string" ? message.content : null;
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: LlmToolCall[] = [];
  for (const call of rawCalls) {
    const recordCall = asRecord(call);
    const fn = asRecord(recordCall.function);
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;
    const id = typeof recordCall.id === "string" ? recordCall.id : crypto.randomUUID();
    let args = "{}";
    if (typeof fn.arguments === "string") args = fn.arguments;
    else if (fn.arguments && typeof fn.arguments === "object") args = JSON.stringify(fn.arguments);
    toolCalls.push({ id, name, arguments: args });
  }
  return { content, toolCalls };
}

function toApiMessage(message: LlmMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.tool_call_id, content: message.content };
  }
  if (message.role === "assistant" && "tool_calls" in message) {
    return {
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.tool_calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 400) };
  }
}

function errorMessage(body: unknown): string {
  const record = asRecord(body);
  const error = asRecord(record.error);
  if (typeof error.message === "string") return error.message;
  if (typeof record.message === "string") return record.message;
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
