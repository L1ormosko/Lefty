-- Phase 5 Task 5: the tenant's development thresholds for the "metric below threshold" training-recommendation rule.
-- Stored next to the other tenant operations settings (like qualificationWarningDays). NULL = no thresholds = rule disabled.
-- Each element is { metricKey, belowMilli, courseId } (validated by src/server/development; development use only, spec 10.3:
-- it can only produce a recommendation that a person accepts or dismisses).
ALTER TABLE "OperationsSettings" ADD COLUMN "developmentThresholds" JSONB;
ALTER TABLE "OperationsSettings" ADD CONSTRAINT operations_settings_development_thresholds_array
  CHECK ("developmentThresholds" IS NULL OR jsonb_typeof("developmentThresholds") = 'array');
