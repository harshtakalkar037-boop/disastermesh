import {
  GROUP_DISTANCE_M,
  GROUP_WINDOW_MS,
  HIGH_CONFIDENCE_ACCURACY_M,
  MAX_ACCURACY_FOR_AUTO_GROUP_M,
} from "./constants.js";

export interface ReportPoint {
  id: string;
  incidentType: string;
  eventTimestampMs: number;
  lat?: number | null;
  lon?: number | null;
  accuracyM?: number | null;
  /** Present only to prove the engine ignores radio proximity. */
  rssiDbm?: number | null;
  state?: string;
}

export interface ProximityDecision {
  cluster: boolean;
  confidence: "high" | "low" | "unknown";
  reason: string;
  distanceM: number | null;
}

export interface GroupRecord {
  id: string;
  incidentType: string;
  memberIds: string[];
  confidence: "high" | "low" | "unknown";
  centroidLat: number | null;
  centroidLon: number | null;
}

export interface LineageEvent {
  type: "create" | "join" | "leave" | "merge" | "split";
  groupId: string;
  otherGroupId?: string;
  memberIds: string[];
  at: number;
  reason: string;
}

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Conservative co-location. BLE RSSI is intentionally unread.
 * Cluster only when distance plus both accuracy radii is still within 150 m,
 * both accuracies are known and ≤ 100 m, types match, and timestamps are within 30 min.
 */
export function proximityDecision(a: ReportPoint, b: ReportPoint): ProximityDecision {
  if (a.incidentType !== b.incidentType) {
    return { cluster: false, confidence: "unknown", reason: "type_mismatch", distanceM: null };
  }
  if (Math.abs(a.eventTimestampMs - b.eventTimestampMs) > GROUP_WINDOW_MS) {
    return { cluster: false, confidence: "unknown", reason: "time_window", distanceM: null };
  }
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) {
    return { cluster: false, confidence: "unknown", reason: "location_missing", distanceM: null };
  }
  if (a.accuracyM == null || b.accuracyM == null) {
    return { cluster: false, confidence: "unknown", reason: "accuracy_missing", distanceM: null };
  }
  const distanceM = haversineM(a.lat, a.lon, b.lat, b.lon);
  if (a.accuracyM > MAX_ACCURACY_FOR_AUTO_GROUP_M || b.accuracyM > MAX_ACCURACY_FOR_AUTO_GROUP_M) {
    return { cluster: false, confidence: "unknown", reason: "accuracy_too_coarse", distanceM };
  }
  if (distanceM + a.accuracyM + b.accuracyM <= GROUP_DISTANCE_M) {
    const confidence =
      a.accuracyM <= HIGH_CONFIDENCE_ACCURACY_M && b.accuracyM <= HIGH_CONFIDENCE_ACCURACY_M
        ? "high"
        : "low";
    return { cluster: true, confidence, reason: "within_conservative_radius", distanceM };
  }
  return { cluster: false, confidence: "unknown", reason: "too_far", distanceM };
}

interface MutableGroup {
  id: string;
  incidentType: string;
  members: ReportPoint[];
  confidence: "high" | "low" | "unknown";
}

function canAllPairs(members: ReportPoint[], extra: ReportPoint[] = []): boolean {
  const all = members.concat(extra);
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (!proximityDecision(all[i], all[j]).cluster) return false;
    }
  }
  return all.length >= 1;
}

function confidenceOf(members: ReportPoint[]): "high" | "low" | "unknown" {
  let worst: "high" | "low" | "unknown" = "high";
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const d = proximityDecision(members[i], members[j]);
      if (!d.cluster) return "unknown";
      if (d.confidence === "low") worst = "low";
    }
  }
  return members.length >= 2 ? worst : "unknown";
}

function centroid(members: ReportPoint[]): { lat: number | null; lon: number | null } {
  const located = members.filter((m) => m.lat != null && m.lon != null);
  if (located.length === 0) return { lat: null, lon: null };
  const lat = located.reduce((s, m) => s + (m.lat as number), 0) / located.length;
  const lon = located.reduce((s, m) => s + (m.lon as number), 0) / located.length;
  return { lat, lon };
}

function toRecord(g: MutableGroup): GroupRecord {
  const c = centroid(g.members);
  return {
    id: g.id,
    incidentType: g.incidentType,
    memberIds: g.members.map((m) => m.id),
    confidence: g.confidence,
    centroidLat: c.lat,
    centroidLon: c.lon,
  };
}

export interface ClusterResult {
  groups: GroupRecord[];
  lineage: LineageEvent[];
  ungrouped: { id: string; reason: string }[];
  /** Always false. Grouping never treats radio proximity as physical presence. */
  usedRadioProximity: false;
}

