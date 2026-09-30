export type Role = "admin" | "operator" | "responder" | "alert_publisher";

const TOKEN = "disastermesh.token";

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN);
}

export function setToken(token: string | null) {
  if (token) sessionStorage.setItem(TOKEN, token);
  else sessionStorage.removeItem(TOKEN);
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch { /* keep status text */ }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  const type = response.headers.get("content-type") || "";
  if (!type.includes("json")) return undefined as T;
  return response.json() as Promise<T>;
}

export interface Summary {
  source: "live" | "simulator";
  counts: { reports: number; statedPeople: number; safe: number; needHelp: number; evacuating: number; unknown: number; resolved: number };
  activeIncidents: number;
  groups: number;
  teams: number;
  lastSyncAt: number | null;
  disclaimer: string;
}

export interface Incident {
  id: string;
  incident_type: string;
  emergency_state: string;
  priority: number;
  people_count: number | null;
  summary_text: string | null;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  event_timestamp: number;
  received_at: number;
  verification_level: string;
  source_auth: string;
  simulated: boolean;
  assigned_team_id: string | null;
  language: string | null;
}
