CREATE TABLE "evaluation_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "evaluation_kind" NOT NULL,
	"min_score" double precision,
	"max_score" double precision,
	"labels" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_criteria_scale_ck" CHECK ("evaluation_criteria"."min_score" IS NULL OR "evaluation_criteria"."max_score" IS NULL OR "evaluation_criteria"."min_score" < "evaluation_criteria"."max_score")
);
--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', name), 'A') || jsonb_to_tsvector('simple', coalesce(input, 'null'::jsonb), '["string"]') || jsonb_to_tsvector('simple', coalesce(output, 'null'::jsonb), '["string"]')) STORED;--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "input_hash" text GENERATED ALWAYS AS (CASE WHEN input IS NULL THEN NULL ELSE md5(input::text) END) STORED;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', name), 'A') || jsonb_to_tsvector('simple', coalesce(input, 'null'::jsonb), '["string"]') || jsonb_to_tsvector('simple', coalesce(output, 'null'::jsonb), '["string"]')) STORED;--> statement-breakpoint
ALTER TABLE "evaluation_criteria" ADD CONSTRAINT "evaluation_criteria_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_criteria_project_name_uq" ON "evaluation_criteria" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "spans_search_idx" ON "spans" USING gin ("search");--> statement-breakpoint
CREATE INDEX "spans_project_input_hash_idx" ON "spans" USING btree ("project_id","input_hash") WHERE "spans"."kind" = 'llm';--> statement-breakpoint
CREATE INDEX "traces_search_idx" ON "traces" USING gin ("search");