export function clusterReports(reports: ReportPoint[]): ClusterResult {
  const pending: MutableGroup[] = [];
  const lineage: LineageEvent[] = [];
  const sorted = [...reports].sort((a, b) => a.eventTimestampMs - b.eventTimestampMs || a.id.localeCompare(b.id));
  for (const report of sorted) {
    const candidates = pending.filter(
      (g) => g.incidentType === report.incidentType && canAllPairs(g.members, [report]),
    );
    if (candidates.length === 0) {
      pending.push({
        id: `pending:${report.id}`,
        incidentType: report.incidentType,
        members: [report],
        confidence: "unknown",
      });
      continue;
    }
    candidates.sort((a, b) => {
      const ca = centroid(a.members);
      const cb = centroid(b.members);
      const da = ca.lat == null || report.lat == null ? Number.POSITIVE_INFINITY : haversineM(ca.lat, ca.lon as number, report.lat, report.lon as number);
      const db = cb.lat == null || report.lat == null ? Number.POSITIVE_INFINITY : haversineM(cb.lat, cb.lon as number, report.lat, report.lon as number);
      return da - db;
    });
    const chosen = candidates[0];
    const born = chosen.members.length === 1;
    chosen.members.push(report);
    chosen.confidence = confidenceOf(chosen.members);
    if (born) {
      chosen.id = `grp:${chosen.members[0].id}:${report.id}`;
      lineage.push({
        type: "create",
        groupId: chosen.id,
        memberIds: chosen.members.map((m) => m.id),
        at: report.eventTimestampMs,
        reason: "conservative_proximity",
      });
    } else {
      lineage.push({
        type: "join",
        groupId: chosen.id,
        memberIds: [report.id],
        at: report.eventTimestampMs,
        reason: "conservative_proximity",
      });
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < pending.length && !changed; i += 1) {
      for (let j = i + 1; j < pending.length; j += 1) {
        if (pending[i].incidentType !== pending[j].incidentType) continue;
        if (pending[i].members.length + pending[j].members.length < 2) continue;
        if (!canAllPairs(pending[i].members, pending[j].members)) continue;
        const keep = pending[i];
        const drop = pending[j];
        const at = Math.max(...drop.members.map((m) => m.eventTimestampMs));
        if (keep.members.length === 1 && drop.members.length === 1) {
          keep.id = `grp:${keep.members[0].id}:${drop.members[0].id}`;
          lineage.push({
            type: "create",
            groupId: keep.id,
            memberIds: [keep.members[0].id, drop.members[0].id],
            at,
            reason: "conservative_proximity",
          });
        } else {
          if (keep.members.length === 1) keep.id = drop.id;
          lineage.push({
            type: "merge",
            groupId: keep.id,
            otherGroupId: drop.members.length === 1 ? undefined : drop.id,
            memberIds: drop.members.map((m) => m.id),
            at,
            reason: "conservative_proximity",
          });
        }
        keep.members.push(...drop.members);
        keep.confidence = confidenceOf(keep.members);
        pending.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  const groups = pending.filter((g) => g.members.length >= 2).map(toRecord);
  const ungrouped = pending
    .filter((g) => g.members.length < 2)
    .map((g) => ({ id: g.members[0].id, reason: ungroupedReason(g.members[0], reports) }));
  return { groups, lineage, ungrouped, usedRadioProximity: false };
}

function ungroupedReason(report: ReportPoint, all: ReportPoint[]): string {
  const others = all.filter((r) => r.id !== report.id);
  if (others.length === 0) return "no_other_reports";
  const decisions = others.map((o) => proximityDecision(report, o).reason);
  if (decisions.every((d) => d === "location_missing" || d === "accuracy_missing")) return decisions[0];
  if (decisions.includes("accuracy_too_coarse")) return "accuracy_too_coarse";
  if (decisions.includes("too_far")) return "too_far";
  if (decisions.includes("type_mismatch")) return "type_mismatch";
  if (decisions.includes("time_window")) return "time_window";
  return decisions[0] ?? "unclustered";
}

export function diffGroups(previous: GroupRecord[], next: GroupRecord[], at: number): LineageEvent[] {
  const events: LineageEvent[] = [];
  const nextOf = new Map<string, string>();
  for (const g of next) for (const id of g.memberIds) nextOf.set(id, g.id);
  const seenSplits = new Set<string>();
  for (const old of previous) {
    const destinations = new Map<string, string[]>();
    const gone: string[] = [];
    for (const id of old.memberIds) {
      const dest = nextOf.get(id);
      if (!dest) gone.push(id);
      else {
        const list = destinations.get(dest) ?? [];
        list.push(id);
        destinations.set(dest, list);
      }
    }
    if (destinations.size >= 2) {
      seenSplits.add(old.id);
      events.push({
        type: "split",
        groupId: old.id,
        memberIds: old.memberIds,
        at,
        reason: "members_no_longer_within_conservative_radius",
      });
    }
    for (const id of gone) {
      events.push({ type: "leave", groupId: old.id, memberIds: [id], at, reason: "report_removed_or_ungrouped" });
    }
  }
  const prevMembers = new Map(previous.map((g) => [g.id, new Set(g.memberIds)]));
  for (const g of next) {
    const overlapping = previous.filter((old) => old.memberIds.some((id) => g.memberIds.includes(id)));
    if (overlapping.length >= 2) {
      events.push({
        type: "merge",
        groupId: g.id,
        otherGroupId: overlapping[1].id,
        memberIds: g.memberIds,
        at,
        reason: "groups_now_within_conservative_radius",
      });
    } else if (overlapping.length === 1) {
      const before = prevMembers.get(overlapping[0].id)!;
      for (const id of g.memberIds) {
        if (!before.has(id)) {
          events.push({ type: "join", groupId: g.id, memberIds: [id], at, reason: "membership_changed" });
        }
      }
    } else if (overlapping.length === 0) {
      events.push({ type: "create", groupId: g.id, memberIds: g.memberIds, at, reason: "new_group" });
    }
  }
  return events;
}

export interface DuplicateHint {
  a: string;
  b: string;
  distanceM: number;
  note: string;
}

export function suggestDuplicates(reports: ReportPoint[], windowMs = 20 * 60 * 1000): DuplicateHint[] {
  const hints: DuplicateHint[] = [];
  for (let i = 0; i < reports.length; i += 1) {
    for (let j = i + 1; j < reports.length; j += 1) {
      const a = reports[i];
      const b = reports[j];
      if (a.incidentType !== b.incidentType) continue;
      if (Math.abs(a.eventTimestampMs - b.eventTimestampMs) > windowMs) continue;
      if (a.lat == null || b.lat == null || a.lon == null || b.lon == null) continue;
      const distanceM = haversineM(a.lat, a.lon, b.lat, b.lon);
      const acc = (a.accuracyM ?? 1000) + (b.accuracyM ?? 1000);
      if (distanceM <= 100 && acc <= 200) {
        hints.push({
          a: a.id,
          b: b.id,
          distanceM,
          note: "Possible duplicate. Operator must confirm. Not automatically merged.",
        });
      }
    }
  }
  return hints;
}

export interface ContradictionHint {
  a: string;
  b: string;
  note: string;
}

export function findContradictions(reports: ReportPoint[]): ContradictionHint[] {
  const hints: ContradictionHint[] = [];
  for (let i = 0; i < reports.length; i += 1) {
    for (let j = i + 1; j < reports.length; j += 1) {
      const a = reports[i];
      const b = reports[j];
      if (!a.state || !b.state) continue;
      const opposed =
        (a.state === "safe" && b.state === "need_help") || (a.state === "need_help" && b.state === "safe");
      if (!opposed) continue;
      const decision = proximityDecision({ ...a, incidentType: a.incidentType || "other" }, { ...b, incidentType: a.incidentType || "other" });
      const near = a.lat != null && b.lat != null && a.lon != null && b.lon != null && haversineM(a.lat, a.lon, b.lat, b.lon) < 200;
      if (decision.cluster || near) {
        hints.push({
          a: a.id,
          b: b.id,
          note: "Conflicting SAFE and NEED HELP reports nearby. Do not treat either as verified. Silence is not safety.",
        });
      }
    }
  }
  return hints;
}

export class GroupTracker {
  private reports = new Map<string, ReportPoint>();
  private groups: GroupRecord[] = [];
  readonly history: LineageEvent[] = [];

  upsert(report: ReportPoint, at = report.eventTimestampMs): ClusterResult {
    this.reports.set(report.id, report);
    return this.recompute(at);
  }

  remove(id: string, at: number): ClusterResult {
    this.reports.delete(id);
    return this.recompute(at);
  }

  snapshot(): { groups: GroupRecord[]; reports: ReportPoint[] } {
    return { groups: this.groups.map((g) => ({ ...g, memberIds: [...g.memberIds] })), reports: [...this.reports.values()] };
  }

  private recompute(at: number): ClusterResult {
    const result = clusterReports([...this.reports.values()]);
    const events = diffGroups(this.groups, result.groups, at);
    this.history.push(...events);
    this.groups = result.groups;
    return { ...result, lineage: events };
  }
}
