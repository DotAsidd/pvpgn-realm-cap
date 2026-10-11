-- Token store for account verification and password reset.
-- Fresh deployments create this table automatically via docker-entrypoint-initdb.d.

CREATE TABLE IF NOT EXISTS reg_tokens (
    username   VARCHAR(32) NOT NULL,
    kind       VARCHAR(16) NOT NULL,
    token      VARCHAR(64) NOT NULL,
    expires_ts BIGINT      NOT NULL,
    PRIMARY KEY (username, kind),
    INDEX idx_reg_tokens_token (token)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;