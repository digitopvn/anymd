/** OpenAPI 3.1 description of /api/v1, rendered interactively at /docs/api/reference. */
import { KEY_PRESETS } from './auth/roles';
import { ADMIN_OPS, ADMIN_SCHEMAS } from './openapi-admin';
import { arr, bool, idParam, int, nullable, obj, ref, str, type Op, type Schema } from './openapi-helpers';

const ERROR_TEXT: Record<number, string> = {
  400: 'Bad request',
  401: 'Missing or invalid credentials',
  402: 'Monthly credits exhausted',
  403: 'Missing scope or forbidden',
  404: 'Not found',
  409: 'Conflict: stale revision or version, or a resource owned by billing',
  413: 'File too large',
  415: 'Unsupported file type',
  422: 'Validation failed',
  429: 'Rate limited — see Retry-After',
  502: 'The source site failed or blocked the fetch',
};

const OPS: Record<string, Record<string, Op>> = {
  '/me': { get: { summary: 'Current account', tag: 'Account', scope: '', ok: ref('Me') } },
  '/convert': {
    post: {
      summary: 'Read a URL as Markdown',
      description: 'Fetches the URL, extracts the main content (with dedicated adapters for X, YouTube, GitHub, Reddit, Hacker News and documents) and returns Markdown. Results are cached for an hour; cached hits cost 0 credits. Anonymous calls are allowed at a small daily limit.',
      tag: 'Convert',
      scope: 'convert',
      body: obj(
        {
          url: str('URL to convert', { examples: ['https://example.com/blog/post'] }),
          language: str('Preferred language (BCP 47) for multilingual pages'),
          selector: str('CSS selector to force the content root'),
          removeImages: bool('Strip images'),
          frontmatter: bool('Prepend YAML frontmatter (default true)'),
          save: bool('Save to the library (default true when signed in)'),
          fresh: bool('Bypass the cache'),
          includeComments: bool('Read comments and replies; extra credits, requires account'),
          analyzeImages: bool('OCR and describe article images; extra credits, requires account'),
          maxComments: int('Maximum comments including replies', { minimum: 1, maximum: 1000, default: 100 }),
          maxImages: int('Maximum analyzed article images', { minimum: 1, maximum: 20, default: 10 }),
          maxCredits: int('Maximum credits for this request; returns explicit partial results at the limit', { minimum: 1, maximum: 1000, default: 100 }),
          format: str('Response format', { enum: ['json', 'markdown'], default: 'json' }),
        },
        ['url'],
      ),
      ok: ref('Conversion'),
      errors: [400, 402, 422, 429, 502],
    },
  },
  '/convert/file': {
    post: {
      summary: 'Convert an uploaded file',
      description: 'PDF, DOCX, XLSX, XLS, ODS, ODT, CSV, XML and images (JPG, PNG, WEBP, SVG) up to 20 MB.',
      tag: 'Convert',
      scope: 'convert',
      bodyType: 'multipart/form-data',
      body: obj({ file: str('The file', { format: 'binary' }), save: str('"0" to skip saving', { enum: ['0', '1'] }) }, ['file']),
      ok: obj({ name: str(), bytes: int(), kind: str(), title: str(), word_count: int(), markdown: str(), document_id: nullable(str()), credits: int(), trace_id: str(), duration_ms: int() }),
      errors: [400, 402, 413, 415, 422],
    },
  },
  '/library': {
    get: {
      summary: 'List library documents',
      tag: 'Library',
      scope: 'library:read',
      params: [
        { name: 'limit', in: 'query', schema: int(undefined, { minimum: 1, maximum: 100, default: 20 }) },
        { name: 'before', in: 'query', schema: int('Cursor: `next_cursor` from the previous page') },
        { name: 'domain', in: 'query', schema: str() },
        { name: 'kind', in: 'query', schema: str('Source kind, e.g. web, x, youtube, pdf') },
      ],
      ok: obj({ items: arr(ref('DocumentSummary')), next_cursor: nullable(int()) }),
    },
  },
  '/library/{id}': {
    get: { summary: 'Get a document', tag: 'Library', scope: 'library:read', params: [idParam('Document'), { name: 'format', in: 'query', schema: str('`md` returns text/markdown', { enum: ['md'] }) }], ok: ref('Document'), errors: [404] },
    patch: { summary: 'Replace document tags', tag: 'Library', scope: 'library:write', params: [idParam('Document')], body: obj({ tags: arr(str(), 'Up to 20 tags') }, ['tags']), ok: ref('Ok'), errors: [404, 422] },
    delete: { summary: 'Delete a document', tag: 'Library', scope: 'library:write', params: [idParam('Document')], ok: ref('Ok'), errors: [404] },
  },
  '/search': {
    get: {
      summary: 'Search the library',
      description: 'Modes: `hybrid` (BM25 + semantic, fused with reciprocal rank fusion), `bm25`, `fulltext` (FTS5 query syntax) and `semantic`. `fanout=1` rewrites the query into variants and `decide=1` lets the Jev decision model break near-ties at the top; both are Pro+ and are listed in `gated` when skipped on Free.',
      tag: 'Search',
      scope: 'library:read',
      params: [
        { name: 'q', in: 'query', required: true, schema: str() },
        { name: 'mode', in: 'query', schema: str(undefined, { enum: ['hybrid', 'bm25', 'fulltext', 'semantic'], default: 'hybrid' }) },
        { name: 'limit', in: 'query', schema: int(undefined, { minimum: 1, maximum: 50, default: 10 }) },
        { name: 'fanout', in: 'query', schema: str(undefined, { enum: ['0', '1'] }) },
        { name: 'decide', in: 'query', schema: str(undefined, { enum: ['0', '1'] }) },
      ],
      ok: ref('SearchResponse'),
    },
    post: {
      summary: 'Search the library (JSON body)',
      tag: 'Search',
      scope: 'library:read',
      body: obj({ q: str(), mode: str(undefined, { enum: ['hybrid', 'bm25', 'fulltext', 'semantic'] }), limit: int(), fanout: bool(), decide: bool() }, ['q']),
      ok: ref('SearchResponse'),
    },
  },
  '/usage': {
    get: {
      summary: 'Usage summary',
      tag: 'Usage',
      scope: 'usage:read',
      params: [{ name: 'days', in: 'query', schema: int(undefined, { minimum: 1, maximum: 90, default: 30 }) }],
      ok: obj({ plan: str(), quota: obj({ included: int(), extra: int(), used: int(), remaining: int() }), totals: obj({ requests: int(), credits: int(), errors: int(), cached: int() }), daily: arr(obj({ day: str(), credits: int(), n: int() })), by_channel: arr(obj({ channel: str(), n: int(), credits: int() })), events: arr(ref('UsageEvent')) }),
    },
  },
  '/traces': {
    get: {
      summary: 'Recent traces',
      tag: 'Usage',
      scope: 'usage:read',
      params: [
        { name: 'limit', in: 'query', schema: int(undefined, { maximum: 200, default: 50 }) },
        { name: 'cursor', in: 'query', schema: str(), description: 'next_cursor from the previous page' },
      ],
      ok: obj({ items: arr(ref('Trace')), next_cursor: nullable(str()) }),
    },
  },
  '/traces/{id}': { get: { summary: 'Trace with spans', tag: 'Usage', scope: 'usage:read', params: [idParam('Trace')], ok: ref('Trace'), errors: [404] } },
  '/keys': {
    get: { summary: 'List API keys', tag: 'Keys', scope: 'keys:manage', ok: obj({ items: arr(ref('ApiKey')), presets: arr(obj({ id: str(), label: str(), scopes: arr(str()) })) }) },
    post: {
      summary: 'Create an API key',
      description: `The secret is returned once. Presets: ${KEY_PRESETS.map((p) => `\`${p.id}\``).join(', ')}. A key never gets scopes its creator lacks. Free accounts may hold 2 active keys.`,
      tag: 'Keys',
      scope: 'keys:manage',
      body: obj({ name: str(), preset: str(undefined, { enum: KEY_PRESETS.map((p) => p.id) }), scopes: arr(str()), expires_in_days: int(undefined, { minimum: 1, maximum: 3650 }) }, ['name']),
      ok: { content: 'application/json', schema: { allOf: [ref('ApiKey'), obj({ key: str('Secret — shown once') })] } },
      status: 201,
      errors: [403, 422],
    },
  },
  '/keys/{id}': { delete: { summary: 'Revoke an API key', tag: 'Keys', scope: 'keys:manage', params: [idParam('Key')], ok: ref('Ok'), errors: [404] } },
  '/admin/blocks': { get: { summary: 'Block catalog', description: 'Every block type with its JSON Schema for props, allowed sizes and slots.', tag: 'Pages', scope: 'pages:read', ok: obj({ items: arr(obj({ type: str(), label: str(), description: str(), sizes: arr(str()), slots: arr(str()), props: { type: 'object' }, example: { type: 'object' } })) }) } },
  '/admin/templates': { get: { summary: 'Page templates', tag: 'Pages', scope: 'pages:read', ok: obj({ items: arr(obj({ id: str(), label: str(), description: str(), layout: str(), blocks: arr(str()) })) }) } },
  '/admin/pages': {
    get: { summary: 'List pages', tag: 'Pages', scope: 'pages:read', ok: obj({ items: arr(ref('Page')) }) },
    post: { summary: 'Create a draft page', tag: 'Pages', scope: 'pages:write', body: obj({ slug: str(), title: str(), description: str(), template: str(undefined, { enum: ['blank', 'ads-landing', 'seo-article', 'product-launch'] }), layout: str(undefined, { enum: ['default', 'landing', 'article'] }) }, ['slug', 'title']), ok: obj({ page: ref('Page') }), status: 201, errors: [409, 422] },
  },
  '/admin/pages/{id}': {
    get: { summary: 'Get a page (with draft)', tag: 'Pages', scope: 'pages:read', params: [idParam('Page (or slug)')], ok: obj({ page: ref('Page') }), errors: [404] },
    delete: { summary: 'Archive a page', tag: 'Pages', scope: 'pages:write', params: [idParam('Page')], ok: obj({ pageId: str(), status: str() }), errors: [404] },
  },
  '/admin/pages/{id}/ops': {
    post: {
      summary: 'Apply edit operations',
      description: 'Atomic batch against `baseRevision`. On 409 `revision_conflict`, re-read the page and retry. Send `Idempotency-Key` to make retries safe.',
      tag: 'Pages',
      scope: 'pages:write',
      params: [idParam('Page'), { name: 'Idempotency-Key', in: 'header', schema: str() }],
      body: obj({ baseRevision: int(), ops: arr(ref('PageOp')), idempotencyKey: str(), note: str() }, ['baseRevision', 'ops']),
      ok: obj({ pageId: str(), revision: int(), createdBlockIds: arr(str()), slug: str(), replayed: bool('True when an Idempotency-Key replay'), page: ref('Page') }),
      errors: [404, 409, 422],
    },
  },
  '/admin/pages/{id}/publish': { post: { summary: 'Publish a page', tag: 'Pages', scope: 'pages:publish', params: [idParam('Page')], body: obj({ revision: int('Defaults to the current draft') }), ok: obj({ pageId: str(), publishedRevision: int(), slug: str(), url: str() }), errors: [404] } },
  '/admin/pages/{id}/unpublish': { post: { summary: 'Unpublish a page', tag: 'Pages', scope: 'pages:publish', params: [idParam('Page')], ok: obj({ pageId: str(), status: str() }), errors: [404] } },
  '/admin/pages/{id}/revisions': { get: { summary: 'Revision history', tag: 'Pages', scope: 'pages:read', params: [idParam('Page')], ok: obj({ items: arr(obj({ revision: int(), actor: str(), note: nullable(str()), created_at: int() })) }) } },
  '/admin/pages/{id}/preview-token': { post: { summary: 'Rotate the shareable preview link', tag: 'Pages', scope: 'pages:write', params: [idParam('Page')], ok: obj({ previewUrl: str() }) } },
  '/admin/pages/{id}/markdown': { get: { summary: 'Draft as Markdown', tag: 'Pages', scope: 'pages:read', params: [idParam('Page')], ok: { content: 'text/markdown', schema: str() } } },
  '/admin/posts': {
    get: { summary: 'List posts', tag: 'Blog', scope: 'content:read', ok: obj({ items: arr(ref('Post')) }) },
    post: { summary: 'Create a draft post', tag: 'Blog', scope: 'content:write', body: ref('PostInput'), ok: obj({ post: ref('Post') }), status: 201, errors: [409, 422] },
  },
  '/admin/posts/{id}': {
    get: { summary: 'Get a post', tag: 'Blog', scope: 'content:read', params: [idParam('Post')], ok: obj({ post: ref('Post') }), errors: [404] },
    patch: { summary: 'Update a post', tag: 'Blog', scope: 'content:write', params: [idParam('Post')], body: ref('PostInput'), ok: obj({ post: ref('Post') }), errors: [404, 422] },
    delete: { summary: 'Delete a post', tag: 'Blog', scope: 'content:write', params: [idParam('Post')], ok: ref('Ok'), errors: [404] },
  },
  '/admin/posts/{id}/publish': { post: { summary: 'Publish or unpublish a post', tag: 'Blog', scope: 'content:publish', params: [idParam('Post')], body: obj({ publish: bool() }), ok: obj({ post: ref('Post'), url: str() }), errors: [404] } },
  // Admin control plane: users, roles, settings, opt-outs, credits, billing, audit and system.
  ...ADMIN_OPS,
};

const SCHEMAS: Record<string, Schema> = {
  Error: obj({ error: obj({ code: str(), message: str() }, ['code', 'message']) }, ['error']),
  Ok: obj({ ok: bool() }),
  Me: obj({ id: str(), email: str(), name: str(), role: str(), plan: str(), scopes: arr(str()), auth: str(undefined, { enum: ['session', 'api_key', 'oauth'] }), created_at: int() }),
  Conversion: obj({
    url: str(),
    title: str(),
    author: nullable(str()),
    published: nullable(str()),
    description: nullable(str()),
    domain: str(),
    site: nullable(str()),
    image: nullable(str()),
    language: nullable(str()),
    kind: str('Source kind: web, x, youtube, github, reddit, hackernews, pdf, docx, …'),
    word_count: int(),
    source_bytes: nullable(int('Size of the fetched HTML, when the source was a web page')),
    markdown: str('Markdown including frontmatter'),
    content: str('Markdown body without frontmatter'),
    document_id: nullable(str()),
    credits: int(),
    credit_breakdown: obj({ base: int(), thread: int(), comments: int(), images: int() }),
    enrichment: obj({
      thread: ref('Coverage'),
      comments: { allOf: [ref('Coverage'), obj({ markdown: str() })] },
      images: { allOf: [ref('Coverage'), obj({ items: arr(obj({ url: str(), markdown: str() })) })] },
    }, [], 'Coverage, retrieval timestamp and content of requested sections. Incomplete sections are explicit and are not cached.'),
    cached: bool(),
    trace_id: str(),
    duration_ms: int(),
    stats: obj({ likes: nullable(int()), retweets: nullable(int()), replies: nullable(int()), views: nullable(int()) }, [], 'X posts only'),
  }),
  DocumentSummary: obj({ id: str(), url: str(), title: str(), author: str(), description: str(), domain: str(), site: str(), image: str(), published: str(), language: str(), source_kind: str(), tags: str('Space-separated'), word_count: int(), embedded_chunks: int(), created_at: int(), updated_at: int() }),
  Coverage: obj({ complete: bool(), count: int(), reason: str(), fetchedAt: str('ISO 8601 retrieval timestamp') }),
  Document: { allOf: [ref('DocumentSummary'), obj({ markdown: str(), tags: arr(str()) })] },
  SearchHit: obj({ id: str(), title: str(), url: str(), domain: str(), source_kind: str(), snippet: str(), score: { type: 'number' }, matched: arr(str(), 'Retrievers that found it: bm25, fulltext, semantic'), created_at: int(), word_count: int() }),
  SearchResponse: obj({ query: str(), mode: str(), variants: arr(str(), 'Query variants when fan-out ran'), hits: arr(ref('SearchHit')), jev: nullable({ type: 'object', description: 'Jev tie-break decision, when it ran' }), took_ms: int(), gated: arr(str(), 'Features skipped because of the plan') }),
  UsageEvent: obj({ id: str(), channel: str(), kind: str(), target: str(), status: str(), http_status: int(), credits: int(), duration_ms: int(), trace_id: nullable(str()), error: nullable(str()), created_at: int() }),
  Trace: obj({ id: str(), kind: str(), target: str(), status: str(), duration_ms: int(), spans: arr(obj({ name: str(), start: int(), duration: int(), meta: { type: 'object' } })), meta: { type: 'object' }, created_at: int() }),
  ApiKey: obj({ id: str(), name: str(), prefix: str(), scopes: arr(str()), created_at: int(), last_used_at: nullable(int()), expires_at: nullable(int()), revoked_at: nullable(int()) }),
  Page: obj({ id: str(), slug: str(), title: str(), description: str(), status: str(undefined, { enum: ['draft', 'published', 'archived'] }), revision: int(), publishedRevision: nullable(int()), url: str(), markdownUrl: str(), previewUrl: str(), updatedAt: str(undefined, { format: 'date-time' }), publishedAt: nullable(str(undefined, { format: 'date-time' })), draft: { type: 'object', description: 'PageDocument: {layout, seo, blocks[]}' } }),
  PageOp: {
    oneOf: [
      obj({ op: { const: 'insert' }, block: obj({ type: str(), props: { type: 'object' }, size: str(undefined, { enum: ['small', 'medium', 'large'] }) }, ['type']), index: int(), parentId: str(), slot: str() }, ['op', 'block']),
      obj({ op: { const: 'update' }, id: str(), props: { type: 'object', description: 'Shallow-merged' }, size: str(undefined, { enum: ['small', 'medium', 'large'] }) }, ['op', 'id']),
      obj({ op: { const: 'replace_props' }, id: str(), props: { type: 'object' } }, ['op', 'id', 'props']),
      obj({ op: { const: 'move' }, id: str(), index: int(), parentId: str(), slot: str() }, ['op', 'id', 'index']),
      obj({ op: { const: 'remove' }, id: str() }, ['op', 'id']),
      obj({ op: { const: 'duplicate' }, id: str() }, ['op', 'id']),
      obj({ op: { const: 'set_seo' }, seo: obj({ title: str(), description: str(), image: str(), noindex: bool() }) }, ['op', 'seo']),
      obj({ op: { const: 'set_layout' }, layout: str(undefined, { enum: ['default', 'landing', 'article'] }) }, ['op', 'layout']),
      obj({ op: { const: 'set_meta' }, title: str(), description: str(), slug: str() }, ['op']),
    ],
  },
  Post: obj({ id: str(), slug: str(), title: str(), excerpt: str(), markdown: str(), cover_url: str(), tags: str(), category: str(), author_name: str(), status: str(undefined, { enum: ['draft', 'published'] }), seo_title: str(), seo_description: str(), published_at: nullable(int()), created_at: int(), updated_at: int() }),
  ...ADMIN_SCHEMAS,
  PostInput: obj({ slug: str(), title: str(), markdown: str(), excerpt: str(), tags: arr(str()), category: str(undefined, { enum: ['article', 'announcement', 'guide'] }), cover_url: str(), seo_title: str(), seo_description: str() }),
};

export function buildOpenApi(origin: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [path, methods] of Object.entries(OPS)) {
    paths[path] = {};
    for (const [method, op] of Object.entries(methods)) {
      const ok = 'content' in op.ok && 'schema' in op.ok ? (op.ok as { content: string; schema: Schema }) : { content: 'application/json', schema: op.ok as Schema };
      const responses: Record<string, unknown> = { [String(op.status ?? 200)]: { description: 'Success', content: { [ok.content]: { schema: ok.schema } } } };
      const errs = new Set([...(op.scope === undefined || op.scope === null ? [] : [401, 403]), 429, ...(op.errors ?? [])]);
      for (const code of [...errs].sort()) responses[String(code)] = { description: ERROR_TEXT[code] ?? 'Error', content: { 'application/json': { schema: ref('Error') } } };
      paths[path][method] = {
        operationId: `${method}${path.replace(/\{(\w+)\}/g, 'By_$1').replace(/[^a-zA-Z0-9]+(\w)/g, (_, ch: string) => ch.toUpperCase())}`,
        summary: op.summary,
        ...(op.description ? { description: op.description } : {}),
        tags: [op.tag],
        ...(op.scope ? { 'x-required-scope': op.scope } : {}),
        // The URL converter also works without credentials, at the anonymous daily limit.
        ...(path === '/convert' ? { security: [{}, { bearer: [] }] } : {}),
        ...(op.params ? { parameters: op.params } : {}),
        ...(op.body ? { requestBody: { required: true, content: { [op.bodyType ?? 'application/json']: { schema: op.body } } } } : {}),
        responses,
      };
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'anymd API',
      version: '1.0.0',
      summary: 'The web context layer for AI agents: read public web content as structured Markdown and recall it from a private, searchable library.',
      description:
        'Authenticate with an API key from https://anymd.cc/dashboard/keys: `Authorization: Bearer amd_…`. Every response includes `X-Anymd-Trace`; conversions also return `X-Anymd-Credits` and `X-Anymd-Cache`. Errors look like `{"error":{"code","message"}}`.\n\nNo-code shortcut: prefix any URL with `https://anymd.cc/` to get Markdown.',
      contact: { name: 'Digitop', email: 'hello@digitop.ai', url: 'https://digitop.ai' },
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ bearer: [] }],
    tags: [
      { name: 'Convert', description: 'URL and file conversion' },
      { name: 'Library', description: 'Saved documents' },
      { name: 'Search', description: 'BM25, full-text, semantic and hybrid search' },
      { name: 'Usage', description: 'Credits, request logs and traces' },
      { name: 'Keys', description: 'API key management' },
      { name: 'Account', description: 'The authenticated account' },
      { name: 'Pages', description: 'Page builder (editor role and above)' },
      { name: 'Blog', description: 'Blog posts (author role and above)' },
      { name: 'Admin', description: 'System administration: users, roles, credentials, settings, opt-outs, credits, billing (read-only), audit and system health. Owner/admin scopes only.' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'amd_…', description: 'API key or OAuth access token' },
        apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
      schemas: SCHEMAS,
    },
    externalDocs: { description: 'Docs', url: `${origin}/docs` },
  };
}
