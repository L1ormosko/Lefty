-- Let a signed-in customer ask to be let in, and let an admin be appointed.
--
-- VELTO charges nobody: Subscription.paidThrough is typed in by hand against
-- an invoice raised in real bookkeeping software. That left an account whose
-- trial had ended looking at "contact us" with nothing to click - the product
-- could describe its paywall but not take an order through it.
--
-- Entirely additive: a new table, new enum values, no existing column touched.

CREATE TYPE "AccessRequestStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

CREATE TABLE "AccessRequest" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "message"        TEXT,
  "status"         "AccessRequestStatus" NOT NULL DEFAULT 'OPEN',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"     TIMESTAMP(3),
  "resolvedById"   TEXT,
  "resolutionNote" TEXT,
  CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

-- The admin queue: open requests, oldest first.
CREATE INDEX "AccessRequest_status_createdAt_idx" ON "AccessRequest"("status", "createdAt");
-- "Has this person already asked?", on every render of the access page.
CREATE INDEX "AccessRequest_userId_status_idx" ON "AccessRequest"("userId", "status");

-- Deleting an account takes its requests with it: they are about that person
-- and have no meaning without them.
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The admin who handled it, on the other hand, may leave without erasing the
-- record that it was handled.
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TYPE "NotificationType" ADD VALUE 'ACCESS_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'ACCESS_GRANTED';

ALTER TYPE "AuditAction" ADD VALUE 'ACCESS_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'ACCESS_REQUEST_RESOLVED';
-- Appointing an admin is the most consequential change one account can make
-- to another, so it is audited like the rest.
ALTER TYPE "AuditAction" ADD VALUE 'USER_ROLE_CHANGED';
