-- Core schema for anymd.cc

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  avatar_url TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  polar_customer_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- sha256(token)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,              -- first chars shown in UI
  key_hash TEXT NOT NULL UNIQUE,     -- sha256(full key)
  role TEXT NOT NULL DEFAULT 'user', -- role template the key acts as (capped by owner role)
  scopes TEXT NOT NULL DEFAULT '[]', -- JSON array
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  url_hash TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  domain TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  published TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'web',
  tags TEXT NOT NULL DEFAULT '',     -- space separated
  markdown TEXT NOT NULL,
  word_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  embedded_chunks INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, url_hash)
);
CREATE INDEX idx_documents_user_created ON documents(user_id, created_at DESC);
CREATE INDEX idx_documents_user_domain ON documents(user_id, domain);

CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, description, markdown, domain, tags,
  content='documents', content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, description, markdown, domain, tags)
  VALUES (new.rowid, new.title, new.description, new.markdown, new.domain, new.tags);
END;
CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, description, markdown, domain, tags)
  VALUES ('delete', old.rowid, old.title, old.description, old.markdown, old.domain, old.tags);
END;
CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, description, markdown, domain, tags)
  VALUES ('delete', old.rowid, old.title, old.description, old.markdown, old.domain, old.tags);
  INSERT INTO documents_fts(rowid, title, description, markdown, domain, tags)
  VALUES (new.rowid, new.title, new.description, new.markdown, new.domain, new.tags);
END;

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  api_key_id TEXT,
  channel TEXT NOT NULL,             -- web | api | mcp | cli | webmcp
  kind TEXT NOT NULL,                -- convert | search | ...
  target TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,              -- ok | error | cached
  http_status INTEGER NOT NULL DEFAULT 200,
  credits REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  trace_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_usage_user_created ON usage_events(user_id, created_at DESC);
CREATE INDEX idx_usage_created ON usage_events(created_at);

CREATE TABLE traces (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  kind TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  spans TEXT NOT NULL DEFAULT '[]',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_traces_user_created ON traces(user_id, created_at DESC);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,               -- Polar subscription id
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  billing_interval TEXT NOT NULL DEFAULT 'month',
  status TEXT NOT NULL,
  current_period_start INTEGER,
  current_period_end INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_subscriptions_user ON subscriptions(user_id);

CREATE TABLE credit_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,              -- polar_order | admin | promo
  reference TEXT,
  credits INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX idx_credit_grants_user ON credit_grants(user_id);

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  markdown TEXT NOT NULL,
  cover_url TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'article',   -- article | announcement | guide
  author_name TEXT NOT NULL DEFAULT 'Duy /zuey/',
  status TEXT NOT NULL DEFAULT 'draft',       -- draft | published
  seo_title TEXT NOT NULL DEFAULT '',
  seo_description TEXT NOT NULL DEFAULT '',
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_posts_status_published ON posts(status, published_at DESC);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',       -- draft | published | archived
  revision INTEGER NOT NULL DEFAULT 1,
  published_revision INTEGER,
  draft TEXT NOT NULL,                        -- JSON page document
  published TEXT,                             -- JSON page document
  preview_token TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE TABLE page_revisions (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  doc TEXT NOT NULL,
  author TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, revision)
);

CREATE TABLE idempotency_keys (
  key TEXT NOT NULL,
  principal TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key, principal)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
INSERT INTO stats(key, value) VALUES ('conversions_total', 0);
