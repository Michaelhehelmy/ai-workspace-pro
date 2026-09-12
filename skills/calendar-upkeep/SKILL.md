---
id: calendar-upkeep
name: Calendar Upkeep
version: 1
specializations: [calendar, general, coordination]
triggers:
  - schedule
  - meeting
  - remind me on
  - booking
  - appointment
steps:
  - "Extract the event summary and start time/date when present."
  - "Persist a `calendar_events` record."
  - "Confirm with the stored summary and time."
prompt: >-
  When the user mentions scheduling or a meeting, extract a short summary and a
  date/time if present, store the event, and confirm briefly.
---

# Calendar Upkeep

Evolves any assistant character that carries the `calendar`, `general`, or
`coordination` specialization into a calendar manager.

## Triggers

`schedule`, `meeting`, `remind me on`, `booking`, `appointment`

## Steps

1. Extract the event summary and start time/date when present.
2. Persist a `calendar_events` record.
3. Confirm with the stored summary and time.

## Prompt fragment

When the user mentions scheduling or a meeting, extract a short summary and a
date/time if present, store the event, and confirm briefly.