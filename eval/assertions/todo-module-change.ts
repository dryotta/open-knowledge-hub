import { join } from "node:path";
import { parseTodoLine } from "../../src/todos/parser.js";
import type { ParsedTodoLine } from "../../src/todos/types.js";
import { diffTrees, readTree } from "./_compare.js";

interface Ctx {
  config?: {
    module?: string;
    operation?: "create" | "update";
    text?: string;
  };
  providerResponse?: {
    metadata?: {
      containerPath?: string;
      fixtureDir?: string;
    };
  };
}

interface Result {
  pass: boolean;
  score: number;
  reason: string;
}

const fail = (reason: string): Result => ({ pass: false, score: 0, reason });

function lines(text: string): string[] {
  return text.split(/\r?\n/u);
}

function withoutTrailingBlankLines(values: string[]): string[] {
  const trimmed = [...values];
  while (trimmed.at(-1) === "") trimmed.pop();
  return trimmed;
}

function matchingTodos(tree: Map<string, string>, query: string): ParsedTodoLine[] {
  const matches: ParsedTodoLine[] = [];
  for (const contents of tree.values()) {
    for (const line of lines(contents)) {
      const parsed = parseTodoLine(line);
      if (parsed?.text.toLowerCase().includes(query)) matches.push(parsed);
    }
  }
  return matches;
}

function sameTodoFields(before: ParsedTodoLine, after: ParsedTodoLine): boolean {
  return before.text === after.text
    && JSON.stringify(before.labels) === JSON.stringify(after.labels)
    && before.priority === after.priority
    && before.due === after.due
    && before.created === after.created
    && before.id === after.id;
}

export default async function todoModuleChange(_output: string, context: Ctx): Promise<Result> {
  const operation = context.config?.operation;
  const query = context.config?.text?.trim().toLowerCase();
  const module = context.config?.module ?? "mem";
  const containerPath = context.providerResponse?.metadata?.containerPath;
  const fixtureDir = context.providerResponse?.metadata?.fixtureDir;
  if (operation !== "create" && operation !== "update") {
    return fail('config.operation must be "create" or "update"');
  }
  if (!query) return fail("config.text must be a non-empty string");
  if (!containerPath || !fixtureDir) return fail("containerPath and fixtureDir metadata are required");

  const before = await readTree(join(fixtureDir, module));
  const after = await readTree(join(containerPath, module));
  const diff = diffTrees(before, after);
  if (diff.removed.length > 0) return fail(`memory files removed: ${diff.removed.join(", ")}`);

  const beforeMatches = matchingTodos(before, query);
  const afterMatches = matchingTodos(after, query);
  if (afterMatches.length !== 1) {
    return fail(`expected exactly one matching todo after the run, found ${afterMatches.length}`);
  }

  if (operation === "create") {
    if (beforeMatches.length !== 0) {
      return fail(`create target already existed ${beforeMatches.length} time(s) in the fixture`);
    }
    const changedPaths = [...diff.added, ...diff.changed];
    if (changedPaths.length !== 1) {
      return fail(`create must change exactly one memory file, changed ${changedPaths.length}`);
    }
    const path = changedPaths[0]!;
    if (diff.changed.includes(path)) {
      const beforeLines = withoutTrailingBlankLines(lines(before.get(path) ?? ""));
      const afterLines = lines(after.get(path) ?? "");
      if (!beforeLines.every((line, index) => afterLines[index] === line)) {
        return fail(`existing content in ${path} was not preserved as an unchanged prefix`);
      }
    }
    const beforeTodoCount = matchingTodos(before, "").length;
    const afterTodoCount = matchingTodos(after, "").length;
    if (afterTodoCount !== beforeTodoCount + 1) {
      return fail(`create changed todo count by ${afterTodoCount - beforeTodoCount}; expected 1`);
    }
    return { pass: true, score: 1, reason: `created exactly one todo in ${path}; prior memory content preserved` };
  }

  if (beforeMatches.length !== 1) {
    return fail(`expected exactly one matching fixture todo for update, found ${beforeMatches.length}`);
  }
  if (diff.added.length > 0) return fail(`update added files: ${diff.added.join(", ")}`);
  if (diff.changed.length !== 1) {
    return fail(`update must change exactly one memory file, changed ${diff.changed.length}`);
  }

  const path = diff.changed[0]!;
  const beforeLines = lines(before.get(path) ?? "");
  const afterLines = lines(after.get(path) ?? "");
  if (beforeLines.length !== afterLines.length) {
    return fail(`update changed line count in ${path}`);
  }
  const changedIndexes = beforeLines
    .map((line, index) => line === afterLines[index] ? -1 : index)
    .filter((index) => index >= 0);
  if (changedIndexes.length !== 1) {
    return fail(`update changed ${changedIndexes.length} lines in ${path}; expected exactly one`);
  }
  const index = changedIndexes[0]!;
  const beforeTodo = parseTodoLine(beforeLines[index] ?? "");
  const afterTodo = parseTodoLine(afterLines[index] ?? "");
  if (!beforeTodo || !afterTodo || !beforeTodo.text.toLowerCase().includes(query)) {
    return fail(`the only changed line in ${path} was not the target todo`);
  }
  if (beforeTodo.status !== "open" || afterTodo.status !== "completed") {
    return fail(`target status changed ${beforeTodo.status} -> ${afterTodo.status}; expected open -> completed`);
  }
  if (!sameTodoFields(beforeTodo, afterTodo)) {
    return fail("target todo fields other than completion status/date changed");
  }
  return { pass: true, score: 1, reason: `completed exactly one target todo in ${path}; all other content preserved` };
}
