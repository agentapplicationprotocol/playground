import type { HistoryMessage } from "@agentapplicationprotocol/core";
import type { ClientTool } from "./ToolManager";

export interface ToolCallRecord {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  thinking?: string;
  content: string;
  images?: string[];
  toolCalls?: ToolCallRecord[];
  streaming?: boolean;
}

export interface PermissionRequest {
  toolName: string;
  toolType: "client" | "server";
  input: Record<string, unknown>;
  resolve: (granted: boolean) => void;
}

export function extractContent(messages: HistoryMessage[]): {
  text: string;
  thinking: string;
  images: string[];
} {
  let text = "",
    thinking = "";
  const images: string[] = [];
  for (const m of messages) {
    if (!("content" in m)) continue;
    const blocks =
      typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === "text") text += (text ? "\n" : "") + b.text;
      else if (b.type === "thinking") thinking += (thinking ? "\n" : "") + b.thinking;
      else if (b.type === "image") images.push(b.url);
    }
  }
  return { text, thinking, images };
}

export function historyToChatMessages(history: HistoryMessage[]): ChatMessage[] {
  // Build a map of toolCallId -> result from tool messages
  const toolResults = new Map<string, string>();
  for (const m of history) {
    if (m.role === "tool") {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      toolResults.set(m.toolCallId, content);
    }
  }

  const chatMessages: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === "user") {
      const content =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((b) => b.type === "text")
              .map((b) => (b as { type: "text"; text: string }).text)
              .join("\n");
      chatMessages.push({ role: "user", content });
    } else if (m.role === "assistant") {
      const { text, thinking, images } = extractContent([m]);
      const toolCalls: ToolCallRecord[] = (Array.isArray(m.content) ? m.content : [])
        .filter(
          (
            b,
          ): b is {
            type: "tool_use";
            toolCallId: string;
            name: string;
            input: Record<string, unknown>;
          } => (b as { type: string }).type === "tool_use",
        )
        .map(({ toolCallId, name, input }) => ({
          toolCallId,
          name,
          input,
          ...(toolResults.has(toolCallId) ? { result: toolResults.get(toolCallId) } : {}),
        }));
      chatMessages.push({
        role: "assistant",
        content: text,
        ...(thinking ? { thinking } : {}),
        ...(images.length ? { images } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    }
  }
  return chatMessages;
}

export function getOptionsToSend(
  options: Record<string, string>,
  lastSent: Record<string, string> | null,
  isNewSession: boolean,
): Record<string, string> | undefined {
  if (isNewSession) {
    return Object.keys(options).length ? options : undefined;
  }
  const changed = Object.fromEntries(
    Object.entries(options).filter(([k, v]) => lastSent?.[k] !== v),
  );
  return Object.keys(changed).length ? changed : undefined;
}

export function runTool(tool: ClientTool, input: Record<string, unknown>): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return String(new Function("input", tool.code)(input));
  } catch (e) {
    return `Error: ${e}`;
  }
}
