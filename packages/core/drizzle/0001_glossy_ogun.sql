CREATE TABLE "agent_workflows"."work_approvals" (
	"scope" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"work_item_id" text NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_workflows"."work_items" (
	"scope" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"source_key" text NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "work_items_scope_id_pk" PRIMARY KEY("scope","id"),
	CONSTRAINT "work_source_key" UNIQUE("scope","project_id","source_key")
);
