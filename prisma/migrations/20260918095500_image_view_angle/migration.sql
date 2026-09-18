-- Where the camera stood when a photo was taken, so several angles of one sign
-- can be ordered into a turntable. Additive and nullable: every existing photo
-- keeps its upload order and is labelled as having no stated angle.
ALTER TABLE "MediaAssetImage" ADD COLUMN "viewAngleDeg" INTEGER;
