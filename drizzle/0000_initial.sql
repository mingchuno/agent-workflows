-- Bootstrap also adopts the identical pre-Drizzle schema without replacing data.
CREATE SCHEMA IF NOT EXISTS "agent_workflows";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_workflows"."commands" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_workflows"."events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"run_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_workflows"."invocations" (
	"scope" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_workflows"."projects" (
	"scope" text NOT NULL,
	"id" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"blocked" text,
	CONSTRAINT "projects_pkey" PRIMARY KEY("scope","id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_workflows"."runs" (
	"scope" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"task_key" text NOT NULL,
	"attempt" integer NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "runs_scope_task_key_attempt_key" UNIQUE("scope","task_key","attempt")
);
