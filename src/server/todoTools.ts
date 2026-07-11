import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OkhError } from "../errors.js";
import { TodoService } from "../todos/service.js";
import type { TodoPriority, TodoQuery, TodoRecord, TodoUpdateInput } from "../todos/types.js";
import { handler, ok, toolReg } from "./toolSupport.js";

type TodosArgs = {
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
};

type UpdateTodoArgs =
  | {
      operation: "create";
      container?: string;
      module?: string;
      text?: string;
      entrySummary?: string;
      observation?: string;
      ref?: string;
      completed?: boolean;
      labels?: string[];
      due?: string | null;
      priority?: TodoPriority | null;
    }
  | {
      operation: "patch";
      container?: string;
      module?: string;
      text?: string;
      entrySummary?: string;
      observation?: string;
      ref?: string;
      completed?: boolean;
      labels?: string[];
      due?: string | null;
      priority?: TodoPriority | null;
    };

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

function toTodoQuery(args: TodosArgs): TodoQuery {
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

function toCreateInput(args: Extract<UpdateTodoArgs, { operation: "create" }>): Extract<TodoUpdateInput, { operation: "create" }> {
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
  };
}

function toPatchInput(args: Extract<UpdateTodoArgs, { operation: "patch" }>): Extract<TodoUpdateInput, { operation: "patch" }> {
  return {
    operation: "patch",
    ref: args.ref ?? "",
    ...(args.completed === undefined ? {} : { completed: args.completed }),
    ...(args.labels === undefined ? {} : { labels: args.labels }),
    ...(args.due === undefined ? {} : { due: args.due }),
    ...(args.priority === undefined ? {} : { priority: args.priority }),
  };
}

function describeUpdate(
  args: UpdateTodoArgs,
  result: Awaited<ReturnType<TodoService["update"]>>,
): string {
  const location = `${result.todo.source.container}/${result.todo.source.module} (${result.todo.source.path}:${result.todo.source.line})`;
  if (args.operation === "create") {
    return `Created todo in ${location}: ${result.todo.text}`;
  }
  if (args.completed === true) {
    return `Marked todo completed in ${location}: ${result.todo.text}`;
  }
  if (args.completed === false) {
    return `Reopened todo in ${location}: ${result.todo.text}`;
  }
  return `Updated todo in ${location}: ${result.todo.text}`;
}

export async function registerTodoTools(server: McpServer, todos: TodoService): Promise<void> {
  server.registerTool(
    "todos",
    { ...(await toolReg("todos")), annotations: { readOnlyHint: true, openWorldHint: false } },
    handler(async (args: TodosArgs) => {
      const result = await todos.list(toTodoQuery(args));
      return ok(formatTodos(result.tasks, result.counts), {
        tasks: result.tasks,
        warnings: result.warnings,
        counts: result.counts,
      });
    }),
  );

  server.registerTool(
    "update_todo",
    { ...(await toolReg("update_todo")), annotations: { readOnlyHint: false, openWorldHint: false } },
    handler(async (args: UpdateTodoArgs) => {
      const result = await todos.update(args.operation === "create" ? toCreateInput(args) : toPatchInput(args));
      return ok(describeUpdate(args, result), { todo: result.todo, dirtyContainer: result.dirtyContainer });
    }),
  );
}
