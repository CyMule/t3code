import { useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { type DraftId } from "../composerDraftStore";
import { useScratchDraftEnvironment } from "./useScratchDraftEnvironment";

const state = vi.hoisted(() => ({
  open: vi.fn(),
  remap: vi.fn(),
  context: vi.fn(),
  getDraft: vi.fn(),
}));
vi.mock("./useScratchProject", () => ({
  useScratchProject: () => ({ openScratchProject: state.open }),
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));
vi.mock("../logicalProject", () => ({
  selectProjectGroupingSettings: vi.fn(),
  deriveLogicalProjectKeyFromSettings: (project: EnvironmentProject) =>
    `${project.environmentId}:${project.id}`,
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getDraftSession: state.getDraft,
      setLogicalProjectDraftThreadId: state.remap,
      setDraftThreadContext: state.context,
    }),
  },
}));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => "a",
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "a",
        label: "A",
        connection: { phase: "connected" },
        serverConfig: { environment: { platform: "linux" }, scratchWorkspaceRoot: "/scratch/a" },
      },
      {
        environmentId: "b",
        label: "B",
        connection: { phase: "connected" },
        serverConfig: { environment: { platform: "linux" }, scratchWorkspaceRoot: "/scratch/b" },
      },
      {
        environmentId: "c",
        label: "C",
        connection: { phase: "connected" },
        serverConfig: { environment: { platform: "linux" }, scratchWorkspaceRoot: "/scratch/c" },
      },
      {
        environmentId: "offline",
        label: "Offline",
        connection: { phase: "disconnected" },
        serverConfig: {
          environment: { platform: "linux" },
          scratchWorkspaceRoot: "/scratch/offline",
        },
      },
      {
        environmentId: "unsupported",
        label: "Unsupported",
        connection: { phase: "connected" },
        serverConfig: { environment: { platform: "linux" } },
      },
    ],
  }),
}));
const project = (id: string) =>
  ({
    id: ProjectId.make(`project-${id}`),
    environmentId: EnvironmentId.make(id),
    workspaceRoot: `/scratch/${id}`,
  }) as EnvironmentProject;
const draftId = "draft" as DraftId;
let result: ReturnType<typeof useScratchDraftEnvironment>;
let renderer: ReactTestRenderer;
let canSwitch = true;
function Probe({ activeProject = project("a") }: { activeProject?: EnvironmentProject }) {
  const selection = useScratchDraftEnvironment({
    draftId,
    activeProject,
    canSwitch: () => canSwitch,
  });
  useLayoutEffect(() => {
    result = selection;
  });
  return null;
}
function deferred() {
  let resolve!: (project: EnvironmentProject | null) => void;
  const promise = new Promise<EnvironmentProject | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  canSwitch = true;
  state.getDraft.mockReturnValue({ environmentId: "a", projectId: "project-a", promotedTo: null });
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => act(() => renderer.unmount()));

describe("projectless machine selection", () => {
  it("offers connected machines before they have scratch projects and keeps the initial target", () => {
    expect(result.availableEnvironments.map((env) => env.environmentId)).toEqual(["a", "b", "c"]);
    expect(state.open).not.toHaveBeenCalled();
    expect(state.remap).not.toHaveBeenCalled();
  });
  it("cycles from the current machine and wraps while resolving only the latest selection", async () => {
    const b = deferred();
    const c = deferred();
    state.open.mockReturnValueOnce(b.promise).mockReturnValueOnce(c.promise);
    act(() => result.cycleEnvironment());
    expect(result.pending).toBe(true);
    act(() => result.cycleEnvironment());
    expect(state.open.mock.calls.map(([id]) => id)).toEqual(["b", "c"]);
    await act(async () => {
      b.resolve(project("b"));
      await b.promise;
    });
    expect(state.remap).not.toHaveBeenCalled();
    await act(async () => {
      c.resolve(project("c"));
      await c.promise;
    });
    expect(state.remap).toHaveBeenCalledWith(
      "c:project-c",
      { environmentId: "c", projectId: "project-c" },
      draftId,
    );
    expect(result.pending).toBe(false);
    act(() => renderer.update(<Probe activeProject={project("c")} />));
    act(() => result.cycleEnvironment());
    expect(state.open).toHaveBeenLastCalledWith("a");
  });
  it("does not overwrite a project selected while the machine is being prepared", async () => {
    const next = deferred();
    state.open.mockReturnValue(next.promise);
    act(() => {
      void result.selectEnvironment(EnvironmentId.make("b"));
    });
    state.getDraft.mockReturnValue({
      environmentId: "a",
      projectId: "chosen-project",
      promotedTo: null,
    });
    await act(async () => {
      next.resolve(project("b"));
      await next.promise;
    });
    expect(state.remap).not.toHaveBeenCalled();
    expect(result.pending).toBe(false);
  });
  it("keeps the draft on its machine after a failed resolution", async () => {
    state.open.mockResolvedValue(null);
    await act(async () => result.selectEnvironment(EnvironmentId.make("b")));
    expect(state.remap).not.toHaveBeenCalled();
    expect(result.pending).toBe(false);
  });
  it("clears pending state when leaving and returning to the original project", async () => {
    const next = deferred();
    state.open.mockReturnValue(next.promise);
    act(() => {
      void result.selectEnvironment(EnvironmentId.make("b"));
    });
    act(() => renderer.update(<Probe activeProject={project("c")} />));
    act(() => renderer.update(<Probe activeProject={project("a")} />));
    expect(result.pending).toBe(false);
    await act(async () => {
      next.resolve(project("b"));
      await next.promise;
    });
    expect(state.remap).not.toHaveBeenCalled();
  });
  it("ignores switching once sending starts", async () => {
    canSwitch = false;
    await act(async () => result.selectEnvironment(EnvironmentId.make("b")));
    expect(state.open).not.toHaveBeenCalled();
  });
});
