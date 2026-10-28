---
name: get-started
description: First-run setup for anymd. Use right after the plugin is installed, or when the user asks what anymd can do or how to connect it.
---

# Get started with anymd

anymd reads public web pages, GitHub, YouTube, Reddit, Hacker News, X posts, PDFs and Office files into clean Markdown, and keeps a private library of the sources the user chooses to save.

## 1. Connect

The first anymd tool call asks the user to sign in to anymd.cc and approve access. The default connection can read public URLs (`convert`), search the user's own library (`library:read`) and save to it (`library:write`). It cannot reach admin or billing functions. No API key is needed in ChatGPT.

If the user has no anymd account, they can create one at https://anymd.cc/signup during sign-in. Each account includes a monthly credit allowance; reading a page usually costs 1 credit and searching the library is free.

## 2. Try one read-only task

Offer one of these, then run it:

- "Read https://en.wikipedia.org/wiki/Markdown and summarize it with a link to the source." Call `read_url` with `save: false`.
- "What have I saved about vector search?" Call `search_library`.

Show the source URL with every answer that uses anymd content.

## 3. Saving is the user's choice

`read_url` saves to the library unless `save` is `false`. Pass `save: false` unless the user asked to keep, save or remember the source. When they do ask, pass `save: true` and confirm what was saved (title and URL).

## If something fails

- `quota_exceeded`: the monthly credits are used up. Say so plainly. Plans are described at https://anymd.cc/pricing; do not push an upgrade.
- `insufficient_scope`: the connection lacks a permission. Ask the user to reconnect anymd and approve it.
- A blocked or private URL: anymd only reads public web content. It cannot read pages behind a login or on private networks.

Help: https://anymd.cc/docs/support
