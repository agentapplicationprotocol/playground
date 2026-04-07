import { useRef, useEffect } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import type { ChatMessage, PermissionRequest } from "./chatUtils";

interface Props {
  messages: ChatMessage[];
  permRequests: PermissionRequest[];
  busy: boolean;
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onAnswerPermission: (req: PermissionRequest, granted: boolean) => void;
}

export default function MessageList({
  messages,
  permRequests,
  busy,
  input,
  onInputChange,
  onSend,
  onAnswerPermission,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <>
      <div className="messages">
        {messages.length === 0 && <p className="empty">Send a message to start.</p>}
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            {m.thinking && <div className="thinking">{m.thinking}</div>}
            {m.content && (
              <span className="bubble">
                {m.role === "assistant" ? (
                  <Streamdown controls={{ table: false }}>{m.content}</Streamdown>
                ) : (
                  m.content
                )}
                {m.streaming && <span className="cursor">▋</span>}
              </span>
            )}
            {!m.content && m.streaming && (
              <span className="bubble">
                <span className="cursor">▋</span>
              </span>
            )}
            {m.toolCalls?.map((tc) => (
              <div key={tc.toolCallId} className="tool-call">
                <span className="tool-call-name">⚙ {tc.name}</span>
                <pre className="tool-call-input">{JSON.stringify(tc.input, null, 2)}</pre>
                {tc.result !== undefined && (
                  <details className="tool-call-result-wrap">
                    <summary
                      className={`tool-call-result${tc.result === "denied" ? " denied" : ""}`}
                    >
                      ↳ result
                    </summary>
                    <pre className="tool-call-input">{tc.result}</pre>
                  </details>
                )}
              </div>
            ))}
            {m.images?.map((url, j) => (
              <img key={j} src={url} className="message-image" alt="" />
            ))}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {permRequests.length > 0 && (
        <div className="perm-prompt">
          <p>The agent wants to run tool{permRequests.length > 1 ? "s" : ""}:</p>
          {permRequests.map((req, i) => (
            <div key={i} className="perm-item">
              <strong>{req.toolName}</strong>
              <span className="perm-type"> ({req.toolType} tool)</span>
              <pre>{JSON.stringify(req.input, null, 2)}</pre>
              <div className="perm-actions">
                <button onClick={() => onAnswerPermission(req, true)}>Allow</button>
                <button className="disconnect" onClick={() => onAnswerPermission(req, false)}>
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="input-row">
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
          rows={2}
          disabled={busy}
        />
        <button onClick={onSend} disabled={busy || !input.trim()}>
          Send
        </button>
      </div>
    </>
  );
}
