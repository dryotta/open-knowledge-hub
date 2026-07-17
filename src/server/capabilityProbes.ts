import type { ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";
export const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 60_000;

export type CapabilityStatus = "unsupported" | "passed" | "declined" | "failed" | "advertised" | "unknown";

export interface CapabilityFeatureResult {
  available: boolean;
  status: CapabilityStatus;
  message: string;
}

function isAvailable(status: CapabilityStatus): boolean {
  return status !== "unsupported" && status !== "unknown";
}

function feat(status: CapabilityStatus, message: string): CapabilityFeatureResult {
  return { available: isAvailable(status), status, message };
}

export interface CapabilityReport {
  features: {
    roots: CapabilityFeatureResult;
    sampling: CapabilityFeatureResult;
    elicitation: CapabilityFeatureResult;
    apps: CapabilityFeatureResult;
    serverTools: CapabilityFeatureResult;
    subagentDelegation: CapabilityFeatureResult;
  };
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
    roots = feat("unsupported", "Roots are not advertised.");
  } else {
    try {
      await ops.roots();
      roots = feat("passed", "Roots request succeeded.");
    } catch {
      roots = feat("failed", "Roots request failed.");
    }
  }

  // Sampling probe
  let sampling: CapabilityFeatureResult;
  if (!caps?.sampling) {
    sampling = feat("unsupported", "Sampling is not advertised.");
  } else {
    try {
      await ops.sampling();
      sampling = feat("passed", "Sampling request succeeded.");
    } catch {
      sampling = feat("failed", "Sampling request failed.");
    }
  }

  // Elicitation probe — form mode only; URL-only clients are treated as unsupported
  let elicitation: CapabilityFeatureResult;
  if (!supportsFormElicitation(caps?.elicitation)) {
    elicitation = feat("unsupported", "Form elicitation is not advertised.");
  } else {
    try {
      const action = await ops.elicitation();
      if (action === "accept") {
        elicitation = feat("passed", "Elicitation request succeeded.");
      } else {
        elicitation = feat("declined", "Elicitation was declined or cancelled.");
      }
    } catch {
      elicitation = feat("failed", "Elicitation request failed.");
    }
  }

  // Apps probe — passive presence check, no active request
  const appsAdvertised = caps?.extensions?.[MCP_APPS_EXTENSION] !== undefined;
  const apps: CapabilityFeatureResult = appsAdvertised
    ? feat("advertised", "MCP Apps extension is advertised.")
    : feat("unsupported", "MCP Apps is not advertised.");

  // Server tool proxying (host `serverTools`) is negotiated between the host and
  // the app iframe during `ui/initialize`; it is NOT part of the client
  // capabilities the server sees here, so it cannot be probed server-side.
  // Interactive apps (e.g. Todos) still need it: without it, toggling a checkbox
  // has no effect. Report it as unknown so operators know to verify in-app.
  const serverTools: CapabilityFeatureResult = appsAdvertised
    ? feat(
        "unknown",
        "Server tool proxying (host serverTools) is negotiated in-app and is not observable from the server; the Todos app verifies it at runtime and disables updates when absent.",
      )
    : feat("unsupported", "Server tool proxying does not apply because MCP Apps is not advertised.");

  const subagentDelegation = feat(
    "unknown",
    "Unknown. Standard MCP does not expose subagent execution. To check behavior, run use_agent with a harmless task and ask the client to report native-subagent or inline-parent. Treat the answer as client-reported.",
  );

  return { features: { roots, sampling, elicitation, apps, serverTools, subagentDelegation } };
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
  const { roots, sampling, elicitation, apps, serverTools, subagentDelegation } = report.features;
  return [
    `Roots: ${roots.message}`,
    `Sampling: ${sampling.message}`,
    `Form Elicitation: ${elicitation.message}`,
    `MCP Apps: ${apps.message}`,
    `App Server Tools: ${serverTools.message}`,
    `Subagent delegation: ${subagentDelegation.message}`,
  ].join("\n");
}
