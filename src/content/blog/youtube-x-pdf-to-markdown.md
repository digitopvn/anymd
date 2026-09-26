---
title: "YouTube, X, PDFs and Spreadsheets to Markdown"
slug: youtube-x-pdf-to-markdown
excerpt: "Not everything is an article. How anymd.cc turns videos, X posts and Articles, PDFs, images and spreadsheets into Markdown, and what each costs."
category: guide
tags: [youtube, twitter, pdf, spreadsheets, guide]
published_at: 2026-09-25
seo_title: "Convert YouTube Transcripts, X Posts, PDFs and Spreadsheets to Markdown"
seo_description: "Turn YouTube videos into timestamped transcripts, X posts and Articles into clean Markdown, and PDFs, images, DOCX, XLSX and CSV into tables and text."
---

Generic web extraction is great at articles. But a lot of what you actually want to read is not an article.

A conference talk is a video. The best take on a topic is an X post with a quote and a community note. The spec is a PDF. The data is a spreadsheet. Run these through a normal "reader mode" and you get a title, some navigation, and nothing useful.

anymd.cc handles each of these with a dedicated path. Same trick every time: put `anymd.cc/` in front of the URL. Here is what comes back, and what it costs.

## Credits at a glance

| Kind | Credits | Why |
| --- | --- | --- |
| Web page (including X posts, Hacker News, GitHub, Reddit and friends) | 1 | Fetch and extract |
| YouTube video | 3 | Metadata plus a full transcript |
| PDF or Office file (DOCX, XLSX, CSV and similar) | 3 | Document conversion with Workers AI |
| Image | 5 | A vision model describes it |

Free accounts get 500 credits a month. Heavier users should look at Pro or Scale on the [pricing page](/pricing).

## YouTube: the transcript is the content

A video page has almost no text. The content is what people say. So anymd does not bother extracting the page. It goes straight for the good parts:

- **Metadata** from YouTube's oEmbed endpoint: title, channel, thumbnail.
- **A timestamped transcript** from a RapidAPI transcript service (VidCap as fallback), grouped into readable sentences.

```bash
curl "https://anymd.cc/www.youtube.com/watch?v=VIDEO_ID"
```

Standard watch URLs, `youtu.be` short links, Shorts and live URLs all work.

The output looks like this (content shortened, illustrative):

```markdown
---
title: "Designing for the edge"
author: "Example Channel"
source: "https://www.youtube.com/watch?v=VIDEO_ID"
domain: "youtube.com"
site: "YouTube"
kind: youtube
---

# Designing for the edge

**Channel:** [Example Channel](https://www.youtube.com/@example)

## Transcript

**0:00** · Welcome back. Today we are talking about moving work to the edge.

**0:07** · The first question is always the same: what actually needs to be close to the user?
```

Those timestamps are the point. Ask an agent "where does the speaker talk about caching?" and it can answer with a real moment in the video you can jump to.

If a video has no transcript available, you still get the metadata, and the output says so plainly instead of pretending.

**Good prompts to pair it with:** "List every tool mentioned, with timestamps." "Summarize each section of this talk in two sentences." "Pull out every claim that includes a number."

## X: posts and long-form Articles

X pages are hostile to scrapers and mostly empty without JavaScript. anymd uses the FxTwitter API instead, which returns the post as structured data. That means you get things a screenshot would lose:

- **The full text**, including long posts.
- **Quote posts**, rendered inline as a quote block with their own text and media.
- **Polls**, with each choice, the vote counts and the total.
- **Media**: images and video links.
- **Community notes**, as a clearly marked note block.
- **Replying-to context**, so you know which conversation a post belongs to.
- **Engagement stats** in the frontmatter: likes, reposts, replies and views.

```bash
curl https://anymd.cc/x.com/username/status/1234567890
```

Both `x.com` and `twitter.com` links work.

### Long-form Articles

X Articles are proper long-form posts with headings, images and embedded media. anymd converts the Article body into real Markdown: headings stay headings, lists stay lists, images stay in place. It reads like a blog post because it basically is one.

