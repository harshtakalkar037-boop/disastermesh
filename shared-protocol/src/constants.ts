/** DMSP/1 — DisasterMesh Sync Protocol. Offsets are a contract with the Kotlin codec. */

export const DMSP_VERSION = 1;
export const FRAME_VERSION = 1;
export const MAGIC = [0x44, 0x4d, 0x53, 0x50] as const; // DMSP
export const SIGNED_HEADER_LEN = 176;
export const SIGNATURE_LEN = 64;
export const PUBKEY_LEN = 65;
export const MAX_PAYLOAD = 512;
export const MAX_PACKET = 1400;
export const MAX_HOP = 8;
export const DEFAULT_HOP_LIMIT = 5;
export const MAX_CLOCK_SKEW_MS = 120_000;
export const MAX_TTL_MS = 48 * 60 * 60 * 1000;
export const MAX_TEXT_CHARS = 120;
export const LINK_CHUNK = 160;
export const GROUP_DISTANCE_M = 150;
export const GROUP_WINDOW_MS = 30 * 60 * 1000;
export const MAX_ACCURACY_FOR_AUTO_GROUP_M = 100;
export const HIGH_CONFIDENCE_ACCURACY_M = 30;

export const Flag = {
  HAS_LOCATION: 0x01,
  HAS_INCIDENT: 0x02,
  ACK_REQUESTED: 0x08,
  IS_ACK: 0x10,
  GATEWAY_ORIGINATED: 0x20,
  SIMULATED: 0x40,
} as const;

export const PayloadType = {
  hello: 1,
  status: 2,
  disaster_report: 3,
  sos: 4,
  group: 5,
  alert: 6,
  ack: 7,
  rescue_update: 8,
  text_message: 9,
  photo_meta: 10,
  capability: 11,
  witness_delta: 12,
  heard_digest: 13,
  evidence_request: 14,
  evidence_response: 15,
  scarce_slot_decision: 16,
} as const;

export type PayloadTypeName = keyof typeof PayloadType;

export const PAYLOAD_TYPE_NAME: Record<number, PayloadTypeName> = Object.fromEntries(
  Object.entries(PayloadType).map(([name, code]) => [code, name as PayloadTypeName]),
) as Record<number, PayloadTypeName>;

export type Priority = 0 | 1 | 2 | 3 | 4;

export const PRIORITY_WEIGHT: Record<Priority, number> = { 0: 8, 1: 4, 2: 2, 3: 1, 4: 1 };

export const PRIORITY_LABEL: Record<Priority, string> = {
  0: "P0 immediate life threat",
  1: "P1 needs help",
  2: "P2 evacuation",
  3: "P3 routine status",
  4: "P4 general information",
};

export type EmergencyState = "unknown" | "need_help" | "safe" | "evacuating" | "resolved";

export type DeliveryState =
  | "queued_offline"
  | "relayed_to_peer"
  | "delivered_to_gateway"
  | "received_by_command_center"
  | "acknowledged_by_operator"
  | "expired"
  | "rejected";

export const DELIVERY_LABEL: Record<DeliveryState, string> = {
  queued_offline: "Queued offline. Rescuers have NOT received this.",
  relayed_to_peer: "Relayed to a nearby phone. This is NOT delivery to rescuers.",
  delivered_to_gateway: "A gateway accepted this for upload. Command center has NOT confirmed receipt.",
  received_by_command_center: "Command center stored this report. An operator has not necessarily seen it.",
  acknowledged_by_operator: "An operator marked this as seen. This is not a promise of rescue.",
  expired: "Expired before delivery. Not forwarded further.",
  rejected: "Rejected. Not accepted.",
};

export const INCIDENT_TYPES = [
  "flood",
  "fire",
  "earthquake",
  "landslide",
  "medical",
  "trapped",
  "missing_person",
  "blocked_road",
  "collapsed_building",
  "damaged_bridge",
  "smoke",
  "power_outage",
  "other",
] as const;

export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const EMERGENCY_STATES: EmergencyState[] = [
  "unknown",
  "need_help",
  "safe",
  "evacuating",
  "resolved",
];

export const VERIFICATION_LEVELS = [
  "unverified",
  "eyewitness",
  "corroborated",
  "conflicting",
  "official",
] as const;

export type VerificationLevel = (typeof VERIFICATION_LEVELS)[number];

/** Source authentication is not factual verification. */
export const SOURCE_AUTH = [
  "signature_valid",
  "signature_invalid",
  "gateway_authenticated",
  "unsigned_rejected",
] as const;
