CREATE SCHEMA IF NOT EXISTS agent_workflows;
      CREATE TABLE IF NOT EXISTS agent_workflows.projects(scope text NOT NULL,id text NOT NULL,paused boolean NOT NULL DEFAULT false,blocked text,PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS agent_workflows.runs(scope text NOT NULL,id text PRIMARY KEY,task_key text NOT NULL,attempt integer NOT NULL,record jsonb NOT NULL,UNIQUE(scope,task_key,attempt));
      CREATE TABLE IF NOT EXISTS agent_workflows.events(sequence bigserial PRIMARY KEY,scope text NOT NULL,run_id text,kind text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS agent_workflows.invocations(scope text NOT NULL,id text PRIMARY KEY,run_id text NOT NULL,record jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_workflows.commands(id text PRIMARY KEY,scope text NOT NULL,kind text NOT NULL,target text NOT NULL,status text NOT NULL DEFAULT 'pending',error text,created_at timestamptz NOT NULL DEFAULT now());
