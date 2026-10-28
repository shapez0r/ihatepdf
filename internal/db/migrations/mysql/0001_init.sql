-- ihatepdf initial schema (MariaDB / MySQL)
-- Timestamps are unix seconds. IDs are application-generated UUIDs.

CREATE TABLE users (
    id            VARCHAR(36)  NOT NULL PRIMARY KEY,
    email         VARCHAR(255) NOT NULL,
    display_name  VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NULL,
    created_at    BIGINT       NOT NULL,
    UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- External identities (Google, Apple, ...) linked to a user. Reserved for upcoming OAuth/OIDC sign-in.
CREATE TABLE auth_identities (
    provider   VARCHAR(32)  NOT NULL,
    subject    VARCHAR(255) NOT NULL,
    user_id    VARCHAR(36)  NOT NULL,
    created_at BIGINT       NOT NULL,
    PRIMARY KEY (provider, subject),
    KEY idx_auth_identities_user (user_id),
    CONSTRAINT fk_auth_identities_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
    token_hash VARCHAR(64) NOT NULL PRIMARY KEY,
    user_id    VARCHAR(36) NOT NULL,
    expires_at BIGINT      NOT NULL,
    created_at BIGINT      NOT NULL,
    KEY idx_sessions_user (user_id),
    KEY idx_sessions_expires (expires_at),
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "My files": PDFs saved by a user (merged, split, signed, filled in, ...).
-- The bytes live in the database so every replica can serve every file.
-- Needs max_allowed_packet above the largest file (see compose.scale.yaml).
CREATE TABLE documents (
    id         VARCHAR(36)  NOT NULL PRIMARY KEY,
    owner_id   VARCHAR(36)  NOT NULL,
    name       VARCHAR(255) NOT NULL,
    size       BIGINT       NOT NULL,
    pages      INT          NOT NULL DEFAULT 0,
    sha256     VARCHAR(64)  NOT NULL,
    content    LONGBLOB     NOT NULL,
    created_at BIGINT       NOT NULL,
    updated_at BIGINT       NOT NULL,
    KEY idx_documents_owner (owner_id, updated_at),
    CONSTRAINT fk_documents_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
