-- Performance indexes for pvpgn_BNET table
CREATE INDEX IF NOT EXISTS idx_acct_email ON pvpgn_BNET (acct_email);
CREATE INDEX IF NOT EXISTS idx_acct_username ON pvpgn_BNET (acct_username);