### What about threads?

anymd converts the post you link, with its replying-to context. For a long thread, convert the posts you care about, or check whether the author also published it as an Article. Many do, and the Article is the cleaner read.

## Hacker News: the tree matters

Hacker News threads are conversations, and a flat dump of comments loses who replied to whom. anymd uses the official Hacker News API and keeps the structure: the story and its link on top, then top comments with their replies nested underneath as blockquotes, a few levels deep. Very large threads are trimmed to the top of the conversation, which is usually where the signal is anyway.

```bash
curl "https://anymd.cc/news.ycombinator.com/item?id=ITEM_ID"
```

Quote the URL in your shell, since it contains a `?`.

## PDFs: text you can actually use

Point anymd at a public PDF URL:

```bash
curl https://anymd.cc/example.com/papers/report.pdf
```

PDFs are converted with Cloudflare Workers AI's `toMarkdown`, which keeps the text layout readable. Files up to 20 MB are supported.

A few honest caveats:

- **Scanned PDFs** without a text layer are images of text. Results depend on how the file was produced.
- **Complex layouts** like multi-column academic papers or dense tables can come through imperfectly. The text is there, the formatting may need a look.
- **Password-protected PDFs** cannot be converted.

For most reports, papers, manuals and specs, you get clean text an agent can chunk, search and quote.

## Office files and spreadsheets

The same document path handles:

- **DOCX** and **ODT** documents, converted to headings, paragraphs and lists.
- **XLSX**, **XLS** and **ODS** spreadsheets, converted to Markdown tables.
- **CSV** files, converted to Markdown tables.

```bash
curl https://anymd.cc/example.com/data/prices.xlsx
curl https://anymd.cc/example.com/data/export.csv
```

Spreadsheets as Markdown tables are surprisingly useful. Models read them well, you can diff them in Git, and they paste cleanly into docs. For very large sheets, remember that every row is tokens. Filter before you feed a model a 50,000-row export.

## Images: a description, not just a link

Point anymd at a JPEG, PNG, WebP or SVG and a vision model describes it. You get the image embedded at the top, followed by the description as text.

```bash
curl https://anymd.cc/example.com/diagrams/architecture.png
```

That makes images searchable in your library and understandable by agents that only take text. Diagrams, screenshots, charts and slides all become something you can find later with a query.

Images cost 5 credits because vision inference is the most expensive thing we run. Worth it for a diagram you will search for again. Probably not for a stock photo.

## Shared AI conversations

A small bonus: shared conversation links from ChatGPT, Claude and Gemini convert too. You get the conversation turn by turn as Markdown, ready to archive, search or hand to another model for a second opinion.

## Save everything, search everything

When you are signed in, every one of these conversions lands in your library. That is where mixed formats get interesting. One search can surface a transcript line from a talk, a paragraph from a PDF and a post from X, all on the same topic, ranked together. [Hybrid search, explained](/blog/hybrid-search-bm25-semantic-query-fanout) covers how.

Want your agent to do the converting? Connect it to `https://anymd.cc/mcp` and it can call `convert_url` on any of these formats itself. Setup is in [Give your agent a Markdown memory](/blog/give-your-agent-a-markdown-memory-with-mcp) and the [MCP docs](/docs/mcp).

## Quick reference

```bash
# YouTube transcript (3 credits)
curl https://anymd.cc/youtu.be/VIDEO_ID

# X post or Article (1 credit)
curl https://anymd.cc/x.com/username/status/1234567890

# Hacker News thread (1 credit)
curl "https://anymd.cc/news.ycombinator.com/item?id=ITEM_ID"

# PDF or Office file (3 credits)
curl https://anymd.cc/example.com/report.pdf

# Image description (5 credits)
curl https://anymd.cc/example.com/diagram.png
```

Everything else is in the [docs](/docs). For the basics of formats, auth and errors, start with [How to convert any URL to Markdown](/blog/convert-any-url-to-markdown), and find more on the [blog](/blog).
