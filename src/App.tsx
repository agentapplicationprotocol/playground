import { useState, useRef, useEffect } from "react";
import { Client, type AgentInfo, type AgentOption, type AgentConfig, type SSEEvent, type AgentResponse, type HistoryMessage, type UserMessage, type ToolMessage, type ToolPermissionMessage } from "@agentapplicationprotocol/sdk";
import ToolManager, { type ClientTool, type ServerToolState, toServerToolRefs } from "./ToolManager";
import SessionsPanel from "./SessionsPanel";
import "./App.css";

interface ToolCallRecord {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  thinking?: string;
  content: string;
  images?: string[];
  toolCalls?: ToolCallRecord[];
  streaming?: boolean;
}

interface PermissionRequest {
  toolName: string;
  toolType: "client" | "server";
  input: Record<string, unknown>;
  resolve: (granted: boolean) => void;
}

function runTool(tool: ClientTool, input: Record<string, unknown>): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function("input", tool.code)(input);
  } catch (e) {
    return `Error: ${e}`;
  }
}

function extractContent(messages: HistoryMessage[]): { text: string; thinking: string; images: string[] } {
  let text = "", thinking = "";
  const images: string[] = [];
  for (const m of messages) {
    if (!("content" in m)) continue;
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === "text") text += (text ? "\n" : "") + b.text;
      else if (b.type === "thinking") thinking += (thinking ? "\n" : "") + b.thinking;
      else if (b.type === "image") images.push(b.url);
    }
  }
  return { text, thinking, images };
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [connected, setConnected] = useState(false);
  const [connectError, setConnectError] = useState("");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [stream, setStream] = useState<"none" | "delta" | "message">("delta");
  const selectedAgentInfo = agents.find((a) => a.name === selectedAgent);
  const streamCaps = selectedAgentInfo?.capabilities?.stream;
  const [tools, setTools] = useState<ClientTool[]>([]);
  const [serverTools, setServerTools] = useState<ServerToolState[]>([]);
  const [busy, setBusy] = useState(false);
  const [permRequests, setPermRequests] = useState<PermissionRequest[]>([]);
  const [showSessions, setShowSessions] = useState(false);

  const [options, setOptions] = useState<Record<string, string>>({});
  const lastSentOptionsRef = useRef<Record<string, string> | null>(null);

  function initOptions(agentOptions: AgentOption[]) {
    const defaults = Object.fromEntries(agentOptions.map((o) => [o.name, o.default]));
    setOptions(defaults);
    lastSentOptionsRef.current = null;
  }

  const clientRef = useRef<Client | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function askPermission(toolName: string, toolType: "client" | "server", input: Record<string, unknown>): Promise<boolean> {
    return new Promise((resolve) => {
      setPermRequests((prev) => [...prev, { toolName, toolType, input, resolve }]);
    });
  }

  function answerPermission(req: PermissionRequest, granted: boolean) {
    req.resolve(granted);
    setPermRequests((prev) => prev.filter((r) => r !== req));
  }

  async function loadSession(id: string) {
    if (!clientRef.current) return;
    const session = await clientRef.current.getSession(id);
    const history = session.history?.full ?? session.history?.compacted ?? [];

    // Restore options, server tools from AgentConfig
    if (session.agent.options && Object.keys(session.agent.options).length) {
      setOptions(session.agent.options);
      lastSentOptionsRef.current = { ...session.agent.options };
    }
    if (session.agent.tools && session.agent.tools.length) {
      setServerTools(session.agent.tools.map((ref) => ({
        name: ref.name,
        enabled: true,
        trust: ref.trust ?? false,
      })));
    }

    // Reconstruct chat messages from history
    const chatMessages: ChatMessage[] = [];
    for (const m of history) {
      if (m.role === "user") {
        const content = typeof m.content === "string" ? m.content : m.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("\n");
        chatMessages.push({ role: "user", content });
      } else if (m.role === "assistant") {
        const { text, thinking, images } = extractContent([m]);
        const toolCalls: ToolCallRecord[] = (Array.isArray(m.content) ? m.content : [])
          .filter((b): b is { type: "tool_use"; toolCallId: string; name: string; input: Record<string, unknown> } => (b as { type: string }).type === "tool_use")
          .map(({ toolCallId, name, input }) => ({ toolCallId, name, input }));
        chatMessages.push({ role: "assistant", content: text, ...(thinking ? { thinking } : {}), ...(images.length ? { images } : {}), ...(toolCalls.length ? { toolCalls } : {}) });
      }
    }

    // Find unhandled tool_use blocks (no matching tool/tool_permission response)
    const handledIds = new Set(
      history
        .filter((m) => m.role === "tool" || (m as { role: string }).role === "tool_permission")
        .map((m) => (m as { toolCallId: string }).toolCallId)
    );

    const unhandled = history
      .flatMap((m) => Array.isArray((m as { content?: unknown }).content) ? (m as { content: unknown[] }).content : [])
      .filter((b): b is { type: "tool_use"; toolCallId: string; name: string; input: Record<string, unknown> } =>
        (b as { type: string }).type === "tool_use" && !handledIds.has((b as { toolCallId: string }).toolCallId));

    // Show perm for untrusted server tools and untrusted client tools
    const untrustedUnhandled = unhandled.filter((b) =>
      serverTools.some((t) => t.name === b.name && !t.trust) ||
      tools.some((t) => t.spec.name === b.name && !t.trust)
    );

    setSessionId(id);
    setMessages(chatMessages);

    if (untrustedUnhandled.length === 0) return;

    setBusy(true);
    const toolMessages: (UserMessage | ToolMessage | ToolPermissionMessage)[] = [];
    await Promise.all(untrustedUnhandled.map(async (block) => {
      const clientTool = tools.find((t) => t.spec.name === block.name);
      const isClient = !!clientTool;
      const granted = await askPermission(block.name, isClient ? "client" : "server", block.input);
      const resultText = isClient
        ? (granted ? runTool(clientTool!, block.input) : "denied")
        : (granted ? "granted" : "denied");
      if (isClient) {
        toolMessages.push({ role: "tool", toolCallId: block.toolCallId, content: resultText });
      } else {
        toolMessages.push({ role: "tool_permission", toolCallId: block.toolCallId, granted });
      }
      // Attach result to last assistant message
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") {
          next[next.length - 1] = {
            ...last,
            toolCalls: (last.toolCalls ?? []).map((tc) =>
              tc.toolCallId === block.toolCallId ? { ...tc, result: resultText } : tc
            ),
          };
        }
        return next;
      });
    }));

    // Resume session
    try {
      setMessages((prev) => [...prev, { role: "assistant", content: "", streaming: true }]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: AgentResponse | AsyncIterable<SSEEvent> = stream === "none"
        ? await clientRef.current!.sendTurn(id, { messages: toolMessages, stream: "none" })
        : await clientRef.current!.sendTurn(id, { messages: toolMessages, stream });
      let { stopReason, allMessages, sid: newSid } = await handleResponse(result);
      const resolvedSid = newSid ?? id;
      if (newSid) setSessionId(newSid);

      while (stopReason === "tool_use") {
        const toolUseBlocks = allMessages
          .flatMap((m) => Array.isArray((m as { content?: unknown }).content) ? (m as { content: unknown[] }).content : [])
          .filter((b): b is { type: "tool_use"; toolCallId: string; name: string; input: Record<string, unknown> } => (b as { type: string }).type === "tool_use");

        const nextToolMessages: (UserMessage | ToolMessage | ToolPermissionMessage)[] = [];
        for (const block of toolUseBlocks) {
          const clientTool = tools.find((t) => t.spec.name === block.name);
          const serverTool = serverTools.find((t) => t.name === block.name);
          let resultText: string;
          if (clientTool) {
            if (clientTool.trust) {
              resultText = runTool(clientTool, block.input);
              nextToolMessages.push({ role: "tool", toolCallId: block.toolCallId, content: resultText });
            } else {
              const granted = await askPermission(block.name, "client", block.input);
              resultText = granted ? runTool(clientTool, block.input) : "denied";
              nextToolMessages.push({ role: "tool", toolCallId: block.toolCallId, content: resultText });
            }
          } else if (serverTool) {
            const granted = await askPermission(block.name, "server", block.input);
            resultText = granted ? "granted" : "denied";
            nextToolMessages.push({ role: "tool_permission", toolCallId: block.toolCallId, granted });
          } else {
            resultText = `Unknown tool: ${block.name}`;
            nextToolMessages.push({ role: "tool", toolCallId: block.toolCallId, content: resultText });
          }
          updateLast((m) => ({
            ...m,
            toolCalls: (m.toolCalls ?? []).map((tc) =>
              tc.toolCallId === block.toolCallId ? { ...tc, result: resultText } : tc
            ),
          }));
        }
        updateLast((m) => ({ ...m, streaming: false }));
        setMessages((prev) => [...prev, { role: "assistant", content: "", streaming: true }]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = stream === "none"
          ? await clientRef.current!.sendTurn(resolvedSid, { messages: nextToolMessages, stream: "none" })
          : await clientRef.current!.sendTurn(resolvedSid, { messages: nextToolMessages, stream });
        ({ stopReason, allMessages } = await handleResponse(result));
      }
    } catch (e) {
      updateLast((m) => ({ ...m, content: `Error: ${e}` }));
    } finally {
      updateLast((m) => ({ ...m, streaming: false }));
      setBusy(false);
    }
  }

  async function connect() {
    setConnectError("");
    try {
      const client = new Client({ baseUrl, apiKey });
      const meta = await client.getMeta();
      clientRef.current = client;
      setAgents(meta.agents);
      const firstAgent = meta.agents[0];
      setSelectedAgent(firstAgent?.name ?? "");
      setServerTools((firstAgent?.tools ?? []).map((t) => ({ name: t.name, enabled: true, trust: false })));
      const caps = firstAgent?.capabilities?.stream;
      if (caps?.delta) setStream("delta");
      else if (caps?.message) setStream("message");
      else if (caps?.none) setStream("none");
      initOptions(firstAgent?.options ?? []);
      setConnected(true);
    } catch (e) {
      setConnectError(String(e));
    }
  }

  function disconnect() {
    clientRef.current = null;
    setConnected(false);
    setAgents([]);
    setMessages([]);
    setSessionId(undefined);
    setPermRequests([]);
  }

  function updateLast(updater: (m: ChatMessage) => ChatMessage) {
    setMessages((prev) => {
      const next = [...prev];
      next[next.length - 1] = updater(next[next.length - 1]);
      return next;
    });
  }

  async function handleResponse(result: AgentResponse | AsyncIterable<SSEEvent>): Promise<{ stopReason: string; allMessages: HistoryMessage[]; sid?: string }> {
    const allMessages: HistoryMessage[] = [];
    let stopReason = "end_turn";
    let sid: string | undefined;

    if (result && Symbol.asyncIterator in result) {
      for await (const event of result as AsyncIterable<SSEEvent>) {
        if (event.event === "session_start") sid = event.sessionId;
        else if (event.event === "text_delta") updateLast((m) => ({ ...m, content: m.content + event.delta }));
        else if (event.event === "text") updateLast((m) => ({ ...m, content: event.text }));
        else if (event.event === "thinking_delta") updateLast((m) => ({ ...m, thinking: (m.thinking ?? "") + event.delta }));
        else if (event.event === "thinking") updateLast((m) => ({ ...m, thinking: event.thinking }));
        else if (event.event === "tool_call") {
          allMessages.push({ role: "assistant", content: [{ type: "tool_use", toolCallId: event.toolCallId, name: event.name, input: event.input }] });
          updateLast((m) => {
            const existing = m.toolCalls?.find((tc) => tc.toolCallId === event.toolCallId);
            if (existing) {
              return { ...m, toolCalls: (m.toolCalls ?? []).map((tc) => tc.toolCallId === event.toolCallId ? { ...tc, name: event.name, input: event.input } : tc) };
            }
            return { ...m, toolCalls: [...(m.toolCalls ?? []), { toolCallId: event.toolCallId, name: event.name, input: event.input }] };
          });
        }
        else if (event.event === "turn_stop") stopReason = event.stopReason;
      }
    } else {
      const response = result as AgentResponse;
      sid = response.sessionId;
      stopReason = response.stopReason;
      allMessages.push(...response.messages);
      const { text, thinking, images } = extractContent(response.messages);
      const toolCalls: ToolCallRecord[] = response.messages
        .flatMap((m) => Array.isArray((m as { content?: unknown }).content) ? (m as { content: unknown[] }).content : [])
        .filter((b): b is { type: "tool_use"; toolCallId: string; name: string; input: Record<string, unknown> } => (b as { type: string }).type === "tool_use")
        .map(({ toolCallId, name, input }) => ({ toolCallId, name, input }));
      updateLast((m) => {
        const merged = [...(m.toolCalls ?? [])];
        for (const tc of toolCalls) {
          const idx = merged.findIndex((x) => x.toolCallId === tc.toolCallId);
          if (idx >= 0) merged[idx] = { ...merged[idx], ...tc };
          else merged.push(tc);
        }
        return { ...m, content: text, ...(thinking ? { thinking } : {}), ...(images.length ? { images } : {}), ...(merged.length ? { toolCalls: merged } : {}) };
      });
    }

    return { stopReason, allMessages, sid };
  }

  async function send() {
    if (!input.trim() || busy || !clientRef.current) return;
    const userText = input.trim();
    setInput("");
    setBusy(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: userText },
      { role: "assistant", content: "", streaming: true },
    ]);

    try {
      const toolSpecs = tools.map((t) => t.spec);
      const serverToolRefs = toServerToolRefs(serverTools);

      // Compute options to send: always on createSession, only changed values on sendTurn
      const last = lastSentOptionsRef.current;
      let optionsToSend: Record<string, string> | undefined;
      if (!sessionId) {
        optionsToSend = Object.keys(options).length ? options : undefined;
      } else {
        const changed = Object.fromEntries(Object.entries(options).filter(([k, v]) => last?.[k] !== v));
        optionsToSend = Object.keys(changed).length ? changed : undefined;
      }

      const agentConfig: AgentConfig = {
        name: selectedAgent,
        ...(serverToolRefs.length ? { tools: serverToolRefs } : {}),
        ...(optionsToSend && !sessionId ? { options: optionsToSend } : {}),
      };

      const agentUpdate = sessionId && (serverToolRefs.length || optionsToSend)
        ? {
            ...(serverToolRefs.length ? { tools: serverToolRefs } : {}),
            ...(optionsToSend ? { options: optionsToSend } : {}),
          }
        : undefined;

      const baseReq = {
        messages: [{ role: "user" as const, content: userText }],
        ...(toolSpecs.length ? { tools: toolSpecs } : {}),
      };

      let result: AgentResponse | AsyncIterable<SSEEvent>;
      if (sessionId) {
        const turnReq = { ...baseReq, ...(agentUpdate ? { agent: agentUpdate } : {}) };
        result = stream === "none"
          ? await clientRef.current.sendTurn(sessionId, { ...turnReq, stream: "none" as const })
          : await clientRef.current.sendTurn(sessionId, { ...turnReq, stream });
      } else {
        const sessionReq = { ...baseReq, agent: agentConfig };
        result = stream === "none"
          ? await clientRef.current.createSession({ ...sessionReq, stream: "none" as const })
          : await clientRef.current.createSession({ ...sessionReq, stream });
      }

      lastSentOptionsRef.current = { ...options };

      let { stopReason, allMessages, sid } = await handleResponse(result);
      const resolvedSid = sid ?? sessionId;
      if (sid) setSessionId(sid);

      while (stopReason === "tool_use") {
        const toolUseBlocks = allMessages
          .flatMap((m) => Array.isArray((m as { content?: unknown }).content) ? (m as { content: unknown[] }).content : [])
          .filter((b): b is { type: "tool_use"; toolCallId: string; name: string; input: Record<string, unknown> } => (b as { type: string }).type === "tool_use");

        const toolMessages: (UserMessage | ToolMessage | ToolPermissionMessage)[] = [];
        for (const block of toolUseBlocks) {
          const clientTool = tools.find((t) => t.spec.name === block.name);
          const serverTool = serverTools.find((t) => t.name === block.name);
          let resultText: string;
          let granted: boolean | undefined;
          if (clientTool) {
            if (clientTool.trust) {
              resultText = runTool(clientTool, block.input);
              toolMessages.push({ role: "tool", toolCallId: block.toolCallId, content: resultText });
            } else {
              granted = await askPermission(block.name, "client", block.input);
              resultText = granted ? runTool(clientTool, block.input) : "denied";
              toolMessages.push({ role: "tool", toolCallId: block.toolCallId, content: resultText });
            }
          } else if (serverTool) {
            granted = await askPermission(block.name, "server", block.input);
            resultText = granted ? "granted" : "denied";
            toolMessages.push({ role: "tool_permission", toolCallId: block.toolCallId, granted: granted! });
          } else {
            resultText = `Unknown tool: ${block.name}`;
            toolMessages.push({ role: "tool", toolCallId: block.toolCallId, content: resultText });
          }
          updateLast((m) => ({
            ...m,
            toolCalls: (m.toolCalls ?? []).map((tc) =>
              tc.toolCallId === block.toolCallId ? { ...tc, result: resultText } : tc
            ),
          }));
        }

        updateLast((m) => ({ ...m, streaming: false }));
        setMessages((prev) => [...prev, { role: "assistant", content: "", streaming: true }]);
        result = stream === "none"
          ? await clientRef.current.sendTurn(resolvedSid!, { messages: toolMessages, stream: "none" })
          : await clientRef.current.sendTurn(resolvedSid!, { messages: toolMessages, stream });
        ({ stopReason, allMessages, sid } = await handleResponse(result));
        if (sid) setSessionId(sid);
      }
    } catch (e) {
      updateLast((m) => ({ ...m, content: `Error: ${e}` }));
    } finally {
      updateLast((m) => ({ ...m, streaming: false }));
      setBusy(false);
    }
  }

  if (!connected) {
    return (
      <div className="connect-screen">
        <img src={`${import.meta.env.BASE_URL}favicon.png`} alt="logo" style={{ width: 64, height: 64 }} />
        <h1>Agent Application Protocol<br />Playground</h1>
        <div className="connect-form">
          <label>Base URL
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-aap-server.com" />
          </label>
          <label>API Key
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." />
          </label>
          {connectError && <p className="error">{connectError}</p>}
          <button onClick={connect} disabled={!baseUrl}>Connect</button>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-screen">
      <header>
        <span className="title">Agent Application Playground Playground</span>
        <div className="header-right">
          <label className="stream-toggle">Stream:
            <select value={stream} onChange={(e) => setStream(e.target.value as "none" | "delta" | "message")}>
              <option value="none" disabled={streamCaps ? !streamCaps.none : false}>none</option>
              <option value="delta" disabled={!streamCaps?.delta}>delta</option>
              <option value="message" disabled={!streamCaps?.message}>message</option>
            </select>
          </label>
          <select value={selectedAgent} onChange={(e) => {
            const name = e.target.value;
            setSelectedAgent(name);
            setSessionId(undefined);
            setMessages([]);
            const agent = agents.find((a) => a.name === name);
            setServerTools((agent?.tools ?? []).map((t) => ({ name: t.name, enabled: true, trust: false })));
            const caps = agent?.capabilities?.stream;
            if (caps?.delta) setStream("delta");
            else if (caps?.message) setStream("message");
            else if (caps?.none) setStream("none");
            initOptions(agent?.options ?? []);
          }}>
            {agents.map((a) => <option key={a.name} value={a.name}>{a.title ?? a.name}</option>)}
          </select>
          <button className="disconnect" onClick={disconnect}>Disconnect</button>
          <button onClick={() => setShowSessions((v) => !v)}>Sessions</button>
        </div>
      </header>

      {showSessions && (
        <SessionsPanel
          client={clientRef.current!}
          currentSessionId={sessionId}
          onLoad={(id) => { setShowSessions(false); loadSession(id); }}
          onClose={() => setShowSessions(false)}
        />
      )}

      <ToolManager
        clientTools={tools} onClientToolsChange={setTools}
        serverTools={serverTools} onServerToolsChange={setServerTools}
        clientToolsSupported={selectedAgentInfo?.capabilities?.application?.tools !== undefined}
      />

      {selectedAgentInfo && (selectedAgentInfo.options ?? []).length > 0 && (
        <div className="options-bar">
          {(selectedAgentInfo.options ?? []).map((opt) => (
            <label key={opt.name} className="option-field" title={opt.description}>
              <span>{opt.title ?? opt.name}</span>
              {opt.type === "select" ? (
                <select value={options[opt.name] ?? opt.default} onChange={(e) => setOptions((prev) => ({ ...prev, [opt.name]: e.target.value }))}>
                  {opt.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : opt.type === "secret" ? (
                <input type="password" value={options[opt.name] ?? opt.default} onChange={(e) => setOptions((prev) => ({ ...prev, [opt.name]: e.target.value }))} />
              ) : (
                <input value={options[opt.name] ?? opt.default} onChange={(e) => setOptions((prev) => ({ ...prev, [opt.name]: e.target.value }))} />
              )}
            </label>
          ))}
        </div>
      )}

      <div className="messages">
        {messages.length === 0 && <p className="empty">Send a message to start.</p>}
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            {m.thinking && <div className="thinking">{m.thinking}</div>}
            {m.toolCalls?.map((tc) => (
              <div key={tc.toolCallId} className="tool-call">
                <span className="tool-call-name">⚙ {tc.name}</span>
                <pre className="tool-call-input">{JSON.stringify(tc.input, null, 2)}</pre>
                {tc.result !== undefined && <div className={`tool-call-result${tc.result === "denied" ? " denied" : ""}`}>↳ {tc.result}</div>}
              </div>
            ))}
            {m.content && <span className="bubble">{m.content}{m.streaming && <span className="cursor">▋</span>}</span>}
            {!m.content && m.streaming && <span className="bubble"><span className="cursor">▋</span></span>}
            {m.images?.map((url, i) => <img key={i} src={url} className="message-image" alt="" />)}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {permRequests.length > 0 && (
        <div className="perm-prompt">
          <p>The agent wants to run tool{permRequests.length > 1 ? "s" : ""}:</p>
          {permRequests.map((req, i) => (
            <div key={i} className="perm-item">
              <strong>{req.toolName}</strong><span className="perm-type"> ({req.toolType} tool)</span>
              <pre>{JSON.stringify(req.input, null, 2)}</pre>
              <div className="perm-actions">
                <button onClick={() => answerPermission(req, true)}>Allow</button>
                <button className="disconnect" onClick={() => answerPermission(req, false)}>Deny</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          rows={2}
          disabled={busy}
        />
        <button onClick={send} disabled={busy || !input.trim()}>Send</button>
      </div>
    </div>
  );
}
