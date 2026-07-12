import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { OkhError } from "../errors.js";
import { TodoService } from "../todos/service.js";
import type {
  TodoMutationInput,
  TodoMutationResult,
  TodoPriority,
  TodoQuery,
  TodoRecord,
} from "../todos/types.js";
import { handler, ok, toolReg } from "./toolSupport.js";

export const TODO_APP_URI = "ui://open-knowledge-hub/todos";

export interface RegisterTodoToolsOptions {
  webUrl?: string;
}

type TodosListArgs = {
  operation?: "list";
  container?: string;
  module?: string;
  status?: "open" | "completed" | "custom" | "all";
  labels?: string[];
  labelMode?: "any" | "all";
  priorities?: TodoPriority[];
  dueAfter?: string;
  dueBefore?: string;
  overdue?: boolean;
  query?: string;
  apply?: boolean;
};

type TodosCreateArgs = {
  operation: "create";
  container?: string;
  module?: string;
  text?: string;
  entrySummary?: string;
  observation?: string;
  labels?: string[];
  due?: string | null;
  priority?: TodoPriority | null;
  apply?: boolean;
};

type TodosUpdateArgs = {
  operation: "update";
  ref?: string;
  completed?: boolean;
  labels?: string[];
  due?: string | null;
  priority?: TodoPriority | null;
  apply?: boolean;
};

type TodosArgs = TodosListArgs | TodosCreateArgs | TodosUpdateArgs;

const LIST_ONLY_FIELDS = ["status", "labelMode", "priorities", "dueAfter", "dueBefore", "overdue", "query"] as const;
const CREATE_ONLY_FIELDS = ["container", "module", "text", "entrySummary", "observation"] as const;
const UPDATE_ONLY_FIELDS = ["ref", "completed"] as const;
const MUTATION_SHARED_FIELDS = ["labels", "due", "priority", "apply"] as const;

function providedKeys(args: TodosArgs): string[] {
  return Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}

function validateKeys(args: TodosArgs, allowed: readonly string[], operation: "list" | "create" | "update"): void {
  const allowedSet = new Set(["operation", ...allowed]);
  const unexpected = providedKeys(args).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new OkhError(
      "INVALID_ARGUMENT",
      `${operation} does not accept: ${unexpected.join(", ")}.`,
    );
  }
}

function validateTodosArgs(args: TodosArgs): "list" | "create" | "update" {
  const operation = args.operation ?? "list";
  if (operation === "list") {
    validateKeys(args, ["container", "module", ...LIST_ONLY_FIELDS, "labels"], "list");
    return operation;
  }
  if (operation === "create") {
    validateKeys(args, [...CREATE_ONLY_FIELDS, ...MUTATION_SHARED_FIELDS], "create");
    return operation;
  }
  validateKeys(args, [...UPDATE_ONLY_FIELDS, ...MUTATION_SHARED_FIELDS], "update");
  return operation;
}

function statusMark(task: TodoRecord): string {
  if (task.status === "open") return "[ ]";
  if (task.status === "completed") return "[x]";
  return `[${task.statusChar}]`;
}

function formatTask(task: TodoRecord): string {
  const labels = task.labels.map((label) => `#${label}`).join(" ");
  const due = task.due ? ` due ${task.due}` : "";
  return `${statusMark(task)} ${task.text}${labels ? ` ${labels}` : ""}${due} (${task.source.path}:${task.source.line})`;
}

export function formatTodos(tasks: TodoRecord[], counts: { open: number; completed: number; custom: number }): string {
  const lines = [`Todos: ${counts.open} open, ${counts.completed} completed, ${counts.custom} custom.`];
  if (tasks.length === 0) {
    lines.push("", "No todos matched.");
    return lines.join("\n");
  }

  let currentGroup = "";
  for (const task of tasks) {
    const group = `${task.source.container}/${task.source.module}`;
    if (group !== currentGroup) {
      lines.push("", group);
      currentGroup = group;
    }
    lines.push(`  ${formatTask(task)}`);
  }
  return lines.join("\n");
}

function toTodoQuery(args: TodosListArgs): TodoQuery {
  return {
    ...(args.container === undefined ? {} : { container: args.container }),
    ...(args.module === undefined ? {} : { module: args.module }),
    ...(args.status === undefined ? {} : { status: args.status }),
    ...(args.labels === undefined ? {} : { labels: args.labels }),
    ...(args.labelMode === undefined ? {} : { labelMode: args.labelMode }),
    ...(args.priorities === undefined ? {} : { priorities: args.priorities }),
    ...(args.dueAfter === undefined ? {} : { dueAfter: args.dueAfter }),
    ...(args.dueBefore === undefined ? {} : { dueBefore: args.dueBefore }),
    ...(args.overdue === undefined ? {} : { overdue: args.overdue }),
    ...(args.query === undefined ? {} : { query: args.query }),
  };
}

