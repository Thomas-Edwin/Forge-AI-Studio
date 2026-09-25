"use client";

import { useCallback, useLayoutEffect, useEffect, useRef, useState } from "react";

import { loadJson, saveJson, workspaceStorageKey } from "../lib/storage";

export type ArtifactView = "markdown" | "json" | "mermaid" | "code";
export type RightTab = "inspector" | "logs" | "timeline";
export type BottomTab = "console" | "events";
export type RunModeInput = "auto" | "llm" | "deterministic";

export interface PanelSizes {
  /** Left pipeline sidebar width (%). */
  left: number;
  /** Center column width (%). */
  center: number;
  /** Right inspector column width (%). */
  right: number;
  /** Bottom console height (%). */
  bottom: number;
}

export interface WorkspaceState {
  requirements: string;
  preferredStack: string[];
  mode: RunModeInput;
  runId: string | null;
  /** Last observed run status — lets a reloaded page resume polling. */
  lastStatus: string | null;
  selectedTab: string;
  view: ArtifactView;
  rightTab: RightTab;
  bottomTab: BottomTab;
  editorOpen: boolean;
  consoleOpen: boolean;
  paused: boolean;
  fullscreen: boolean;
  sizes: PanelSizes;
}

export const DEFAULT_PANEL_SIZES: PanelSizes = {
  left: 20,
  center: 50,
  right: 30,
  bottom: 22,
};

const DEFAULT_STATE: WorkspaceState = {
  requirements: "",
  preferredStack: [],
  mode: "auto",
  runId: null,
  lastStatus: null,
  selectedTab: "architecture",
  view: "markdown",
  rightTab: "inspector",
  bottomTab: "console",
  editorOpen: true,
  consoleOpen: true,
  paused: false,
  fullscreen: false,
  sizes: DEFAULT_PANEL_SIZES,
};

function loadWorkspaceState(storageKey: string): WorkspaceState {
  const stored = loadJson<Partial<WorkspaceState>>(storageKey);
  return {
    ...DEFAULT_STATE,
    ...(stored ?? {}),
    sizes: { ...DEFAULT_PANEL_SIZES, ...(stored?.sizes ?? {}) },
  };
}

/**
 * Persistent workspace session state (Phase 3.6).
 *
 * Every change is debounced to localStorage keyed by project so a reload or
 * navigation restores the draft, the active run (reconnecting live polling),
 * the open tabs, and the panel sizes.
 */
export function useWorkspaceState(
  projectId: string | null | undefined,
  projectRequirements: string | null | undefined,
) {
  const storageKey = workspaceStorageKey(projectId);
  const [state, setState] = useState<WorkspaceState>(() => loadWorkspaceState(storageKey));
  // The project this hook instance is currently bound to. Navigating between
  // project workspaces (e.g. creating a new project from the New Project modal:
  // /workspace/{a} -> /workspace/{b}) does not remount the page, so the session
  // must be rebound to the new project's storage key — otherwise the previous
  // project's run/output/requirements leak into the new project's workspace
  // and the generated code for the new project never shows.
  const boundKey = useRef<string>(storageKey);
  // Prefill the draft from the bound project exactly once per project binding:
  // a later refetch must not re-apply requirements the user deliberately cleared.
  const prefilledFor = useRef<string | null>(null);

  // Reload the per-project session whenever the bound project changes (the
  // initial key is already loaded by the useState initializer above). Runs
  // before paint so the new project's workspace never flashes the previous
  // project's run/output in its artifact (CODE) section.
  useLayoutEffect(() => {
    if (boundKey.current === storageKey) {
      return;
    }
    boundKey.current = storageKey;
    // The new project has no session of its own yet; the draft must never be
    // re-applied from the previous project.
    prefilledFor.current = null;
    setState(loadWorkspaceState(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!projectRequirements || prefilledFor.current === storageKey) {
      return;
    }
    setState((current) => {
      const next = current.requirements.trim() ? current : { ...current, requirements: projectRequirements };
      return next;
    });
    prefilledFor.current = storageKey;
  }, [storageKey, projectRequirements]);

  // Debounced persistence.
  useEffect(() => {
    const timer = window.setTimeout(() => saveJson(storageKey, state), 250);
    return () => window.clearTimeout(timer);
  }, [state, storageKey]);

  const patch = useCallback((partial: Partial<WorkspaceState>) => {
    setState((current) => ({ ...current, ...partial }));
  }, []);

  const patchSizes = useCallback((partial: Partial<PanelSizes>) => {
    setState((current) => ({ ...current, sizes: { ...current.sizes, ...partial } }));
  }, []);

  /** Clear the active run and output while keeping the requirements draft. */
  const resetRun = useCallback(() => {
    setState((current) => ({
      ...current,
      runId: null,
      lastStatus: null,
      selectedTab: "architecture",
      view: "markdown",
      rightTab: "inspector",
      bottomTab: "console",
      paused: false,
    }));
  }, []);

  return { state, patch, patchSizes, resetRun };
}
