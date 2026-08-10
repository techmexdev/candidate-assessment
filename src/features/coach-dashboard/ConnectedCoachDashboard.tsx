"use client";

import { useMemo } from "react";

import { CoachDashboard } from "./CoachDashboard";
import type { DashboardAdapter } from "./dashboard-contract";
import { createFetchDashboardCopilotClient, createFetchDashboardFullGraphClient, createFetchDashboardSessionClient } from "./production-adapter";
import { createFetchDashboardConversationClient } from "./conversation-adapter";
import { createDashboardWorkoutRuntime, createFetchDashboardWorkoutRuntimeClient } from "./runtime-adapter";
import { syntheticDashboardBase } from "./synthetic-dashboard-base";

export function createProductionDashboardAdapter(): DashboardAdapter {
  return {
    initialState: { status: "ready", data: syntheticDashboardBase },
    load: async () => ({ status: "ready", data: syntheticDashboardBase }),
    capabilities: {
      session: { available: true, client: createFetchDashboardSessionClient() },
      startNewDraft: { available: false, reason: "New drafts require a connected coaching service." },
      workoutGeneration: { available: true, runtime: createDashboardWorkoutRuntime(createFetchDashboardWorkoutRuntimeClient()) },
      copilot: {
        available: true,
        client: createFetchDashboardCopilotClient(),
        supportsMember: (memberId) => Object.hasOwn(syntheticDashboardBase.workspace.memberViews, memberId),
      },
      conversation: { available: true, client: createFetchDashboardConversationClient() },
      fullGraph: {
        available: true,
        client: createFetchDashboardFullGraphClient(),
        supports: (input) => input.domain === "movement-clinical"
          ? input.memberId === undefined
          : typeof input.memberId === "string" && input.memberId.length > 0,
      },
    },
  };
}

export function ConnectedCoachDashboard() {
  const adapter = useMemo(() => createProductionDashboardAdapter(), []);
  return <CoachDashboard adapter={adapter} />;
}
