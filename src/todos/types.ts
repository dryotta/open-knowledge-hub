export const TODO_PRIORITIES = ["lowest", "low", "normal", "medium", "high", "highest"] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];
export type TodoStatus = "open" | "completed" | "custom";
export type TodoTokenKind = "label" | "priority" | "due" | "created" | "completed" | "id";

export interface TodoToken {
  kind: TodoTokenKind;
  start: number;
  end: number;
  raw: string;
  value?: string;
  valid: boolean;
}

export interface ParsedTodoLine {
  raw: string;
  prefix: string;
  statusIndex: number;
  statusChar: string;
  status: TodoStatus;
  readOnly: boolean;
  body: string;
  text: string;
  labels: string[];
  priority: TodoPriority;
  due?: string;
  created?: string;
  completed?: string;
  id?: string;
  warnings: string[];
  tokens: TodoToken[];
}

export interface TodoSource {
  container: string;
  module: string;
  path: string;
  line: number;
}

export interface TodoQuery {
  container?: string;
  module?: string;
  status?: TodoStatus | "all";
  labels?: string[];
  labelMode?: "any" | "all";
  priorities?: TodoPriority[];
  dueAfter?: string;
  dueBefore?: string;
  overdue?: boolean;
  query?: string;
}

export interface TodoLocator {
  v: 1;
  container: string;
  module: string;
  path: string;
  line: number;
  fingerprint: string;
  id?: string;
}

export interface TodoRecord {
  ref: string;
  status: TodoStatus;
  statusChar: string;
  readOnly: boolean;
  text: string;
  labels: string[];
  priority: TodoPriority;
  due?: string;
  created?: string;
  completed?: string;
  id?: string;
  warnings: string[];
  source: TodoSource;
}

export interface TodoWarning {
  source: TodoSource;
  message: string;
}

export interface TodoListResult {
  tasks: TodoRecord[];
  warnings: TodoWarning[];
  counts: { total: number; open: number; completed: number; custom: number };
}

export interface CreateTodoLineInput {
  text: string;
  labels: string[];
  priority?: TodoPriority;
  due?: string;
  created: string;
}

export interface TodoLinePatch {
  completed?: boolean;
  labels?: string[];
  due?: string | null;
  priority?: TodoPriority | null;
}

export type TodoMutationInput =
  | {
      operation: "create";
      container: string;
      module: string;
      text: string;
      entrySummary?: string;
      observation?: string;
      labels?: string[];
      due?: string;
      priority?: TodoPriority;
      apply?: boolean;
    }
  | {
      operation: "update";
      ref: string;
      completed?: boolean;
      labels?: string[];
      due?: string | null;
      priority?: TodoPriority | null;
      apply?: boolean;
    };

export interface TodoMutationPreview {
  line: string;
  source: TodoSource;
  todo: TodoRecord;
}

export type TodoMutationResult =
  | {
      operation: TodoMutationInput["operation"];
      applied: false;
      preview: TodoMutationPreview;
      needsConfirmation: true;
    }
  | {
      operation: TodoMutationInput["operation"];
      applied: true;
      todo: TodoRecord;
      dirtyContainer: string;
    };
