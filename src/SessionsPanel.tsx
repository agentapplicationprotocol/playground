import { useState, useEffect, useRef } from "react";
import { type Client } from "@agentapplicationprotocol/client";
import { type SessionInfo } from "@agentapplicationprotocol/core";

interface Props {
  client: Client;
  currentSessionId?: string;
  onLoad: (session: SessionInfo) => void;
  onClose: () => void;
}

export default function SessionsPanel({ client, currentSessionId, onLoad, onClose }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [detail, setDetail] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchedRef = useRef(false);

  async function fetchSessions(after?: string) {
    setLoading(true);
    try {
      const r = await client.getSessions(after ? { after } : undefined);
      setSessions((prev) => (after ? [...prev, ...r.sessions] : r.sessions));
      setNext(r.next);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchSessions();
  }, [client]);

  async function showDetail(s: SessionInfo) {
    setDetail(s);
  }

  async function deleteSession(id: string) {
    try {
      await client.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.sessionId !== id));
      if (detail?.sessionId === id) setDetail(null);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="sessions-panel">
      <div className="sessions-header">
        <span>Sessions</span>
        <button className="sessions-close" onClick={onClose}>
          ✕
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {loading && <p className="sessions-hint">Loading…</p>}
      <div className="sessions-body">
        <ul className="sessions-list">
          {sessions.map((s) => (
            <li
              key={s.sessionId}
              className={
                "session-item" +
                (s.sessionId === currentSessionId ? " active" : "") +
                (s.sessionId === detail?.sessionId ? " selected" : "")
              }
              onClick={() => showDetail(s)}
            >
              <span className="session-id">{s.sessionId}</span>
            </li>
          ))}
          {!loading && sessions.length === 0 && <li className="sessions-hint">No sessions.</li>}
          {next && !loading && (
            <li
              className="sessions-hint"
              style={{ cursor: "pointer", textDecoration: "underline" }}
              onClick={() => fetchSessions(next)}
            >
              Load more…
            </li>
          )}
        </ul>
        {detail && (
          <div className="session-detail">
            <div className="session-detail-row">
              <span>Agent</span>
              <span>{detail.agent.name}</span>
            </div>
            {detail.agent.options && Object.keys(detail.agent.options).length > 0 && (
              <div className="session-detail-row">
                <span>Options</span>
                <span>{JSON.stringify(detail.agent.options)}</span>
              </div>
            )}
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "auto" }}>
              <button
                disabled={detail.sessionId === currentSessionId}
                onClick={() => {
                  onLoad(detail);
                  onClose();
                }}
              >
                {detail.sessionId === currentSessionId ? "Already active" : "Load session"}
              </button>
              <button className="danger" onClick={() => deleteSession(detail.sessionId)}>
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
