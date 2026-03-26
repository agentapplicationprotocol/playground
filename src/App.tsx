import { useState, useRef, useEffect } from "react";
import { Client, type AgentInfo, type AgentOption, type SSEEvent, type AgentResponse, type Message } from "@agentapplicationprotocol/sdk";
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
  toolCalls?: ToolCallRecord[];
  streaming?: boolean;
}

interface PermissionRequest {
  toolName: string;
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

function extractContent(messages: Message[]): { text: string; thinking: string } {
  let text = "", thinking = "";
  for (const m of messages) {
    if (!("content" in m)) continue;
    const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === "text") text += (text ? "\n" : "") + b.text;
      else if (b.type === "thinking") thinking += (thinking ? "\n" : "") + b.thinking;
    }
  }
  return { text, thinking };
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
  const [stream, setStream] = useState<"none" | "chunk" | "message">("chunk");
  const selectedAgentInfo = agents.find((a) => a.name === selectedAgent);
  const streamCaps = selectedAgentInfo?.capabilities?.stream;
  const [tools, setTools] = useState<ClientTool[]>([]);
  const [serverTools, setServerTools] = useState<ServerToolState[]>([]);
  const [busy, setBusy] = useState(false);
  const [permRequest, setPermRequest] = useState<PermissionRequest | null>(null);
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

  function askPermission(toolName: string, input: Record<string, unknown>): Promise<boolean> {
    return new Promise((resolve) => {
      setPermRequest({ toolName, input, resolve });
    });
  }

  function answerPermission(granted: boolean) {
    permRequest?.resolve(granted);
    setPermRequest(null);
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
      if (caps?.chunk) setStream("chunk");
      else if (caps?.message) setStream("message");
      else setStream("none");
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
  }

  function updateLast(updater: (m: ChatMessage) => ChatMessage) {
    setMessages((prev) => {
      const next = [...prev];
      next[next.length - 1] = updater(next[next.length - 1]);
      return next;
    });
  }

  async function handleResponse(result: AgentResponse | AsyncIterable<SSEEvent>): Promise<{ stopReason: string; allMessages: Message[]; sid?: string }> {
    const allMessages: Message[] = [];
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
        else if (event.event === "message_stop") stopReason = event.stopReason;
      }
    } else {
      const response = result as AgentResponse;
      sid = response.sessionId;
      stopReason = response.stopReason;
      allMessages.push(...response.messages);
      const { text, thinking } = extractContent(response.messages);
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
        return { ...m, content: text, ...(thinking ? { thinking } : {}), ...(merged.length ? { toolCalls: merged } : {}) };
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
        // createSession: always send all options
        optionsToSend = Object.keys(options).length ? options : undefined;
      } else {
        // sendTurn: only send if something changed
        const changed = Object.fromEntries(Object.entries(options).filter(([k, v]) => last?.[k] !== v));
        optionsToSend = Object.keys(changed).length ? changed : undefined;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: any = {
        agent: selectedAgent,
        messages: [{ role: "user", content: userText }],
        stream,
        ...(toolSpecs.length ? { tools: toolSpecs } : {}),
        ...(serverToolRefs.length ? { serverTools: serverToolRefs } : {}),
        ...(optionsToSend ? { options: optionsToSend } : {}),
      };

      let result = sessionId
        ? await clientRef.current.sendTurn(sessionId, req)
        : await clientRef.current.createSession(req);

      lastSentOptionsRef.current = { ...options };

      let { stopReason, allMessages, sid } = await handleResponse(result);
      const resolvedSid = sid ?? sessionId;
      if (sid) setSessionId(sid);

      while (stopReason === "tool_use") {
        const toolUseBlocks = allMessages
          .flatMap((m) => Array.isArray((m as { content?: unknown }).content) ? (m as { content: unknown[] }).content : [])
          .filter((b): b is { type: "tool_use"; toolCallId: string; name: string; input: Record<string, unknown> } => (b as { type: string }).type === "tool_use");

        const toolMessages: Message[] = [];
        for (const block of toolUseBlocks) {
          const clientTool = tools.find((t) => t.spec.name === block.name);
          const serverTool = serverTools.find((t) => t.name === block.name);
          let resultText: string;
          let granted: boolean | undefined;
          if (clientTool) {
            resultText = runTool(clientTool, block.input);
            toolMessages.push({ role: "tool", toolCallId: block.toolCallId, content: resultText });
          } else if (serverTool) {
            granted = await askPermission(block.name, block.input);
            resultText = granted ? "granted" : "denied";
            toolMessages.push({ role: "tool_permission", toolCallId: block.toolCallId, granted });
          } else {
            resultText = `Unknown tool: ${block.name}`;
            toolMessages.push({ role: "tool", toolCallId: block.toolCallId, content: resultText });
          }
          // Attach result to the rendered tool call
          updateLast((m) => ({
            ...m,
            toolCalls: (m.toolCalls ?? []).map((tc) =>
              tc.toolCallId === block.toolCallId ? { ...tc, result: resultText } : tc
            ),
          }));
        }

        updateLast((m) => ({ ...m, streaming: true }));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await clientRef.current.sendTurn(resolvedSid!, { messages: toolMessages, stream } as any);
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
        <h1>AAP Playground</h1>
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
        <span className="title">AAP Playground</span>
        <div className="header-right">
          <label className="stream-toggle">Stream:
            <select value={stream} onChange={(e) => setStream(e.target.value as "none" | "chunk" | "message")}>
              <option value="none" disabled={streamCaps ? !streamCaps.none : false}>none</option>
              <option value="chunk" disabled={!streamCaps?.chunk}>chunk</option>
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
            if (caps?.chunk) setStream("chunk");
            else if (caps?.message) setStream("message");
            else setStream("none");
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
          onLoad={(id) => { setSessionId(id); setMessages([]); }}
          onClose={() => setShowSessions(false)}
        />
      )}

      <ToolManager
        clientTools={tools} onClientToolsChange={setTools}
        serverTools={serverTools} onServerToolsChange={setServerTools}
        clientToolsSupported={selectedAgentInfo?.capabilities?.application?.tools === true}
      />

      {selectedAgentInfo && selectedAgentInfo.options.length > 0 && (
        <div className="options-bar">
          {selectedAgentInfo.options.map((opt) => (
            <label key={opt.name} className="option-field" title={opt.description}>
              <span>{opt.title ?? opt.name}</span>
              {opt.type === "select" ? (
                <select value={options[opt.name] ?? opt.default} onChange={(e) => setOptions((prev) => ({ ...prev, [opt.name]: e.target.value }))}>
                  {opt.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
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
                {tc.result !== undefined && <div className="tool-call-result">↳ {tc.result}</div>}
              </div>
            ))}
            {m.content && <span className="bubble">{m.content}{m.streaming && <span className="cursor">▋</span>}</span>}
            {!m.content && m.streaming && <span className="bubble"><span className="cursor">▋</span></span>}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {permRequest && (
        <div className="perm-prompt">
          <p>The agent wants to run server tool <strong>{permRequest.toolName}</strong> with:</p>
          <pre>{JSON.stringify(permRequest.input, null, 2)}</pre>
          <div className="perm-actions">
            <button onClick={() => answerPermission(true)}>Allow</button>
            <button className="disconnect" onClick={() => answerPermission(false)}>Deny</button>
          </div>
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
