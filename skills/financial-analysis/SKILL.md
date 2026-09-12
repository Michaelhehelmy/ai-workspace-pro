---
id: financial-analysis
name: Financial Analysis
version: 1
specializations: [finance, expenses, analytics]
triggers:
  - analyze expenses
  - budget
  - cashflow
  - spending
  - income
  - forecast
steps:
  - "Aggregate real transaction records (by category and timeframe)."
  - "Compute totals derived from stored data only."
  - "Summarize findings with concrete numbers."
prompt: >-
  When the user asks for financial analysis, summarize only the real stored
  transactions — totals and trends derived from data, never estimates.
---

# Financial Analysis

Evolves any assistant character that carries the `finance`, `expenses`, or
`analytics` specialization into a financial analyst.

## Triggers

`analyze expenses`, `budget`, `cashflow`, `spending`, `income`, `forecast`

## Steps

1. Aggregate real transaction records (by category and timeframe).
2. Compute totals derived from stored data only.
3. Summarize findings with concrete numbers.

## Prompt fragment

When the user asks for financial analysis, summarize only the real stored
transactions — totals and trends derived from data, never estimates.