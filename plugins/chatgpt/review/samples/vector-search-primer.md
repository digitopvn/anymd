# Vector search primer (synthetic sample)

> Synthetic sample written for the anymd ChatGPT review account. It describes no real company, person or customer.

Vector search finds documents by meaning instead of exact words. Each document is turned into an embedding, a list of numbers that places similar texts close together. A query is embedded the same way, and the nearest documents are returned.

## When to use it

- Questions phrased differently from the source ("how do I make search understand synonyms?").
- Recall across long notes where the exact keyword is unknown.

## When keyword search is better

- Exact identifiers such as error codes, ticket numbers or function names.
- Short queries where every word must appear.

## Hybrid search

Hybrid search runs keyword (BM25) and vector search together and merges the two ranked lists with Reciprocal Rank Fusion. It keeps exact matches near the top while still finding paraphrases.

## Key decisions recorded in this note

1. Default to hybrid search for questions written in natural language.
2. Use full-text search when the query contains quotes or an exact code.
3. Re-check results older than 90 days before citing them.
