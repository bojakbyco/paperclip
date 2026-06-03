ALTER TABLE "projects" ADD COLUMN "icon" text;--> statement-breakpoint
-- One-time bulk reset of all existing projects to neutral gray (PAP-68 board
-- decision #1). Intentionally discards current per-project colors so the new
-- icon-led project identity starts from a clean, neutral baseline.
UPDATE "projects" SET "color" = NULL;
