import { useState } from "react";
import { MapContainer, TileLayer, Circle, Popup } from "react-leaflet";
import type { Incident } from "./api";

export function FieldMap({ incidents }: { incidents: Incident[] }) {
  const [offline, setOffline] = useState(typeof navigator !== "undefined" ? !navigator.onLine : true);
  const located = incidents.filter((i) => i.lat != null && i.lon != null);
  if (offline) return <OfflineGrid incidents={located} reason="Browser is offline or map tiles failed. This grid is not a surveyed map." />;
  const center = located[0] ? [located[0].lat as number, located[0].lon as number] as [number, number] : [18.63, 73.8] as [number, number];
  return (
    <div className="mapbox">
      <MapContainer center={center} zoom={located.length ? 13 : 5} style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution='&copy; OpenStreetMap'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          eventHandlers={{ tileerror: () => setOffline(true) }}
        />
        {located.map((incident) => (
          <Circle
            key={incident.id}
            center={[incident.lat as number, incident.lon as number]}
            radius={Math.max(incident.accuracy_m ?? 25, 15)}
            pathOptions={{ color: incident.emergency_state === "need_help" ? "#ff4d3a" : "#f0c14b", fillOpacity: 0.25 }}
          >
            <Popup>
              <strong>{incident.emergency_state}</strong>
              <div>{incident.incident_type} · accuracy {incident.accuracy_m ?? "unknown"} m</div>
              <div>Verification: {incident.verification_level}. Auth: {incident.source_auth}.</div>
              <div>{age(incident.event_timestamp)} old. Not a rescue promise.</div>
            </Popup>
          </Circle>
        ))}
      </MapContainer>
    </div>
  );
}

export function OfflineGrid({ incidents, reason }: { incidents: Incident[]; reason: string }) {
  const lats = incidents.map((i) => i.lat as number);
  const lons = incidents.map((i) => i.lon as number);
  const minLat = Math.min(...lats, 18.6);
  const maxLat = Math.max(...lats, 18.66);
  const minLon = Math.min(...lons, 73.76);
  const maxLon = Math.max(...lons, 73.84);
  const x = (lon: number) => 40 + ((lon - minLon) / Math.max(0.0001, maxLon - minLon)) * 520;
  const y = (lat: number) => 40 + ((maxLat - lat) / Math.max(0.0001, maxLat - minLat)) * 360;
  return (
    <div className="gridmap" role="img" aria-label="Offline coordinate grid">
      <svg viewBox="0 0 600 440" width="100%" height="100%">
        <rect width="600" height="440" fill="#17140f" />
        {Array.from({ length: 8 }, (_, i) => (
          <g key={i} stroke="#3c352c">
            <line x1={40 + i * 70} y1={20} x2={40 + i * 70} y2={400} />
            <line x1={20} y1={40 + i * 48} x2={580} y2={40 + i * 48} />
          </g>
        ))}
        {incidents.map((incident) => (
          <g key={incident.id}>
            <circle cx={x(incident.lon as number)} cy={y(incident.lat as number)} r={8} fill={incident.emergency_state === "need_help" ? "#ff4d3a" : "#f0c14b"} />
            <text x={x(incident.lon as number) + 10} y={y(incident.lat as number)} fill="#f6f1e7" fontSize="12">{incident.incident_type}</text>
          </g>
        ))}
        <text x="20" y="428" fill="#f0c14b" fontSize="13">{reason}</text>
      </svg>
    </div>
  );
}

export function age(ms: number): string {
  const delta = Date.now() - Number(ms);
  if (!Number.isFinite(delta)) return "unknown age";
  const min = Math.round(delta / 60000);
  if (Math.abs(min) < 1) return "just now";
  if (Math.abs(min) < 60) return `${min} min`;
  return `${Math.round(min / 60)} h`;
}

export function stale(ms: number): boolean {
  return Date.now() - Number(ms) > 30 * 60_000;
}
