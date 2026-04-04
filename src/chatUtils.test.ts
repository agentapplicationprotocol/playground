import { describe, it, expect } from "vitest";
import {
  extractContent,
  historyToChatMessages,
  getOptionsToSend,
  runTool,
  pickHistoryMode,
} from "./chatUtils";
import type { HistoryMessage } from "@agentapplicationprotocol/core";
import type { ClientTool } from "./ToolManager";

describe("extractContent", () => {
  it("extracts text from string content", () => {
    const msgs: HistoryMessage[] = [{ role: "assistant", content: "hello" }];
    expect(extractContent(msgs)).toEqual({ text: "hello", thinking: "", images: [] });
  });

  it("concatenates multiple text blocks with newline", () => {
    const msgs: HistoryMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ];
    expect(extractContent(msgs).text).toBe("a\nb");
  });

  it("extracts thinking blocks", () => {
    const msgs: HistoryMessage[] = [
      { role: "assistant", content: [{ type: "thinking", thinking: "deep thought" }] },
    ];
    expect(extractContent(msgs).thinking).toBe("deep thought");
  });

  it("extracts image urls", () => {
    const msgs: HistoryMessage[] = [
      { role: "assistant", content: [{ type: "image", url: "https://example.com/img.png" }] },
    ];
    expect(extractContent(msgs).images).toEqual(["https://example.com/img.png"]);
  });

  it("skips system messages (no content key issue)", () => {
    const msgs: HistoryMessage[] = [{ role: "system", content: "sys" }];
    expect(extractContent(msgs)).toEqual({ text: "sys", thinking: "", images: [] });
  });
});

describe("historyToChatMessages", () => {
  it("converts user message with string content", () => {
    const history: HistoryMessage[] = [{ role: "user", content: "hi" }];
    expect(historyToChatMessages(history)).toEqual([{ role: "user", content: "hi" }]);
  });

  it("converts user message with block content (text only)", () => {
    const history: HistoryMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "image", url: "x" },
        ],
      },
    ];
    expect(historyToChatMessages(history)[0].content).toBe("hello");
  });

  it("converts assistant message with text and thinking", () => {
    const history: HistoryMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "ans" },
          { type: "thinking", thinking: "hmm" },
        ],
      },
    ];
    const [msg] = historyToChatMessages(history);
    expect(msg.content).toBe("ans");
    expect(msg.thinking).toBe("hmm");
  });

  it("extracts tool_use blocks into toolCalls", () => {
    const history: HistoryMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", toolCallId: "c1", name: "fn", input: { x: 1 } }],
      },
    ];
    const [msg] = historyToChatMessages(history);
    expect(msg.toolCalls).toEqual([{ toolCallId: "c1", name: "fn", input: { x: 1 } }]);
  });

  it("skips system and tool messages", () => {
    const history: HistoryMessage[] = [
      { role: "system", content: "sys" },
      { role: "tool", toolCallId: "c1", content: "result" },
    ];
    expect(historyToChatMessages(history)).toEqual([]);
  });
});

describe("getOptionsToSend", () => {
  it("returns all options on new session", () => {
    expect(getOptionsToSend({ a: "1" }, null, true)).toEqual({ a: "1" });
  });

  it("returns undefined when options empty on new session", () => {
    expect(getOptionsToSend({}, null, true)).toBeUndefined();
  });

  it("returns only changed options on existing session", () => {
    expect(getOptionsToSend({ a: "1", b: "2" }, { a: "1", b: "old" }, false)).toEqual({ b: "2" });
  });

  it("returns undefined when nothing changed on existing session", () => {
    expect(getOptionsToSend({ a: "1" }, { a: "1" }, false)).toBeUndefined();
  });
});

describe("runTool", () => {
  const tool = (code: string): ClientTool => ({
    spec: { name: "t", description: "", parameters: {} },
    code,
    trust: false,
  });

  it("executes tool code and returns result", () => {
    expect(runTool(tool("return input.x + 1"), { x: 2 })).toBe("3");
  });

  it("returns error string on exception", () => {
    expect(runTool(tool("throw new Error('boom')"), {})).toMatch(/Error.*boom/);
  });
});

describe("pickHistoryMode", () => {
  it("returns 'full' when full is available", () => {
    expect(pickHistoryMode({ history: { full: {}, compacted: {} } })).toBe("full");
  });
  it("returns 'compacted' when only compacted is available", () => {
    expect(pickHistoryMode({ history: { compacted: {} } })).toBe("compacted");
  });
  it("returns undefined when no history capability", () => {
    expect(pickHistoryMode({ history: {} })).toBeUndefined();
    expect(pickHistoryMode(undefined)).toBeUndefined();
  });
});
