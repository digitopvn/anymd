/** Site-wide copy and facts. Pages and their `.md` twins both read from here. */

export const SITE = {
  name: 'anymd',
  domain: 'anymd.cc',
  tagline: 'The web context layer for AI agents.',
  headline: 'Turn the web into context your agents can use.',
  description:
    'anymd is the web context layer for AI agents: it reads public web content, normalizes it into structured Markdown, remembers what matters in a private searchable library, and makes it available anywhere through MCP, API and CLI.',
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

/** Ingestion rules the service enforces today (src/convert/robots.ts, optouts.ts; terms and /legal/abuse). */
export const RESPONSIBLE = [
  { icon: 'user', title: 'Requested URLs only', body: 'anymd reads the URLs a user or their agent asks for. It does not crawl or discover pages on its own.' },
  { icon: 'globe', title: 'Public content only', body: 'Only pages that anyone can reach on the open web, without an account.' },
  { icon: 'key', title: 'No bypassing access', body: 'No login, paywall or CAPTCHA bypass. Terms forbid users from trying, too.' },
  { icon: 'shield', title: 'Respects robots.txt', body: 'Checked before anymd fetches a page itself, for the anymd token or *. Disallowed pages are refused.' },
  { icon: 'lock', title: 'Domain opt-out', body: 'Site owners can block their domain on every channel, including cached results.' },
  { icon: 'clock', title: 'Per-site rate limits', body: 'Each site has a shared per-minute fetch budget, so agents never hammer a server.' },
  { icon: 'eye', title: 'Private library', body: 'What your agents read is saved to your account only. Never shared, never used to train models.' },
  { icon: 'send', title: 'Takedown process', body: 'Abuse reports and takedown requests go to a human at hello@digitop.ai.' },
];

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
    a: 'Yes. Anyone can prefix a URL with anymd.cc/ — no account, up to 50 reads a day. A free account gives you 500 credits a month plus a private, searchable context library. Paid plans start at $9/month.',
  },
  {
    q: 'What is a credit?',
    a: 'Credits pay for new source processing, priced by complexity: a web page is 1 credit, a YouTube transcript or a PDF/Office file is 3, an image is 5. Reusing what your agents already know is free: cached reads, library search and MCP recall never cost credits.',
  },
  {
    q: 'How is this different from fetching the HTML?',
    a: 'anymd is a source-aware reader: a proven content-extraction engine plus dedicated paths for sources such as GitHub, YouTube, Reddit, Hacker News, X and documents. Your agent gets the content, not the nav, cookie banners, ads or related posts, as structured Markdown with metadata, headings, links, tables, code and footnotes intact.',
  },
  {
    q: 'How do my agents use it?',
    a: 'Connect the MCP server at anymd.cc/mcp (OAuth or API key) and your agent gets read_url, search_library and get_document tools. Apps use the REST API, pipelines use the CLI, and in-browser agents get WebMCP tools on anymd.cc.',
  },
  {
    q: 'What happens to what my agents read?',
    a: 'Signed-in reads are saved to your private library so you and your agents can search them later. Nothing is shared, nothing is used to train models, and you can delete any document — or your whole account — at any time.',
  },
  {
    q: 'Does anymd crawl websites or get past paywalls?',
    a: 'No. anymd only reads URLs that a user or their agent asks for, and only content that is publicly reachable. It follows robots.txt, honours domain opt-outs, limits how often it hits each site, and never bypasses logins, paywalls or CAPTCHAs.',
  },
  {
    q: 'Is it open source?',
    a: 'Yes, MIT-licensed at github.com/digitopvn/anymd. You can self-host it on your own Cloudflare account.',
  },
  {
    q: 'What if I run out of credits?',
    a: 'New conversions pause until the 1st of next month, while cached reads and library search keep working. Upgrade any time to raise the limit straight away.',
  },
  {
    q: 'Can I get a refund?',
    a: 'Yes — 14-day money-back on your first subscription payment if you used less than 20% of the month’s credits. See the refund policy for details.',
  },
];
