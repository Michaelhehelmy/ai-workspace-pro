---
id: semantic-retrieval
name: Semantic Retrieval
version: 1
specializations: [search, general, analytics]
triggers:
  - search
  - find
  - where is
  - look up
  - list my
  - show me
steps:
  - "Request semantic search embeddings for the query."
  - "Retrieve the most similar records across the active business."
  - "Present the top matches with scores, never fabricating results."
prompt: >-
  When the user asks to search, find, or look something up, use the vector index
  to retrieve genuine matching records and present real results only.
---

# Semantic Retrieval

Evolves any assistant character that carries the `search`, `general`, or
`analytics` specialization into a retrieval specialist.

## Triggers

`search`, `find`, `where is`, `look up`, `list my`, `show me`

## Steps

1. Request semantic search embeddings for the query.
2. Retrieve the most similar records across the active business.
3. Present the top matches with scores, never fabricating results.

## Prompt fragment

When the user asks to search, find, or look something up, use the vector index
to retrieve genuine matching records and present real results only.