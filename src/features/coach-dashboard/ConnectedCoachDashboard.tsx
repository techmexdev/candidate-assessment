"use client";

import { useMemo } from "react";

import { CoachDashboard } from "./CoachDashboard";
import type { DashboardAdapter } from "./dashboard-contract";
import { createFetchDashboardCopilotClient } from "./production-adapter";
import { createDashboardWorkoutRuntime, createFetchDashboardWorkoutRuntimeClient } from "./runtime-adapter";
import { syntheticDashboardBase } from "./synthetic-dashboard-base";

export function createProductionDashboardAdapter(): DashboardAdapter {
  return {
    initialState: { status: "ready", data: syntheticDashboardBase },
    load: async () => ({ status: "ready", data: syntheticDashboardBase }),
    capabilities: {
      startNewDraft: { available: false, reason: "New drafts require a connected coaching service." },
      workoutGeneration: { available: true, runtime: createDashboardWorkoutRuntime(createFetchDashboardWorkoutRuntimeClient()) },
      copilot: {
        available: true,
        client: createFetchDashboardCopilotClient(),
        supportsMember: (memberId) => memberId === syntheticDashboardBase.member.id,
      },
    },
  };
}

export function ConnectedCoachDashboard() {
  const adapter = useMemo(() => createProductionDashboardAdapter(), []);
  return <CoachDashboard adapter={adapter} />;
}
