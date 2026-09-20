-- Mark seeded accounts as demo data explicitly.
--
-- The seed deletes and recreates its own rows on every deploy, and it found
-- them with `email ENDS WITH '@velto.dev'`. Company and MediaAsset already
-- carried an isDemo flag; User did not, so the email was standing in for one.
--
-- That is a live hazard rather than an untidiness: velto.dev is the product's
-- own domain and is not registered yet. The day it is, an address on it -
-- office@, noa@, support@ - belongs to a real person, and the next deploy
-- would delete that account together with everything cascading from it.
--
-- Additive and safe to run against existing data: the column defaults to
-- false, and the UPDATE below re-labels exactly the rows the old rule already
-- treated as demo, so nothing changes hands.
ALTER TABLE "User" ADD COLUMN "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- The accounts the previous seed would have deleted, now marked as what they
-- are. Anything else at that domain - there is nothing today - stays real.
UPDATE "User" SET "isDemo" = true WHERE "email" LIKE '%@velto.dev';
