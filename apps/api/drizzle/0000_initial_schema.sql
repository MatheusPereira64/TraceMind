CREATE TYPE "public"."environment" AS ENUM('development', 'staging', 'production');--> statement-breakpoint
CREATE TYPE "public"."error_type" AS ENUM('provider_error', 'api_failure', 'rate_limit', 'timeout', 'invalid_response', 'tool_call_failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."evaluation_kind" AS ENUM('thumbs', 'numeric', 'categorical');--> statement-breakpoint
CREATE TYPE "public"."evaluation_source" AS ENUM('human', 'api', 'llm_judge');--> statement-breakpoint
CREATE TYPE "public"."organization_role" AS ENUM('owner', 'admin', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."span_kind" AS ENUM('llm', 'tool', 'retrieval', 'chain', 'embedding', 'custom');--> statement-breakpoint
CREATE TYPE "public"."trace_status" AS ENUM('running', 'success', 'error');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"environment" "environment" DEFAULT 'development' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"trace_id" uuid NOT NULL,
	"span_id" uuid,
	"criterion" text NOT NULL,
	"kind" "evaluation_kind" NOT NULL,
	"score" double precision,
	"label" text,
	"comment" text,
	"source" "evaluation_source" NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluations_thumbs_score_ck" CHECK ("evaluations"."kind" <> 'thumbs' OR "evaluations"."score" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE "ingestion_failures" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ingestion_failures_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid,
	"reason" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"input_price_per_million" numeric(14, 6) NOT NULL,
	"output_price_per_million" numeric(14, 6) NOT NULL,
	"cached_input_price_per_million" numeric(14, 6),
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_pricing_window_ck" CHECK ("model_pricing"."effective_to" IS NULL OR "model_pricing"."effective_to" > "model_pricing"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "organization_role" DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_members_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "projects_retention_days_ck" CHECK ("projects"."retention_days" BETWEEN 1 AND 3650)
);
--> statement-breakpoint
CREATE TABLE "spans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_span_id" uuid,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "span_kind" DEFAULT 'custom' NOT NULL,
	"status" "trace_status" DEFAULT 'running' NOT NULL,
	"provider_id" text,
	"model" text,
	"input" jsonb,
	"output" jsonb,
	"model_parameters" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "errors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"trace_id" uuid NOT NULL,
	"span_id" uuid,
	"type" "error_type" DEFAULT 'unknown' NOT NULL,
	"message" text NOT NULL,
	"code" text,
	"http_status" integer,
	"stack" text,
	"provider_id" text,
	"model" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_usage" (
	"span_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(18, 8),
	"reported_cost_usd" numeric(18, 8),
	"pricing_id" uuid,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "token_usage_non_negative_ck" CHECK ("token_usage"."input_tokens" >= 0 AND "token_usage"."output_tokens" >= 0 AND "token_usage"."cached_input_tokens" >= 0 AND "token_usage"."total_tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"environment" "environment" NOT NULL,
	"status" "trace_status" DEFAULT 'running' NOT NULL,
	"end_user_id" text,
	"session_id" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"is_simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_span_id_spans_id_fk" FOREIGN KEY ("span_id") REFERENCES "public"."spans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_failures" ADD CONSTRAINT "ingestion_failures_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_pricing" ADD CONSTRAINT "model_pricing_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spans" ADD CONSTRAINT "spans_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spans" ADD CONSTRAINT "spans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spans" ADD CONSTRAINT "spans_parent_span_id_spans_id_fk" FOREIGN KEY ("parent_span_id") REFERENCES "public"."spans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spans" ADD CONSTRAINT "spans_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "errors" ADD CONSTRAINT "errors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "errors" ADD CONSTRAINT "errors_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "errors" ADD CONSTRAINT "errors_span_id_spans_id_fk" FOREIGN KEY ("span_id") REFERENCES "public"."spans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "errors" ADD CONSTRAINT "errors_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_span_id_spans_id_fk" FOREIGN KEY ("span_id") REFERENCES "public"."spans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_pricing_id_model_pricing_id_fk" FOREIGN KEY ("pricing_id") REFERENCES "public"."model_pricing"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_project_idx" ON "api_keys" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "evaluations_project_created_idx" ON "evaluations" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "evaluations_trace_idx" ON "evaluations" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "ingestion_failures_project_created_idx" ON "ingestion_failures" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "model_pricing_provider_model_from_uq" ON "model_pricing" USING btree ("provider_id","model","effective_from");--> statement-breakpoint
CREATE INDEX "organization_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_slug_uq" ON "projects" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "spans_trace_external_uq" ON "spans" USING btree ("trace_id","external_id");--> statement-breakpoint
CREATE INDEX "spans_trace_idx" ON "spans" USING btree ("trace_id","started_at");--> statement-breakpoint
CREATE INDEX "spans_parent_idx" ON "spans" USING btree ("parent_span_id");--> statement-breakpoint
CREATE INDEX "spans_project_started_idx" ON "spans" USING btree ("project_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "spans_project_model_started_idx" ON "spans" USING btree ("project_id","model","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "errors_project_occurred_idx" ON "errors" USING btree ("project_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "errors_project_type_occurred_idx" ON "errors" USING btree ("project_id","type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "errors_trace_idx" ON "errors" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "token_usage_project_recorded_idx" ON "token_usage" USING btree ("project_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "traces_project_external_uq" ON "traces" USING btree ("project_id","external_id");--> statement-breakpoint
CREATE INDEX "traces_project_started_idx" ON "traces" USING btree ("project_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "traces_project_env_started_idx" ON "traces" USING btree ("project_id","environment","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "traces_session_idx" ON "traces" USING btree ("project_id","session_id");