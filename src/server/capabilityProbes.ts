import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
export const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 60_000;

export type CapabilityStatus = "unsupported" | "passed" | "declined" | "failed" | "advertised";

export interface CapabilityFeatureResult {
  status: CapabilityStatus;
  message: string;
}

export interface CapabilityReport {
  roots: CapabilityFeatureResult;
  sampling: CapabilityFeatureResult;
  elicitation: CapabilityFeatureResult;
  apps: CapabilityFeatureResult;
}

export interface CapabilityProbeOperations {
  capabilities(): ClientCapabilities | undefined;
  roots(): Promise<void>;
  sampling(): Promise<void>;
  elicitation(): Promise<"accept" | "decline" | "cancel">;
}

function supportsFormElicitation(elicit: ClientCapabilities["elicitation"]): boolean {
  if (!elicit) return false;
  const e = elicit as { form?: unknown; url?: unknown };
  const hasForm = e.form !== undefined;
  const hasUrl = e.url !== undefined;
  return hasForm || (!hasForm && !hasUrl);
}

export async function runCapabilityProbes(ops: CapabilityProbeOperations): Promise<CapabilityReport> {
  const caps = ops.capabilities();

  // Roots probe
  let roots: CapabilityFeatureResult;
  if (!caps?.roots) {
    roots = { status: "unsupported", message: "Roots are not advertised." };
  } else {
    try {
      await ops.roots();
      roots = { status: "passed", message: "Roots request succeeded." };
    } catch {
      roots = { status: "failed", message: "Roots request failed." };
    }
  }

  // Sampling probe
  let sampling: CapabilityFeatureResult;
  if (!caps?.sampling) {
    sampling = { status: "unsupported", message: "Sampling is not advertised." };
  } else {
    try {
      await ops.sampling();
      sampling = { status: "passed", message: "Sampling request succeeded." };
    } catch {
      sampling = { status: "failed", message: "Sampling request failed." };
    }
  }

  // Elicitation probe — form mode only; URL-only clients are treated as unsupported
  let elicitation: CapabilityFeatureResult;
  if (!supportsFormElicitation(caps?.elicitation)) {
    elicitation = { status: "unsupported", message: "Form elicitation is not advertised." };
  } else {
    try {
      const action = await ops.elicitation();
      if (action === "accept") {
        elicitation = { status: "passed", message: "Elicitation request succeeded." };
      } else {
        elicitation = { status: "declined", message: "Elicitation was declined or cancelled." };
      }
    } catch {
      elicitation = { status: "failed", message: "Elicitation request failed." };
    }
  }

  // Apps probe — passive presence check, no active request
  const apps: CapabilityFeatureResult =
    caps?.extensions?.[MCP_APPS_EXTENSION] !== undefined
      ? { status: "advertised", message: "MCP Apps extension is advertised." }
      : { status: "unsupported", message: "MCP Apps is not advertised." };

  return { roots, sampling, elicitation, apps };
}

export function createCapabilityProbeOperations(
  server: McpServer,
  timeoutMs: number = DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS,
): CapabilityProbeOperations {
  return {
    capabilities: () => server.server.getClientCapabilities(),

    roots: async () => {
      await server.server.listRoots(undefined, { timeout: timeoutMs });
    },

    sampling: async () => {
      await server.server.createMessage(
        {
          messages: [{ role: "user", content: { type: "text", text: "Reply OK." } }],
          maxTokens: 16,
        },
        { timeout: timeoutMs },
      );
    },

    elicitation: async () => {
      const result = await server.server.elicitInput(
        {
          message: "Please confirm.",
          requestedSchema: {
            type: "object",
            properties: {
              confirmed: { type: "boolean" },
            },
          },
        },
        { timeout: timeoutMs },
      );
      return result.action;
    },
  };
}

export function formatCapabilityReport(report: CapabilityReport): string {
  return [
    `Roots: ${report.roots.message}`,
    `Sampling: ${report.sampling.message}`,
    `Form Elicitation: ${report.elicitation.message}`,
    `MCP Apps: ${report.apps.message}`,
  ].join("\n");
}
