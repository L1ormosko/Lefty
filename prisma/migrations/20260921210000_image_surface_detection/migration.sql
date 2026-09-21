-- Record where a sign's marked face came from, and how sure we are of it.
--
-- Until now the face was marked by an admin clicking four corners, so there
-- was exactly one provenance and nothing to record. Detection adds a second
-- one, and the two cannot be shown on the same terms: a person who looked at
-- the photograph is trusted outright, a model's answer is shown only when it
-- is confident and the shape agrees with the declared dimensions.
--
-- surfaceCheckedAt is separate from surfaceQuad on purpose. "Nobody has
-- looked at this photo yet" and "we looked and found no face" are different
-- states needing different remedies, and a null quad alone cannot tell them
-- apart - nor could the backfill script tell which photos it had already
-- asked about.
--
-- Additive and safe against existing data: three nullable columns, no
-- backfill. Rows written before this migration keep a null source, and
-- lib/surface-confidence.ts treats a quad with no source as neither an
-- admin's nor a model's - it is not shown. The only such rows are the demo
-- seed's, which are recreated on the next deploy anyway.
ALTER TABLE "MediaAssetImage" ADD COLUMN "surfaceSource" TEXT;
ALTER TABLE "MediaAssetImage" ADD COLUMN "surfaceConfidence" DOUBLE PRECISION;
ALTER TABLE "MediaAssetImage" ADD COLUMN "surfaceCheckedAt" TIMESTAMP(3);
