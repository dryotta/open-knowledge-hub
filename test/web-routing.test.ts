import { describe, expect, it } from "vitest";
import {
  matchRoute,
  projectPath,
  workspacePath,
} from "../app/web/routing.js";
import { resultDiff } from "../app/web/features/workspaces.js";

describe("web workspace routing", () => {
  it("round-trips encoded container, module, and project parameters", () => {
    const workspace = workspacePath("team one", "workspaces/investigations");
    expect(workspace).toBe("/workspaces/team%20one/workspaces%2Finvestigations");
    expect(matchRoute(workspace)).toEqual({
      id: "workspace",
      params: {
        container: "team one",
        module: "workspaces/investigations",
      },
    });

    const project = projectPath("team one", "workspaces/investigations", "supplier-risk");
    expect(matchRoute(project)).toEqual({
      id: "project",
      params: {
        container: "team one",
        module: "workspaces/investigations",
        project: "supplier-risk",
      },
    });
  });

  it("returns a not-found route for malformed or unsafe paths", () => {
    expect(matchRoute("/unknown")).toEqual({ id: "not-found", params: {} });
    expect(matchRoute("/workspaces/hub/investigations/projects/Not-Safe")).toEqual({
      id: "not-found",
      params: {},
    });
    expect(matchRoute("/workspaces/hub/docs%2F..")).toEqual({
      id: "not-found",
      params: {},
    });
    expect(matchRoute("/workspaces/%E0%A4%A/investigations")).toEqual({
      id: "not-found",
      params: {},
    });
  });

  it("describes result changes from an older result to a newer result", () => {
      const base = {
        finishedAt: "2026-01-01T00:00:00.000Z",
        path: "runs/old/result",
        treeHash: "sha256:old",
        evidence: [],
      };
      const diff = resultDiff(
        {
          ...base,
          runId: "old",
          files: [
            { path: "changed.md", size: 1, sha256: "sha256:old" },
            { path: "removed.md", size: 1, sha256: "sha256:removed" },
          ],
        },
        {
          ...base,
          runId: "new",
          files: [
            { path: "changed.md", size: 2, sha256: "sha256:new" },
            { path: "added.md", size: 1, sha256: "sha256:added" },
          ],
        },
      );
      expect(diff).toContain("Added: added.md");
      expect(diff).toContain("Changed: changed.md");
      expect(diff).toContain("Removed: removed.md");
  });
});
