---
id: character-delegation
name: Character Delegation
version: 1
specializations: [coordination, general]
triggers:
  - delegate
  - ask marcus
  - ask aria
  - route to
  - contact
steps:
  - "Identify the target character (by name) or pick the closest specialist."
  - "Forward the original request and reply with the specialist's answer."
prompt: >-
  When the user wants to delegate or ask a specialist, route the request to the
  best-matching character and return that character's genuine reply.
---

# Character Delegation

Evolves any assistant character that carries the `coordination` or `general`
specialization into a team coordinator.

## Triggers

`delegate`, `ask marcus`, `ask aria`, `route to`, `contact`

## Steps

1. Identify the target character (by name) or pick the closest specialist.
2. Forward the original request and reply with the specialist's answer.

## Prompt fragment

When the user wants to delegate or ask a specialist, route the request to the
best-matching character and return that character's genuine reply.