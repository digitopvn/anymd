---
title: "Support"
description: "How to get help with anymd: email, bug reports, security reports, account and data requests, and disconnecting ChatGPT or another AI assistant."
updated: "2026-10-28"
---

anymd is built and run by [Digitop.ai](https://digitop.ai). Pick the route that fits your question.

## Contact

| I need to… | Do this |
|---|---|
| Ask a question or get help with my account | Email [hello@digitop.ai](mailto:hello@digitop.ai) from the address you sign in with. |
| Report a bug or suggest a feature | Use **Feedback** in the dashboard, the API, MCP or the CLI. See [Send feedback](/docs/feedback). Reports become public GitHub issues, so leave out anything private. |
| Report a security problem | Email [hello@digitop.ai](mailto:hello@digitop.ai) privately, not in a public issue. The contact is also published at [`/.well-known/security.txt`](/.well-known/security.txt). |
| Export, correct or delete my data | Use the dashboard (export the library, delete documents, revoke keys, delete the account), or see [Privacy](/legal/privacy) and [GDPR](/legal/gdpr). |
| Ask about billing, a refund or my plan | See [Billing & credits](/docs/billing) and the [Refund policy](/legal/refund), then email us if you still need help. |
| Ask a site owner question (opt-out, rate limits) | See [Site Owners & Abuse](/legal/abuse). |

We answer email in English or Vietnamese.

## Using anymd in ChatGPT

The anymd app for ChatGPT connects to [anymd.cc/mcp](/docs/mcp) and signs in with your anymd account through OAuth. It reads public pages, searches your library and opens saved sources. It saves a page only when you ask it to.

**Something went wrong in ChatGPT?** Check these first:

- **"Not enough credits" (`quota_exceeded`).** Reading a new source uses credits from your anymd plan. Searching your library and opening saved documents do not. Your balance is on the dashboard.
- **"Missing scope" (`insufficient_scope`).** The connection was approved without the access the tool needs. Disconnect it (below) and connect again.
- **A page cannot be read.** anymd reads public content only. Pages behind a login, private network addresses and sites that opt out are refused. See [Supported sources](/docs/sources).

**Disconnect ChatGPT** from either side:

- In anymd: **Dashboard → API keys → Connected apps → Disconnect**. Its tokens stop working at once.
- In ChatGPT: remove the anymd app from your connected apps in ChatGPT's settings.

Disconnecting does not delete your library. Documents ChatGPT saved stay until you delete them.

When you email us about a ChatGPT problem, include the approximate time, the URL or search you tried, and the error text ChatGPT showed. Do not send your password, API keys or tokens.
