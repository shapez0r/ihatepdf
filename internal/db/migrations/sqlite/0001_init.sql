-- ihatepdf initial schema (SQLite)
-- Timestamps are unix seconds. IDs are application-generated UUIDs.

CREATE TABLE users (
    id            VARCHAR(36)  NOT NULL PRIMARY KEY,
    email         VARCHAR(255) NOT NULL UNIQUE,
    display_name  VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255),
    created_at    BIGINT       NOT NULL
);

-- External identities (Google, Apple, ...) linked to a user. Reserved for upcoming OAuth/OIDC sign-in.
CREATE TABLE auth_identities (
    provider   VARCHAR(32)  NOT NULL,
    subject    VARCHAR(255) NOT NULL,
    user_id    VARCHAR(36)  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT       NOT NULL,
    PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_auth_identities_user ON auth_identities(user_id);

CREATE TABLE sessions (
    token_hash VARCHAR(64) NOT NULL PRIMARY KEY,
    user_id    VARCHAR(36) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT      NOT NULL,
    created_at BIGINT      NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- "My files": PDFs saved by a user (merged, split, signed, filled in, ...).
-- The bytes live in the database so every replica can serve every file.
CREATE TABLE documents (
    id         VARCHAR(36)  NOT NULL PRIMARY KEY,
    owner_id   VARCHAR(36)  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       VARCHAR(255) NOT NULL,
    size       BIGINT       NOT NULL,
    pages      INTEGER      NOT NULL DEFAULT 0,
    sha256     VARCHAR(64)  NOT NULL,
    content    BLOB         NOT NULL,
    created_at BIGINT       NOT NULL,
    updated_at BIGINT       NOT NULL
);
CREATE INDEX idx_documents_owner ON documents(owner_id, updated_at);
