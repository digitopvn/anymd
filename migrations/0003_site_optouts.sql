-- Domains whose owners asked anymd not to fetch them. A row blocks the domain and all its subdomains.
CREATE TABLE IF NOT EXISTS site_optouts (
  domain TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at INTEGER NOT NULL
);
