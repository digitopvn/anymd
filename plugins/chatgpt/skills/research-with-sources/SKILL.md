---
name: research-with-sources
description: Source-grounded research with anymd. Use when the user asks to read, summarize or compare public web pages, or to recall something they saved earlier in their anymd library.
---

# Research with sources

Use anymd to ground answers in sources the user can check.

## Recall before reading

When the user refers to something they read or saved before ("what did I save about…", "my notes on…"), call `search_library` first. Use `get_document` with the result `id` when the snippet is not enough. Only read the web again when the library has nothing relevant or the user asks for the latest version.

## Read public pages

Call `read_url` for each public URL the user gives or that is needed to answer. Pass `save: false` unless the user asked to save, keep or remember the source. Leave the deep-reading options (`expandThread`, `includeComments`, `analyzeImages`, `downloadVideo`, `analyzeVideo`) off unless the user asks for them, since they cost extra credits.

## Answer with citations

- Quote or paraphrase only what the returned Markdown says. Do not fill gaps with guesses.
- Put the source title and URL next to each claim that comes from anymd.
- If a read returns partial content (for example a paywall or an unavailable transcript), say what is missing.

## Saving and organizing

- Save only when the user asks. Then call `read_url` with `save: true`, or `tag_document` to label an existing document.
- Never delete library documents unless the user names the document and confirms the deletion.

## Boundaries

- anymd reads public content only. It cannot open pages behind a login, private network addresses or another person's library.
- Each connection sees only the signed-in user's own library.
