---
id: task-capture
name: Task Capture
version: 1
specializations: [tasks, general, coordination]
triggers:
  - add todo
  - add task
  - remind me
  - remember to
  - todo
steps:
  - "Extract the task text (strip leading verbs like 'add'/'remind')."
  - "Persist a `todos` record with status 'pending'."
  - "Confirm with the stored task text."
prompt: >-
  When the user asks to add a task or todo, clean the task text, save it as a
  pending todo, and confirm in one short line.
---

# Task Capture

Evolves any assistant character that carries the `tasks`, `general`, or
`coordination` specialization into a fast task recorder.

## Triggers

`add todo`, `add task`, `remind me`, `remember to`, `todo`

## Steps

1. Extract the task text (strip leading verbs like `add`/`remind`).
2. Persist a `todos` record with status `pending`.
3. Confirm with the stored task text.

## Prompt fragment

When the user asks to add a task or todo, clean the task text, save it as a
pending todo, and confirm in one short line.