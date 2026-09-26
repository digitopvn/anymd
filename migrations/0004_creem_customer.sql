-- Creem customer id, set by the checkout.completed webhook; used to open the customer portal.
ALTER TABLE users ADD COLUMN creem_customer_id TEXT;
CREATE INDEX IF NOT EXISTS idx_users_creem_customer ON users(creem_customer_id);
