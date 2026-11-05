ALTER TABLE "evaluations" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "redaction" jsonb DEFAULT '{"enabled":true,"maskEmails":true,"maskPhoneNumbers":false,"literals":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "parent_external_id" text;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "input" jsonb;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "output" jsonb;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "is_complete" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluations_project_external_uq" ON "evaluations" USING btree ("project_id","external_id") WHERE "evaluations"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "errors_span_uq" ON "errors" USING btree ("span_id") WHERE "errors"."span_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "errors_trace_level_uq" ON "errors" USING btree ("trace_id") WHERE "errors"."span_id" IS NULL;