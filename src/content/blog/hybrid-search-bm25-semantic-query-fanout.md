---
title: "Hybrid Search, Explained: BM25, Embeddings, Query Fan-out and Jev"
slug: hybrid-search-bm25-semantic-query-fanout
excerpt: "How anymd.cc searches your Markdown library: BM25 for exact words, embeddings for meaning, fan-out plus RRF for coverage, and Jev for close calls."
category: article
tags: [search, bm25, embeddings, rag, rrf]
published_at: 2026-09-24
seo_title: "Hybrid Search Explained: BM25, Semantic Search, Query Fan-out and RRF"
seo_description: "A plain-English tour of hybrid search in anymd.cc: SQLite FTS5 BM25, bge-m3 embeddings, LLM query fan-out, Reciprocal Rank Fusion and the Jev decider."
---

Saving everything you read is easy. Finding it again is the hard part.

Your anymd.cc library keeps every page you convert while signed in. That is only useful if search is good. "Good" turns out to mean several different things, depending on what you type. So we did not pick one search method. We stacked four, and each covers a gap the others leave.

Here is how the pieces work, and when each one wins.

## Layer 1: BM25, the keyword specialist

The first layer is classic full-text search: **BM25 ranking on SQLite FTS5**, running in Cloudflare D1.

BM25 scores a document by how often your words appear in it, adjusted for two things:

- **Rarity.** A word that appears in few documents counts for more. "Vectorize" is a stronger signal than "the".
- **Length.** A match in a short, focused document counts for more than the same match buried in a 10,000-word page.

It is decades old and still hard to beat when you know the words you are looking for.

### Full-text syntax

Because it is FTS5 underneath, you get real query syntax:

```text
"reciprocal rank fusion"        exact phrase
embed*                          prefix: embed, embeds, embedding, embeddings
postgres AND replication        both terms
redis OR memcached              either term
caching NOT browser             exclude a term
```

Phrases and prefixes are the ones people use most. Boolean operators are there when you need to cut noise.

### When BM25 wins

- **Exact names.** Function names, error codes, product names, people, acronyms. `ERR_CONNECTION_RESET` has no synonyms.
- **Quotes.** You remember a phrase word for word.
- **Rare terms.** The one article that mentioned a specific library.

### Where BM25 loses

It only matches words. Search for "how to make pages load faster" and it will miss an excellent article titled "Cutting time to first byte in half" that never says "faster". Different words, same idea.

## Layer 2: semantic search, the meaning specialist

The second layer fixes exactly that. Every document in your library is embedded with **bge-m3**, a multilingual embedding model, and the vectors are stored in **Cloudflare Vectorize**.

An embedding turns a piece of text into a list of numbers that represents its meaning. Texts about similar things end up close together, even when they share no words. Your query gets embedded the same way, and search becomes "find the documents nearest to this meaning".

### When semantic search wins

- **Fuzzy memory.** "That piece about why small teams ship faster."
- **Different vocabulary.** You search "latency", the author wrote "response time".
- **Different languages.** bge-m3 is multilingual, so a query in one language can find a document in another.
- **Questions.** Natural-language questions map well onto passages that answer them.

### Where semantic search loses

It is a bit vague by nature. Ask for `ERR_CONNECTION_RESET` and it may return articles about networking errors in general, ranked above the one page that contains that exact code. Close in meaning is not the same as correct.

## Why not just pick one?

Because you do not know in advance which kind of query you are about to type. Neither do we. Some searches are exact. Some are vibes. Most are somewhere in between.

So anymd.cc runs both and combines them. That is what "hybrid" means. The question is how to combine two ranked lists whose scores are on completely different scales. A BM25 score and a cosine similarity are not comparable numbers.

## Layer 3: query fan-out and Reciprocal Rank Fusion

### Fan-out

Before searching, an LLM rewrites your query into a few **variants**. A short query like:

```text
edge caching
```

might fan out into something like (illustrative):

