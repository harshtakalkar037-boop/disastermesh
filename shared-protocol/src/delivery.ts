import type { DeliveryState } from "./constants.js";

const NEXT: Record<DeliveryState, DeliveryState[]> = {
  queued_offline: ["relayed_to_peer", "delivered_to_gateway", "received_by_command_center", "expired", "rejected"],
  relayed_to_peer: ["relayed_to_peer", "delivered_to_gateway", "received_by_command_center", "expired", "rejected"],
  delivered_to_gateway: ["received_by_command_center", "queued_offline", "expired", "rejected"],
  received_by_command_center: ["acknowledged_by_operator"],
  acknowledged_by_operator: [],
  expired: [],
  rejected: [],
};

export function canTransition(from: DeliveryState, to: DeliveryState): boolean {
  return NEXT[from].includes(to);
}

export function transition(from: DeliveryState, to: DeliveryState): { ok: true; state: DeliveryState } | { ok: false; error: string } {
  if (!canTransition(from, to)) {
    return { ok: false, error: `illegal delivery transition ${from} -> ${to}` };
  }
  return { ok: true, state: to };
}

/** Silence must never be displayed as safe. */
export function statusOrUnknown(state: string | null | undefined): "unknown" | "need_help" | "safe" | "evacuating" | "resolved" {
  if (state === "need_help" || state === "safe" || state === "evacuating" || state === "resolved") return state;
  return "unknown";
}
