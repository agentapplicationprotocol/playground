import { useState } from "react";
import type { ToolSpec, ServerToolRef } from "@agentapplicationprotocol/core";

export interface ClientTool {
  spec: ToolSpec;
  code: string; // JS function body, receives `input` object, returns string
  trust: boolean;
}

export interface ServerToolState {
  name: string;
  enabled: boolean;
  trust: boolean;
}

interface Props {
  clientTools: ClientTool[];
  onClientToolsChange: (tools: ClientTool[]) => void;
  serverTools: ServerToolState[];
  onServerToolsChange: (tools: ServerToolState[]) => void;
  clientToolsSupported: boolean;
}

const EMPTY: ClientTool = {
  spec: {
    name: "calculator",
    description: "Perform basic arithmetic operations",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Math expression to evaluate, e.g. '2 + 3 * 4'",
        },
      },
      required: ["expression"],
    },
  },
  code: "return String(eval(input.expression));",
  trust: false,
};

export function toServerToolRefs(tools: ServerToolState[]): ServerToolRef[] {
  return tools.filter((t) => t.enabled).map((t) => ({ name: t.name, trust: t.trust }));
}

export default function ToolManager({
  clientTools,
  onClientToolsChange,
  serverTools,
  onServerToolsChange,
  clientToolsSupported,
}: Props) {
  const [editing, setEditing] = useState<ClientTool | null>(null);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [schemaError, setSchemaError] = useState("");

  function openNew() {
    setEditing(structuredClone(EMPTY));
    setEditIndex(null);
    setSchemaError("");
  }
  function openEdit(i: number) {
    setEditing(structuredClone(clientTools[i]));
    setEditIndex(i);
    setSchemaError("");
  }
  function removeClient(i: number) {
    onClientToolsChange(clientTools.filter((_, j) => j !== i));
  }
  function toggleClientTrust(i: number) {
    const next = [...clientTools];
    next[i] = { ...next[i], trust: !next[i].trust };
    onClientToolsChange(next);
  }

  function save() {
    if (!editing) return;
    try {
      const schema =
        typeof editing.spec.inputSchema === "string"
          ? JSON.parse(editing.spec.inputSchema as unknown as string)
          : editing.spec.inputSchema;
      const tool: ClientTool = { ...editing, spec: { ...editing.spec, inputSchema: schema } };
      if (editIndex !== null) {
        const next = [...clientTools];
        next[editIndex] = tool;
        onClientToolsChange(next);
      } else {
        onClientToolsChange([...clientTools, tool]);
      }
      setEditing(null);
    } catch {
      setSchemaError("Invalid JSON schema");
    }
  }

  function toggleEnabled(i: number) {
    const next = [...serverTools];
    next[i] = { ...next[i], enabled: !next[i].enabled };
    onServerToolsChange(next);
  }

  function toggleTrust(i: number) {
    const next = [...serverTools];
    next[i] = { ...next[i], trust: !next[i].trust };
    onServerToolsChange(next);
  }

  return (
    <div className="tool-section">
      {/* Server tools */}
      {serverTools.length > 0 && (
        <div className="tool-bar">
          <span className="tool-label">Server tools:</span>
          {serverTools.map((t, i) => (
            <span key={t.name} className={`tool-chip server-tool ${t.enabled ? "" : "disabled"}`}>
              <span onClick={() => toggleEnabled(i)} title="Toggle enabled">
                {t.name}
              </span>
              {t.enabled && (
                <span
                  className={`trust-badge ${t.trust ? "trusted" : ""}`}
                  onClick={() => toggleTrust(i)}
                  title="Toggle trust"
                >
                  {t.trust ? "trusted" : "untrusted"}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Client tools */}
      {editing ? (
        <div className="tool-editor">
          <div className="tool-editor-row">
            <label>
              Name
              <input
                value={editing.spec.name}
                onChange={(e) =>
                  setEditing((t) => ({ ...t!, spec: { ...t!.spec, name: e.target.value } }))
                }
              />
            </label>
            <label>
              Description
              <input
                value={editing.spec.description}
                onChange={(e) =>
                  setEditing((t) => ({ ...t!, spec: { ...t!.spec, description: e.target.value } }))
                }
              />
            </label>
          </div>
          <label>
            Input Schema (JSON)
            <textarea
              rows={4}
              value={
                typeof editing.spec.inputSchema === "string"
                  ? (editing.spec.inputSchema as unknown as string)
                  : JSON.stringify(editing.spec.inputSchema, null, 2)
              }
              onChange={(e) =>
                setEditing((t) => ({
                  ...t!,
                  spec: {
                    ...t!.spec,
                    inputSchema: e.target.value as unknown as ToolSpec["inputSchema"],
                  },
                }))
              }
            />
            {schemaError && <span className="error">{schemaError}</span>}
          </label>
          <label>
            Function body{" "}
            <span className="hint">
              (receives <code>input</code>, must return a string)
            </span>
            <textarea
              rows={4}
              value={editing.code}
              onChange={(e) => setEditing((t) => ({ ...t!, code: e.target.value }))}
            />
          </label>
          <div className="tool-editor-actions">
            <button onClick={save} disabled={!editing.spec.name}>
              Save
            </button>
            <button className="disconnect" onClick={() => setEditing(null)}>
              Cancel
            </button>
            {editIndex !== null && (
              <button
                className="disconnect"
                onClick={() => {
                  removeClient(editIndex);
                  setEditing(null);
                }}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className={`tool-bar${clientToolsSupported ? "" : " disabled"}`}>
          <span className="tool-label">Client tools:</span>
          {clientToolsSupported ? (
            <>
              {clientTools.map((t, i) => (
                <span key={i} className="tool-chip server-tool">
                  <span onClick={() => openEdit(i)}>{t.spec.name}</span>
                  <span
                    className={`trust-badge ${t.trust ? "trusted" : ""}`}
                    onClick={() => toggleClientTrust(i)}
                    title="Toggle trust"
                  >
                    {t.trust ? "trusted" : "untrusted"}
                  </span>
                </span>
              ))}
              <button className="tool-add" onClick={openNew}>
                + Add Tool
              </button>
            </>
          ) : (
            <span className="tool-unsupported">not supported by this agent</span>
          )}
        </div>
      )}
    </div>
  );
}
