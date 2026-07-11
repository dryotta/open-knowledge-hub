---
title: Show todo lists
args:
  container: "Container name to search within. Omit to scan all registered containers."
  module: "Memory module path to search within. Omit to scan every memory module in scope."
  status: "Filter by todo status: open, completed, custom, or all."
  labels: "Filter by normalized todo labels."
  labelMode: "How labels match when labels are provided: any or all."
  priorities: "Filter by one or more todo priorities."
  dueAfter: "Keep only todos due on or after this YYYY-MM-DD date."
  dueBefore: "Keep only todos due on or before this YYYY-MM-DD date."
  overdue: "When true, show only overdue open todos; when false, exclude overdue open todos."
  query: "Case-insensitive text query matched against todo text and labels."
---
List or filter Markdown todos from memory modules. Use this whenever you are asked to show, review, or filter a todo list.