```text
edge caching
CDN cache invalidation strategies
caching responses at the edge with Cloudflare Workers
how to reduce origin load with a cache
```

Each variant is searched with BM25 and with embeddings. Now you are not relying on the one phrasing you happened to type. You get coverage for the phrasings the author might have used.

### Reciprocal Rank Fusion

All those result lists then need to become one list. anymd.cc uses **Reciprocal Rank Fusion (RRF)**, which ignores raw scores entirely and looks only at **positions**.

Each document gets points from every list it appears in:

```text
score(doc) = sum over lists of 1 / (k + rank of doc in that list)
```

`k` is a constant, commonly 60, that stops the very top positions from dominating completely.

A small worked example, **illustrative only**, with `k = 60`:

| Document | Rank in BM25 list | Rank in semantic list | RRF score |
| --- | --- | --- | --- |
| A | 1 | 4 | 1/61 + 1/64 ≈ 0.0320 |
| B | not found | 1 | 1/61 ≈ 0.0164 |
| C | 2 | 2 | 1/62 + 1/62 ≈ 0.0323 |

Document C wins. It was never first anywhere, but it was near the top everywhere. That is exactly the behavior you want: a document that both methods agree on beats one that only a single method loves.

RRF is simple, robust, and needs no tuning per library. It also scales naturally to many lists, which is what fan-out produces.

### When fan-out plus RRF wins

- **Short or vague queries.** Two words carry little information. Variants add it back.
- **Mixed queries.** "Stripe webhook retries best practice" has an exact term and a concept. Both halves get served.
- **Broad recall.** When you want everything relevant, not just the one best hit.

## Layer 4: Jev, the tiebreaker

Sometimes fusion leaves two or three results almost tied at the top. The scores cannot really tell them apart, and the order among them is close to a coin flip.

That is where **Jev** comes in. Jev (TypeSafe System One) is an **optional decider**. When the top results are near-tied, it looks at your query and the candidates' titles and picks the one that best fits what you asked.

It is deliberately narrow:

- It only runs when there is a real tie to break.
- It only reorders the top candidates. It does not add or remove results.
- It is **opt-in**. When enabled, TypeSafe receives a sanitized version of your query and the **titles** of the candidate results. It never receives document bodies. That is spelled out in our [privacy policy](/legal/privacy).

### When Jev wins

- **Question-shaped queries** with several plausible answers, where intent matters more than term overlap.
- **Libraries with near-duplicates**, like several posts on the same topic, where the best title-to-intent match is the one you meant.

If you never turn it on, nothing breaks. You get the fused ranking as-is.

## Cheat sheet: which layer is doing the work

| You type | Who carries it |
| --- | --- |
| `"exact phrase you remember"` | BM25 (phrase syntax) |
| `ERR_CONNECTION_RESET` | BM25 |
| `vector*` | BM25 (prefix syntax) |
| "that post about small teams moving fast" | Semantic search |
| A query in one language, source in another | Semantic search (bge-m3) |
| Two vague words | Fan-out plus RRF |
| "best way to handle webhook retries" | Hybrid, with Jev breaking a close call if enabled |

## Using it

In the dashboard, just type. For agents, the `search_library` MCP tool runs the same pipeline, and `get_document` fetches the full text of whatever it finds. Setup takes a minute: see [Give your agent a Markdown memory](/blog/give-your-agent-a-markdown-memory-with-mcp) and the [MCP docs](/docs/mcp). The REST equivalents are in the [docs](/docs).

## Why this matters for agents

An agent's answers are only as good as what it retrieves. Keyword-only search makes agents literal and brittle. Vector-only search makes them confidently approximate. Hybrid search, with fan-out for coverage and a tiebreaker for close calls, gets you closer to what a careful human researcher would pull off the shelf.

And because the library is Markdown with frontmatter, every retrieved result comes with its source URL, so the agent can cite it and you can check it.

The library comes with every account, including Free. [Pricing](/pricing) only changes how much you can convert. More deep dives on the [blog](/blog).
