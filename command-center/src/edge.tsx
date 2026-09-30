import { useState } from "react";
import { api } from "./api";
import { useApi } from "./ui";

interface Witness {
  id: string;
  origin_pseudonym: string;
  incident_type: string;
  claimed_state: string;
  people_count: number | null;
  waterline_band: string;
  confidence: number;
  evidence_hash: string | null;
  inference: string;
  self_conflict: boolean;
  summary_text: string;
  gate_decision: string | null;
  gate_reason: string | null;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  event_timestamp: number;
}

interface EdgeBoard {
  witnesses: Witness[];
  heard: { origin: string; heard: string[]; batteryBucket: string; heldMessageId: string | null }[];
  unheard: { id: string; label: "UNHEARD"; safe: false }[];
  unheardNote: string;
  conflicts: { field: string; left_value: string | null; right_value: string | null; left_message_id: string }[];
  averaged: boolean;
  gate: { decision: string; reason: string; fragments_saved: number }[];
  fragmentsSaved: number;
  evidence: { id: string; status: string; expected_hash: string | null; verify_reason: string | null }[];
  officeKit: { officeKit: string; note: string };
  mediaOnMesh: boolean;
  localModel: string;
}

export function EdgePage() {
  const { data, error, loading, reload } = useApi<EdgeBoard>("/api/v1/edge");
  const [paste, setPaste] = useState("");
  const [note, setNote] = useState("");
  if (loading) return <p>Loading stored edge records…</p>;
  if (error) return <p>{error}</p>;
  if (!data) return <p>No edge records.</p>;
  async function request(witnessId: string) {
    const result = await api<{ id: string; status: string }>("/api/v1/edge/evidence/request", {
      method: "POST",
      body: JSON.stringify({ witnessId, explicit: true }),
    });
    setNote(`Request ${result.id} is ${result.status}. Media is not on the mesh.`);
    reload();
  }
  async function verify(requestId: string) {
    const result = await api<{ ok: boolean; reason: string }>("/api/v1/edge/evidence/verify", {
      method: "POST",
      body: JSON.stringify({ requestId, bytesBase64: btoa(paste) }),
    });
    setNote(result.ok ? "Hash matches. Clipboard was treated as untrusted." : `Rejected: ${result.reason}`);
    reload();
  }
  return (
    <div>
      <h1>Edge</h1>
      <p>Witness cards, heard-cut, and hash-only evidence. Counts are not averaged. {data.unheardNote}. Local model: {data.localModel}. Office Kit: {data.officeKit.officeKit}. {data.officeKit.note}</p>
      <div className="grid">
        <div className="card"><span>Witness cards</span><b>{data.witnesses.length}</b></div>
        <div className="card"><span>Conflicts kept separate</span><b>{data.conflicts.length}</b></div>
        <div className="card"><span>Fragments not sent</span><b>{data.fragmentsSaved}</b></div>
        <div className="card"><span>Unheard</span><b>{data.unheard.length}</b></div>
      </div>
      <section className="panel">
        <h2>Witness</h2>
        {data.witnesses.length === 0 && <p>No confirmed witness packets stored.</p>}
        {data.witnesses.map((row) => (
          <article key={row.id} className="card">
            <strong>{row.incident_type}</strong> · {row.claimed_state} · people {row.people_count ?? "unstated"} · water {row.waterline_band}
            <p>{row.summary_text}</p>
            <p>confidence {row.confidence} · inference {row.inference}{row.self_conflict ? " · self-conflict" : ""} · gate {row.gate_decision ?? "not recorded"} {row.gate_reason ?? ""}</p>
            <p>location {row.lat ?? "none"}, {row.lon ?? "none"} · accuracy {row.accuracy_m ?? "unknown"} m · time {row.event_timestamp}</p>
            <p>evidence hash {row.evidence_hash ?? "none"} · media not attached</p>
            <button className="btn primary" onClick={() => request(row.id)}>Request original</button>
          </article>
        ))}
      </section>
      <section className="panel">
        <h2>Conflicts</h2>
        {data.conflicts.length === 0 && <p>No signed disagreement stored.</p>}
        {data.conflicts.map((row) => <p key={row.left_message_id}>{row.field}: {row.left_value} and {row.right_value} stay separate. Not averaged.</p>)}
      </section>
      <section className="panel">
        <h2>Heard-cut</h2>
        <p>{data.unheardNote}</p>
        {data.heard.map((row) => <p key={row.origin}>origin {row.origin.slice(0, 8)} heard {row.heard.length} pseudonyms · battery {row.batteryBucket} · held {row.heldMessageId ?? "none"}</p>)}
        {data.unheard.map((row) => <p key={row.id}>{row.id.slice(0, 8)} is UNHEARD. This is not SAFE.</p>)}
      </section>
      <section className="panel">
        <h2>Evidence</h2>
        <p>Starts hash-only. Paste is untrusted and cannot carry a command.</p>
        <textarea value={paste} onChange={(event) => setPaste(event.target.value)} placeholder="Paste original bytes as text. This is not trusted." />
        {data.evidence.map((row) => (
          <p key={row.id}>{row.status} · {row.expected_hash ?? "no hash"} · {row.verify_reason ?? "not verified"} <button className="btn ghost" onClick={() => verify(row.id)}>Verify paste</button></p>
        ))}
        {note && <p>{note}</p>}
      </section>
      <section className="panel">
        <h2>Scarce-slot</h2>
        {data.gate.length === 0 && <p>No gate decisions stored.</p>}
        {data.gate.map((row, index) => <p key={`${row.decision}-${index}`}>{row.decision} · {row.reason} · fragments saved {row.fragments_saved}</p>)}
      </section>
    </div>
  );
}
