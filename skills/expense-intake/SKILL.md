---
id: expense-intake
name: Expense Intake
version: 1
specializations: [finance, expenses, tasks]
triggers:
  - spent
  - expense
  - lunch
  - dinner
  - paid
  - grocery
  - coffee
  - buy
steps:
  - "Parse the amount (prefer explicit $ amounts)."
  - "Infer a category from the config `categories` keyword lists."
  - "Persist a `transactions` record with type 'expense'."
  - "Reply with a short confirmation including the recorded amount and category."
prompt: >-
  When the user reports spending money, extract the amount (use the dollar
  figure), guess the category from the configured category keywords, and store
  the transaction. Reply in one line confirming the recorded amount and category.
---

# Expense Intake

Evolves any assistant character that carries the `finance`, `expenses`, or
`tasks` specialization into an expense recorder.

## Triggers

`sent`, `expense`, `lunch`, `dinner`, `paid`, `grocery`, `coffee`, `buy`

## Steps

1. Parse the amount (prefer explicit `$` amounts).
2. Infer a category from the config `categories` keyword lists.
3. Persist a `transactions` record with type `expense`.
4. Reply with a short confirmation including the recorded amount and category.

## Prompt fragment

When the user reports spending money, extract the amount (use the dollar
figure), guess the category from the configured category keywords, and store
the transaction. Reply in one line confirming the recorded amount and category.