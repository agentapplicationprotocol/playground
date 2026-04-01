import { useState, useRef } from "react";
import { Client, Session } from "@agentapplicationprotocol/client";
import type {
  AgentInfo,
  AgentOption,
  SSEEvent,
  HistoryMessage,
  UserMessage,
  ToolMessage,
  ToolPermissionMessage,
} from "@agentapplicationprotocol/core";
import ToolManager, {
  type ClientTool,
  type ServerToolState,
  toServerToolRefs,
} from "./ToolManager";
import SessionsPanel from "./SessionsPanel";
import Header from "./Header";
import ConnectScreen from "./ConnectScreen";
import MessageList from "./MessageList";
import {
  extractContent,
  historyToChatMessages,
  runTool,
  type ChatMessage,
  type ToolCallRecord,
  type PermissionRequest,
} from "./chatUtils";
import "./App.css";

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
  const clientRef = useRef<Client | null>(null);
  const sessionRef = useRef<Session | null>(null);

  function initOptions(agentOptions: AgentOption[]) {
    const defaults = Object.fromEntries(agentOptions.map((o) => [o.name, o.default]));
    setOptions(defaults);
  }

  function askPermission(
    toolName: string,
    toolType: "client" | "server",
    input: Record<string, unknown>,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      setPermRequests((prev) => [...prev, { toolName, toolType, input, resolve }]);
    });
  }

  function answerPermission(req: PermissionRequest, granted: boolean) {
    req.resolve(granted);
    setPermRequests((prev) => prev.filter((r) => r !== req));
  }

  function updateLast(updater: (m: ChatMessage) => ChatMessage) {
    setMessages((prev) => {
      const next = [...prev];
      next[next.length - 1] = updater(next[next.length - 1]);
      return next;
    });
  }

  function sseCallback(event: SSEEvent) {
    if (event.event === "text_delta")
      updateLast((m) => ({ ...m, content: m.content + event.delta }));
    else if (event.event === "text") updateLast((m) => ({ ...m, content: event.text }));
    else if (event.event === "thinking_delta")
      updateLast((m) => ({ ...m, thinking: (m.thinking ?? "") + event.delta }));
    else if (event.event === "thinking") updateLast((m) => ({ ...m, thinking: event.thinking }));
    else if (event.event === "tool_call") {
      updateLast((m) => {
        const existing = m.toolCalls?.find((tc) => tc.toolCallId === event.toolCallId);
        if (existing)
          return {
            ...m,
            toolCalls: (m.toolCalls ?? []).map((tc) =>
              tc.toolCallId === event.toolCallId
                ? { ...tc, name: event.name, input: event.input }
                : tc,
            ),
          };
        return {
          ...m,
          toolCalls: [
            ...(m.toolCalls ?? []),
            { toolCallId: event.toolCallId, name: event.name, input: event.input },
          ],
        };
      });
    } else if (event.event === "tool_result") {
      updateLast((m) => ({
        ...m,
        streaming: false,
        toolCalls: (m.toolCalls ?? []).map((tc) =>
          tc.toolCallId === event.toolCallId
            ? {
                ...tc,
                result:
                  typeof event.content === "string" ? event.content : JSON.stringify(event.content),
              }
            : tc,
        ),
      }));
      setMessages((prev) => [...prev, { role: "assistant", content: "", streaming: true }]);
    }
  }

  function applyNonStreamingMessages(messages: HistoryMessage[]) {
    const { text, thinking, images } = extractContent(messages);
    const toolCalls: ToolCallRecord[] = messages
      .flatMap((m) =>
        Array.isArray((m as { content?: unknown }).content)
          ? (m as { content: unknown[] }).content
          : [],
      )
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
      .map(({ toolCallId, name, input }) => ({ toolCallId, name, input }));
    updateLast((m) => {
      const merged = [...(m.toolCalls ?? [])];
      for (const tc of toolCalls) {
        const idx = merged.findIndex((x) => x.toolCallId === tc.toolCallId);
        if (idx >= 0) merged[idx] = { ...merged[idx], ...tc };
        else merged.push(tc);
      }
      return {
        ...m,
        content: text,
        ...(thinking ? { thinking } : {}),
        ...(images.length ? { images } : {}),
        ...(merged.length ? { toolCalls: merged } : {}),
      };
    });
  }

  async function processPending(
    session: Session,
    pending: {
      client: { toolCallId: string; name: string; input: Record<string, unknown> }[];
      server: { toolCallId: string; name: string; input: Record<string, unknown> }[];
    },
  ) {
    while (pending.client.length || pending.server.length) {
      const toolMessages: (UserMessage | ToolMessage | ToolPermissionMessage)[] = [];
      for (const block of [...pending.client, ...pending.server]) {
        const clientTool = tools.find((t) => t.spec.name === block.name);
        const serverTool = serverTools.find((t) => t.name === block.name);
        let resultText: string;
        let granted: boolean | undefined;
        if (clientTool) {
          if (clientTool.trust) {
            resultText = runTool(clientTool, block.input);
          } else {
            granted = await askPermission(block.name, "client", block.input);
            resultText = granted ? runTool(clientTool, block.input) : "denied";
          }
          toolMessages.push({ role: "tool", toolCallId: block.toolCallId, content: resultText! });
        } else if (serverTool) {
          granted = await askPermission(block.name, "server", block.input);
          resultText = granted ? "granted" : "denied";
          toolMessages.push({
            role: "tool_permission",
            toolCallId: block.toolCallId,
            granted: granted!,
          });
        } else {
          resultText = `Unknown tool: ${block.name}`;
          toolMessages.push({ role: "tool", toolCallId: block.toolCallId, content: resultText });
        }
        updateLast((m) => ({
          ...m,
          toolCalls: (m.toolCalls ?? []).map((tc) =>
            tc.toolCallId === block.toolCallId ? { ...tc, result: resultText! } : tc,
          ),
        }));
      }

      updateLast((m) => ({ ...m, streaming: false }));
      setMessages((prev) => [...prev, { role: "assistant", content: "", streaming: true }]);
      const req = { messages: toolMessages, stream: stream as "none" | "delta" | "message" };
      pending =
        stream === "none"
          ? await (async () => {
              const p = await session.send({ ...req, stream: "none" });
              applyNonStreamingMessages(session.history.slice(-1));
              return p;
            })()
          : await session.send(req, sseCallback);
    }
  }

  async function loadSession(id: string) {
    if (!clientRef.current) return;
    const agentInfo = agents.find((a) => a.name === selectedAgent) ?? {
      name: selectedAgent,
      version: "unknown",
    };
    const { session, pending } = await Session.load(clientRef.current, id, agentInfo, "full");

    if (session.agentConfig.options && Object.keys(session.agentConfig.options).length)
      setOptions(session.agentConfig.options);
    if (session.agentConfig.tools?.length)
      setServerTools(
        session.agentConfig.tools.map((ref) => ({
          name: ref.name,
          enabled: true,
          trust: ref.trust ?? false,
        })),
      );

    setSessionId(id);
    setMessages(historyToChatMessages(session.history));
    sessionRef.current = session;

    const untrustedUnhandled = [
      ...pending.client.filter((b) => !tools.find((t) => t.spec.name === b.name)?.trust),
      ...pending.server.filter((b) => !serverTools.find((t) => t.name === b.name)?.trust),
    ];
    if (untrustedUnhandled.length === 0) return;

    setBusy(true);
    try {
      const clientIds = new Set(pending.client.map((b) => b.toolCallId));
      await processPending(session, {
        client: untrustedUnhandled.filter((b) => clientIds.has(b.toolCallId)),
        server: untrustedUnhandled.filter((b) => !clientIds.has(b.toolCallId)),
      });
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
      setServerTools(
        (firstAgent?.tools ?? []).map((t) => ({ name: t.name, enabled: true, trust: false })),
      );
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
    sessionRef.current = null;
    setConnected(false);
    setAgents([]);
    setMessages([]);
    setSessionId(undefined);
    setPermRequests([]);
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
      const agentInfo = selectedAgentInfo ?? { name: selectedAgent, version: "unknown" };

      let pending: {
        client: { toolCallId: string; name: string; input: Record<string, unknown> }[];
        server: { toolCallId: string; name: string; input: Record<string, unknown> }[];
      };

      if (!sessionRef.current) {
        const req = {
          agent: {
            name: selectedAgent,
            ...(serverToolRefs.length ? { tools: serverToolRefs } : {}),
            ...(Object.keys(options).length ? { options } : {}),
          },
          messages: [{ role: "user" as const, content: userText }],
          ...(toolSpecs.length ? { tools: toolSpecs } : {}),
          stream: stream as "none" | "delta" | "message",
        };
        const { session, pending: p } =
          stream === "none"
            ? await Session.create(clientRef.current, { ...req, stream: "none" }, agentInfo)
            : await Session.create(clientRef.current, req, agentInfo, sseCallback);
        if (stream === "none") applyNonStreamingMessages(session.history.slice(-1));
        sessionRef.current = session;
        setSessionId(session.sessionId);
        pending = p;
      } else {
        const req = {
          messages: [{ role: "user" as const, content: userText }],
          agent: {
            ...(serverToolRefs.length ? { tools: serverToolRefs } : {}),
            ...(Object.keys(options).length ? { options } : {}),
          },
          ...(toolSpecs.length ? { tools: toolSpecs } : {}),
          stream: stream as "none" | "delta" | "message",
        };
        pending =
          stream === "none"
            ? await (async () => {
                const p = await sessionRef.current!.send({ ...req, stream: "none" });
                applyNonStreamingMessages(sessionRef.current!.history.slice(-1));
                return p;
              })()
            : await sessionRef.current.send(req, sseCallback);
      }

      await processPending(sessionRef.current, pending);
    } catch (e) {
      updateLast((m) => ({ ...m, content: `Error: ${e}` }));
    } finally {
      updateLast((m) => ({ ...m, streaming: false }));
      setBusy(false);
    }
  }

  if (!connected) {
    return (
      <ConnectScreen
        baseUrl={baseUrl}
        apiKey={apiKey}
        connectError={connectError}
        onBaseUrlChange={setBaseUrl}
        onApiKeyChange={setApiKey}
        onConnect={connect}
      />
    );
  }

  return (
    <div className="chat-screen">
      <Header>
        <label className="stream-toggle">
          Stream:
          <select
            value={stream}
            onChange={(e) => setStream(e.target.value as "none" | "delta" | "message")}
          >
            <option value="none" disabled={streamCaps ? !streamCaps.none : false}>
              none
            </option>
            <option value="delta" disabled={!streamCaps?.delta}>
              delta
            </option>
            <option value="message" disabled={!streamCaps?.message}>
              message
            </option>
          </select>
        </label>
        <select
          value={selectedAgent}
          onChange={(e) => {
            const name = e.target.value;
            setSelectedAgent(name);
            sessionRef.current = null;
            setSessionId(undefined);
            setMessages([]);
            const agent = agents.find((a) => a.name === name);
            setServerTools(
              (agent?.tools ?? []).map((t) => ({ name: t.name, enabled: true, trust: false })),
            );
            const caps = agent?.capabilities?.stream;
            if (caps?.delta) setStream("delta");
            else if (caps?.message) setStream("message");
            else if (caps?.none) setStream("none");
            initOptions(agent?.options ?? []);
          }}
        >
          {agents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.title ?? a.name}
            </option>
          ))}
        </select>
        <button className="disconnect" onClick={disconnect}>
          Disconnect
        </button>
        <button onClick={() => setShowSessions((v) => !v)}>Sessions</button>
        <button
          onClick={() => {
            sessionRef.current = null;
            setSessionId(undefined);
            setMessages([]);
          }}
        >
          New Session
        </button>
      </Header>

      {showSessions && (
        <SessionsPanel
          client={clientRef.current!}
          currentSessionId={sessionId}
          onLoad={(id) => {
            setShowSessions(false);
            loadSession(id);
          }}
          onClose={() => setShowSessions(false)}
        />
      )}

      <ToolManager
        clientTools={tools}
        onClientToolsChange={setTools}
        serverTools={serverTools}
        onServerToolsChange={setServerTools}
        clientToolsSupported={selectedAgentInfo?.capabilities?.application?.tools !== undefined}
      />

      {selectedAgentInfo && (selectedAgentInfo.options ?? []).length > 0 && (
        <div className="options-bar">
          <span className="tool-label">Server options:</span>
          {(selectedAgentInfo.options ?? []).map((opt) => (
            <label key={opt.name} className="option-field" title={opt.description}>
              <span>{opt.title ?? opt.name}</span>
              {opt.type === "select" ? (
                <select
                  value={options[opt.name] ?? opt.default}
                  onChange={(e) => setOptions((prev) => ({ ...prev, [opt.name]: e.target.value }))}
                >
                  {opt.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : opt.type === "secret" ? (
                <input
                  type="password"
                  value={options[opt.name] ?? opt.default}
                  onChange={(e) => setOptions((prev) => ({ ...prev, [opt.name]: e.target.value }))}
                />
              ) : (
                <input
                  value={options[opt.name] ?? opt.default}
                  onChange={(e) => setOptions((prev) => ({ ...prev, [opt.name]: e.target.value }))}
                />
              )}
            </label>
          ))}
        </div>
      )}

      <MessageList
        messages={messages}
        permRequests={permRequests}
        busy={busy}
        input={input}
        onInputChange={setInput}
        onSend={send}
        onAnswerPermission={answerPermission}
      />
    </div>
  );
}
