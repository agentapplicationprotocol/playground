import { useState, useEffect, useRef } from "react";
import { type Client, type SessionResponse } from "@agentapplicationprotocol/sdk";

interface Props {
  client: Client;
  currentSessionId?: string;
  onLoad: (sessionId: string) => void;
  onClose: () => void;
}

export default function SessionsPanel({ client, currentSessionId, onLoad, onClose }: Props) {
  const [sessions, setSessions] = useState<string[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [detail, setDetail] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchedRef = useRef(false);

  async function fetchSessions(after?: string) {
    setLoading(true);
    try {
      const r = await client.listSessions(after ? { after } : undefined);
      setSessions((prev) => after ? [...prev, ...r.sessions] : r.sessions);
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

  async function showDetail(id: string) {
    setDetail(null);
    try {
      setDetail(await client.getSession(id));
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteSession(id: string) {
    try {
      await client.deleteSession(id);
      setSessions((prev) => prev.filter((s) => s !== id));
      if (detail?.sessionId === id) setDetail(null);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="sessions-panel">
      <div className="sessions-header">
        <span>Sessions</span>
        <button className="sessions-close" onClick={onClose}>✕</button>
      </div>
      {error && <p className="error">{error}</p>}
      {loading && <p className="sessions-hint">Loading…</p>}
      <div className="sessions-body">
        <ul className="sessions-list">
          {sessions.map((id) => (
            <li key={id}
              className={"session-item" + (id === currentSessionId ? " active" : "") + (id === detail?.sessionId ? " selected" : "")}
              onClick={() => showDetail(id)}>
              <span className="session-id">{id}</span>
            </li>
          ))}
          {!loading && sessions.length === 0 && <li className="sessions-hint">No sessions.</li>}
          {next && !loading && (
            <li className="sessions-hint" style={{ cursor: "pointer", textDecoration: "underline" }} onClick={() => fetchSessions(next)}>
              Load more…
            </li>
          )}
        </ul>
        {detail && (
          <div className="session-detail">
            <div className="session-detail-row"><span>Agent</span><span>{detail.agent.name}</span></div>
            {detail.agent.options && Object.keys(detail.agent.options).length > 0 && (
              <div className="session-detail-row"><span>Options</span><span>{JSON.stringify(detail.agent.options)}</span></div>
            )}
            {detail.history?.full && <div className="session-detail-row"><span>Messages</span><span>{detail.history.full.length}</span></div>}
            <button onClick={() => { onLoad(detail.sessionId); onClose(); }}>
              {detail.sessionId === currentSessionId ? "Already active" : "Load session"}
            </button>
            <button className="danger" onClick={() => deleteSession(detail.sessionId)}>Delete</button>
          </div>
        )}
      </div>
    </div>
  );
}
