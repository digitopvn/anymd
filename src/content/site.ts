/** Site-wide copy and facts. Pages and their `.md` twins both read from here. */

export const SITE = {
  name: 'anymd',
  domain: 'anymd.cc',
  tagline: 'Convert anything on the internet to Markdown.',
  description:
    'anymd turns any URL — web pages, X posts, YouTube, GitHub, Reddit, Hacker News, PDFs, images — into clean Markdown for AI agents, with a searchable personal library, API, CLI, MCP and WebMCP.',
  github: 'https://github.com/digitopvn/anymd',
  email: 'hello@digitop.ai',
  owner: 'Digitop.ai',
  ownerUrl: 'https://digitop.ai',
  partner: 'nextlevelbuilder',
  partnerUrl: 'https://nextlevelbuilder.io',
  x: 'https://x.com/goon_nguyen',
};

export const NAV = [
  { href: '/#how', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/docs', label: 'Docs' },
  { href: '/blog', label: 'Blog' },
  { href: '/changelog', label: 'Changelog' },
  { href: '/ecosystem', label: 'Ecosystem' },
];

export const SOURCES = [
  { kind: 'web', label: 'Any web page', note: 'Articles, docs, blogs — clutter removed', icon: 'globe' },
  { kind: 'x', label: 'X / Twitter', note: 'Posts, quotes, media, engagement stats', icon: 'x' },
  { kind: 'youtube', label: 'YouTube', note: 'Title, channel and a timestamped transcript', icon: 'play' },
  { kind: 'github', label: 'GitHub', note: 'READMEs, issues, PRs and discussions', icon: 'git' },
  { kind: 'reddit', label: 'Reddit', note: 'Threads with nested comments', icon: 'chat' },
  { kind: 'hackernews', label: 'Hacker News', note: 'Stories plus the top of the discussion', icon: 'hn' },
  { kind: 'pdf', label: 'PDF', note: 'Text layout kept, tables preserved', icon: 'file' },
  { kind: 'document', label: 'DOCX · XLSX · CSV', note: 'Office files and sheets as Markdown tables', icon: 'table' },
  { kind: 'image', label: 'Images', note: 'Vision model describes and transcribes', icon: 'image' },
];

export const ROADMAP_SOURCES = ['Audio & podcasts', 'Any video (Whisper)', 'Facebook', 'LinkedIn', 'Threads', 'TikTok', 'Notion', 'Google Docs', 'EPUB'];

export const ECOSYSTEM = [
  {
    name: 'Dewee',
    url: 'https://dewee.sh',
    logo: '/brand/dewee.png',
    tagline: 'Multi-agent AI gateway built in Go. Single binary. Production-tested.',
    tag: 'Gateway',
  },
  {
    name: 'AgentBrain',
    url: 'https://agentbrain.sh',
    logo: '/brand/agentbrain.svg',
    tagline: 'AI data platform: semantic search and ETL your agents can query over MCP.',
    tag: 'Data',
  },
  {
    name: 'AgentKit',
    url: 'https://agentkit.best',
    logo: '/brand/agentkit.svg',
    tagline: 'Complete AI engineering framework to build and review quality work.',
    tag: 'Framework',
  },
  {
    name: 'GoClaw',
    url: 'https://goclaw.sh',
    logo: '/brand/goclaw.svg',
    tagline: 'Multi-agent gateway in Go with a lightweight desktop companion.',
    tag: 'Gateway',
  },
  {
    name: 'AgentWiki',
    url: 'https://agentwiki.cc',
    logo: '/brand/agentwiki.png',
    tagline: 'A knowledge platform for humans and agents, with hybrid search and MCP.',
    tag: 'Knowledge',
  },
  {
    name: 'UI UX Pro Max',
    url: 'https://uupm.cc',
    logo: '/brand/uupm.svg',
    tagline: 'Design intelligence skill for AI coding agents. 11K+ GitHub stars.',
    tag: 'Design',
  },
  {
    name: 'TOSE.sh',
    url: 'https://tose.sh',
    logo: '',
    tagline: 'Git-to-Kubernetes PaaS: push code, get a running app.',
    tag: 'PaaS',
  },
];

export const FOUNDER = {
  name: 'Duy Nguyen',
  handle: '/zuey/',
  avatar: 'https://cdn.zuey.me/avatar.png',
  role: 'Founder, Digitop.ai',
  links: [
    { label: 'X', url: 'https://x.com/goon_nguyen' },
    { label: 'GitHub', url: 'https://github.com/mrgoonie' },
    { label: 'zuey.me', url: 'https://zuey.me' },
  ],
  facts: [
    'CTO & Co-founder at TOPGROUP, DIGITOP & XINCHAO Live Music',
    'Founder of Build in Public VN',
    'Self-described "F*ck Around & Find Out" Specialist',
    'Ships open-source tools for AI agents: GoClaw, AgentKit, UI UX Pro Max',
  ],
  quotes: [
    'Agents don’t need prettier websites. They need cleaner text.',
    'Every token of HTML noise is a token your agent didn’t spend thinking.',
    'Build in public, ship small, measure honestly — then do it again tomorrow.',
    'The best memory for an agent is the stuff you already read.',
    'Open source first. If it helps us, it should help you too.',
  ],
};

export const FAQ = [
  {
    q: 'Is anymd free?',
    a: 'Yes. Anyone can prefix a URL with anymd.cc/ — no account, up to 50 conversions a day. A free account gives you 500 credits a month plus a searchable library. Paid plans start at $9/month.',
  },
  {
    q: 'What is a credit?',
    a: 'One web page = 1 credit. A YouTube video with transcript or a PDF/Office file = 3 credits. An image = 5 credits. Cached results, library search and MCP reads are free.',
  },
  {
    q: 'How is this different from copying the page text?',
    a: 'anymd runs a proven content-extraction engine plus site-specific adapters for X, YouTube, GitHub, Reddit and Hacker News. You get the article, not the nav, cookie banners, ads or related posts, with headings, links, tables, code and footnotes intact.',
  },
  {
    q: 'Can my AI agent use it?',
    a: 'That is the point. Use the HTTP API, the CLI, or connect the MCP server at anymd.cc/mcp (OAuth or API key). In the browser, anymd exposes WebMCP tools so in-page agents can convert and search too.',
  },
  {
    q: 'What happens to what I convert?',
    a: 'Signed-in conversions are saved to your private library so you and your agents can search them. Nothing is shared, nothing is used to train models, and you can delete any document — or your whole account — at any time.',
  },
  {
    q: 'Is it open source?',
    a: 'Yes, MIT-licensed at github.com/digitopvn/anymd. You can self-host it on your own Cloudflare account.',
  },
  {
    q: 'What if I run out of credits?',
    a: 'On Free you wait for next month or upgrade. On Pro and Scale you are never blocked: extra usage is billed at $1 (Pro) or $0.60 (Scale) per 1,000 credits.',
  },
  {
    q: 'Can I get a refund?',
    a: 'Yes — 14-day money-back on your first subscription payment if you used less than 20% of the month’s credits. See the refund policy for details.',
  },
];
