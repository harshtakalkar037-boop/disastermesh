import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { OverviewPage } from "./pages";
import { Banner } from "./ui";

describe("command center honesty", () => {
  it("shows the prototype disclaimer", () => {
    render(<Banner />);
    expect(screen.getByText(/NOT A CERTIFIED EMERGENCY SERVICE/)).toBeInTheDocument();
  });

  it("renders zeros from the API instead of sample disaster statistics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      source: "live",
      counts: { reports: 0, statedPeople: 0, safe: 0, needHelp: 0, evacuating: 0, unknown: 0, resolved: 0 },
      activeIncidents: 0,
      groups: 0,
      teams: 0,
      lastSyncAt: null,
      disclaimer: "Prototype counts from stored records.",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    render(<MemoryRouter><OverviewPage /></MemoryRouter>);
    expect(await screen.findByText("Need help")).toBeInTheDocument();
    expect(screen.getAllByText("0").length).toBeGreaterThan(3);
    expect(screen.queryByText(/12,480/)).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
