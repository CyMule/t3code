import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { resolveEnvironmentMachineKind, type EnvironmentId } from "@t3tools/contracts";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { type EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useClientSettings } from "./useSettings";
import { useScratchProject } from "./useScratchProject";

export function useScratchDraftEnvironment({
  draftId,
  activeProject,
  canSwitch,
}: {
  draftId: DraftId | null;
  activeProject: EnvironmentProject | null;
  canSwitch: () => boolean;
}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const { openScratchProject } = useScratchProject();
  const isScratchDraft = Boolean(
    draftId &&
    activeProject &&
    isScratchProject(
      activeProject,
      environments.find((env) => env.environmentId === activeProject.environmentId)?.serverConfig
        ?.scratchWorkspaceRoot,
    ),
  );
  const availableEnvironments = useMemo(
    () =>
      environments
        .filter(
          (env) => env.connection.phase === "connected" && env.serverConfig?.scratchWorkspaceRoot,
        )
        .map((env) => ({
          environmentId: env.environmentId,
          label: env.label,
          isPrimary: env.environmentId === primaryEnvironmentId,
          machine: resolveEnvironmentMachineKind(env.serverConfig),
        }))
        .sort((a, b) =>
          a.isPrimary !== b.isPrimary ? (a.isPrimary ? -1 : 1) : a.label.localeCompare(b.label),
        ),
    [environments, primaryEnvironmentId],
  );
  const sourceKey = `${draftId}:${activeProject?.environmentId}:${activeProject?.id}`;
  const requestRef = useRef<{ environmentId: EnvironmentId; sourceKey: string } | null>(null);
  const [pendingRequest, setPendingRequest] = useState<typeof requestRef.current>(null);
  const pending = pendingRequest?.sourceKey === sourceKey;
  useLayoutEffect(
    () => () => {
      if (requestRef.current?.sourceKey === sourceKey) requestRef.current = null;
      setPendingRequest((current) => (current?.sourceKey === sourceKey ? null : current));
    },
    [sourceKey],
  );

  const selectEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      if (!isScratchDraft || !draftId || !activeProject || !canSwitch()) return;
      if (!availableEnvironments.some((env) => env.environmentId === environmentId)) return;
      const request = { environmentId, sourceKey };
      requestRef.current = request;
      if (environmentId === activeProject.environmentId) {
        requestRef.current = null;
        setPendingRequest(null);
        return;
      }
      setPendingRequest(request);
      try {
        const project = await openScratchProject(environmentId);
        if (requestRef.current !== request || !project || !canSwitch()) return;
        const store = useComposerDraftStore.getState();
        const draft = store.getDraftSession(draftId);
        if (
          !draft ||
          draft.promotedTo ||
          draft.environmentId !== activeProject.environmentId ||
          draft.projectId !== activeProject.id
        )
          return;
        // Remap the logical-project index as well as the physical target. The composer
        // session stays in place, preserving its prompt and model/mode selections.
        store.setLogicalProjectDraftThreadId(
          deriveLogicalProjectKeyFromSettings(project, settings),
          scopeProjectRef(project.environmentId, project.id),
          draftId,
        );
        store.setDraftThreadContext(draftId, {
          environmentSelection: "manual",
          loadBalancedEnvironmentId: null,
          envMode: "local",
        });
      } finally {
        if (requestRef.current === request) {
          requestRef.current = null;
        }
        setPendingRequest((current) => (current === request ? null : current));
      }
    },
    [
      activeProject,
      availableEnvironments,
      canSwitch,
      draftId,
      isScratchDraft,
      openScratchProject,
      settings,
      sourceKey,
    ],
  );

  const cycleEnvironment = useCallback(() => {
    const currentId = requestRef.current?.environmentId ?? activeProject?.environmentId;
    const index = availableEnvironments.findIndex((env) => env.environmentId === currentId);
    const next = availableEnvironments[(index + 1) % availableEnvironments.length];
    if (next && availableEnvironments.length > 1) void selectEnvironment(next.environmentId);
  }, [activeProject?.environmentId, availableEnvironments, selectEnvironment]);

  return {
    isScratchDraft,
    availableEnvironments,
    selectEnvironment,
    cycleEnvironment,
    pending,
    requestRef,
  };
}
