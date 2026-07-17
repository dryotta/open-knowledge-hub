import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentProfile } from "../modules/loaders/agents.js";

export const AGENT_DELEGATION_INSTRUCTION =
  "Prefer a subagent that accepts these instructions. Otherwise follow the profile inline. Return the result and report which mode was used.";

export interface UseAgentPayload {
  agent: {
    container: string;
    module: string;
    id: string;
    description: string;
  };
  requestedTools: string[];
  profile: {
    format: "github-copilot-agent-md";
    content: string;
  };
  task: string;
  delegation: {
    preferredMode: "native-subagent";
    fallbackMode: "inline-parent";
    instruction: string;
  };
}

export function renderUseAgentResult(
  container: string,
  module: string,
  profile: AgentProfile,
  task: string,
): CallToolResult {
  const payload: UseAgentPayload = {
    agent: {
      container,
      module,
      id: profile.id,
      description: profile.description,
    },
    requestedTools: profile.requestedTools,
    profile: {
      format: "github-copilot-agent-md",
      content: profile.content,
    },
    task,
    delegation: {
      preferredMode: "native-subagent",
      fallbackMode: "inline-parent",
      instruction: AGENT_DELEGATION_INSTRUCTION,
    },
  };

  return {
    content: [
      {
        type: "text",
        text: `Prepared agent "${profile.id}" from ${container}/${module}.`,
      },
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
  };
}
