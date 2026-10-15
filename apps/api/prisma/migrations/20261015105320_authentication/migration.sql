-- AlterTable
ALTER TABLE "users" ADD COLUMN     "password_hash" TEXT;

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (Prisma schema cannot express CHECK constraints).
-- ---------------------------------------------------------------------------

-- Only argon2id PHC strings are accepted; a plaintext or legacy hash can never be stored by mistake.
ALTER TABLE "users" ADD CONSTRAINT "users_password_hash_argon2id" CHECK ("password_hash" ~ '^\$argon2id\$');

-- SHA-256 digests are exactly 32 bytes.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_sha256" CHECK (octet_length("token_hash") = 32);
-- Both instants come from the application clock (see AuthService), so this compares like with like.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_expiry_after_creation" CHECK ("expires_at" > "created_at");
