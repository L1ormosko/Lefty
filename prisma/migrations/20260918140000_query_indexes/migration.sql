-- Indexes for the queries that actually run on every page load. Additive:
-- CREATE INDEX takes a brief lock on a table this size and changes no data.
CREATE INDEX "MediaAsset_ownerId_status_idx" ON "MediaAsset"("ownerId", "status");
CREATE INDEX "MediaAsset_ownerId_updatedAt_idx" ON "MediaAsset"("ownerId", "updatedAt");
CREATE INDEX "MediaAsset_status_city_idx" ON "MediaAsset"("status", "city");
CREATE INDEX "MediaAsset_status_isDemo_idx" ON "MediaAsset"("status", "isDemo");
CREATE INDEX "Booking_status_endDate_idx" ON "Booking"("status", "endDate");
