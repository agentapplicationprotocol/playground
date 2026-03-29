import Header from "./Header";

interface Props {
  baseUrl: string;
  apiKey: string;
  connectError: string;
  onBaseUrlChange: (v: string) => void;
  onApiKeyChange: (v: string) => void;
  onConnect: () => void;
}

export default function ConnectScreen({ baseUrl, apiKey, connectError, onBaseUrlChange, onApiKeyChange, onConnect }: Props) {
  return (
    <div className="connect-screen">
      <Header />
      <div className="connect-body">
        <h1>Playground</h1>
        <div className="connect-form">
          <label>Base URL
            <input value={baseUrl} onChange={(e) => onBaseUrlChange(e.target.value)} placeholder="https://your-aap-server.com" />
          </label>
          <label>API Key
            <input type="password" value={apiKey} onChange={(e) => onApiKeyChange(e.target.value)} placeholder="sk-..." />
          </label>
          {connectError && <p className="error">{connectError}</p>}
          <button onClick={onConnect} disabled={!baseUrl}>Connect</button>
          <a className="example-agents-link" href="https://github.com/agentapplicationprotocol/agents" target="_blank" rel="noopener noreferrer">Example agents</a>
        </div>
      </div>
    </div>
  );
}
