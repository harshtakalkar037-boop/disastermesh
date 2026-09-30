import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EdgePage } from "./edge";

describe("edge desk", () => {
  it("keeps conflicting counts separate and does not call unheard safe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      witnesses: [],
      heard: [],
      unheard: [{ id: "cd".repeat(16), label: "UNHEARD", safe: false }],
      unheardNote: "UNHEARD ≠ SAFE",
      conflicts: [{ field: "people_count", left_value: "3", right_value: "9", left_message_id: "a" }],
      averaged: false,
      gate: [],
      fragmentsSaved: 0,
      evidence: [],
      officeKit: { officeKit: "UNAVAILABLE", note: "Office Kit SDK is not present." },
      mediaOnMesh: false,
      localModel: "MODEL_UNAVAILABLE",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    render(<EdgePage />);
    expect(await screen.findByText("UNHEARD ≠ SAFE")).toBeInTheDocument();
    expect(screen.getByText(/stay separate/)).toBeInTheDocument();
    expect(screen.getByText(/This is not SAFE/)).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