function toCreateInput(args: TodosCreateArgs): Extract<TodoMutationInput, { operation: "create" }> {
  if (args.due === null) {
    throw new OkhError("INVALID_ARGUMENT", "due must be a valid YYYY-MM-DD calendar date.");
  }
  if (args.priority === null) {
    throw new OkhError("INVALID_ARGUMENT", "priority must be a valid todo priority.");
  }

  return {
    operation: "create",
    container: args.container ?? "",
    module: args.module ?? "",
    text: args.text ?? "",
    ...(args.entrySummary === undefined ? {} : { entrySummary: args.entrySummary }),
    ...(args.observation === undefined ? {} : { observation: args.observation }),
    ...(args.labels === undefined ? {} : { labels: args.labels }),
    ...(args.due === undefined ? {} : { due: args.due }),
    ...(args.priority === undefined ? {} : { priority: args.priority }),
    ...(args.apply === undefined ? {} : { apply: args.apply }),
  };
}

function toUpdateInput(args: TodosUpdateArgs): Extract<TodoMutationInput, { operation: "update" }> {
  return {
    operation: "update",
    ref: args.ref ?? "",
    ...(args.completed === undefined ? {} : { completed: args.completed }),
    ...(args.labels === undefined ? {} : { labels: args.labels }),
    ...(args.due === undefined ? {} : { due: args.due }),
    ...(args.priority === undefined ? {} : { priority: args.priority }),
    ...(args.apply === undefined ? {} : { apply: args.apply }),
  };
}

function describeMutationPreview(
  result: Extract<TodoMutationResult, { applied: false }>,
): string {
  const location = `${result.preview.source.container}/${result.preview.source.module} (${result.preview.source.path}:${result.preview.source.line})`;
  return `Preview ${result.operation} todo in ${location}: ${result.preview.line}`;
}

function describeAppliedMutation(result: Extract<TodoMutationResult, { applied: true }>): string {
  const location = `${result.todo.source.container}/${result.todo.source.module} (${result.todo.source.path}:${result.todo.source.line})`;
  if (result.operation === "create") {
    return `Created todo in ${location}: ${result.todo.text}`;
  }
  return `Updated todo in ${location}: ${result.todo.text}`;
}

function describeAppliedUpdate(args: TodosUpdateArgs, result: Extract<TodoMutationResult, { applied: true }>): string {
  const location = `${result.todo.source.container}/${result.todo.source.module} (${result.todo.source.path}:${result.todo.source.line})`;
  if (args.completed === true) {
    return `Marked todo completed in ${location}: ${result.todo.text}`;
  }
  if (args.completed === false) {
    return `Reopened todo in ${location}: ${result.todo.text}`;
  }
  return `Updated todo in ${location}: ${result.todo.text}`;
}

function withWebLink(text: string, webUrl: string | undefined): string {
  return webUrl ? `${text}\n\nTodo web UI: ${webUrl}` : text;
}

function withPendingSync(
  text: string,
  result: Extract<TodoMutationResult, { applied: true }>,
): string {
  return `${text}\n\nLocal change pending sync for container "${result.dirtyContainer}". Agent-driven workflows must call sync now; web UI changes remain local until the user explicitly syncs.`;
}

function withRequiredConfirmation(text: string): string {
  return `${text}\n\nExplicit confirmation is required before applying this preview.`;
}

function withWebUrl(
  structured: Record<string, unknown>,
  webUrl: string | undefined,
): Record<string, unknown> {
  return webUrl ? { ...structured, webUrl } : structured;
}

export async function registerTodoTools(
  server: McpServer,
  todos: TodoService,
  options: RegisterTodoToolsOptions = {},
): Promise<void> {
  registerAppTool(
    server,
    "todos",
    {
      ...(await toolReg("todos")),
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: TODO_APP_URI, visibility: ["model", "app"] } },
    },
    handler(async (args: TodosArgs) => {
      const operation = validateTodosArgs(args);
      if (operation === "create") {
        const result = await todos.mutate(toCreateInput(args as TodosCreateArgs));
        return ok(
          withWebLink(
            result.applied
              ? withPendingSync(describeAppliedMutation(result), result)
              : withRequiredConfirmation(describeMutationPreview(result)),
            options.webUrl,
          ),
          withWebUrl(result as unknown as Record<string, unknown>, options.webUrl),
        );
      }

      if (operation === "update") {
        const updateArgs = args as TodosUpdateArgs;
        const result = await todos.mutate(toUpdateInput(updateArgs));
        return ok(
          withWebLink(
            result.applied
              ? withPendingSync(describeAppliedUpdate(updateArgs, result), result)
              : withRequiredConfirmation(describeMutationPreview(result)),
            options.webUrl,
          ),
          withWebUrl(result as unknown as Record<string, unknown>, options.webUrl),
        );
      }

      const result = await todos.list(toTodoQuery(args as TodosListArgs));
      return ok(withWebLink(formatTodos(result.tasks, result.counts), options.webUrl), withWebUrl({
        operation: "list",
        tasks: result.tasks,
        warnings: result.warnings,
        counts: result.counts,
      }, options.webUrl));
    }),
  );

  registerAppResource(
    server,
    "Open Knowledge Hub Todos",
    TODO_APP_URI,
    {
      description: "Interactive filtering and completion for Open Knowledge Hub todo lists.",
      _meta: { ui: { prefersBorder: true } },
    },
    async () => {
      const html = await readFile(new URL("../../dist/apps/todos.html", import.meta.url), "utf8");
      return {
        contents: [
          {
            uri: TODO_APP_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: { ui: { prefersBorder: true } },
          },
        ],
      };
    },
  );
}
