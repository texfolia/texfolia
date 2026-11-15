BEGIN;
DO $$ BEGIN
  CREATE TYPE ai_run_status AS ENUM ('running', 'succeeded', 'failed', 'aborted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE ai_request_status AS ENUM ('pending', 'priced', 'reported', 'needs_review');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS ai_settings (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  default_model text,
  monthly_cap_nanos bigint NOT NULL DEFAULT 20000000000 CHECK (monthly_cap_nanos BETWEEN 0 AND 10000000000000)
);
CREATE TABLE IF NOT EXISTS ai_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, client_run_id text NOT NULL, project_id uuid NOT NULL,
  model text NOT NULL, stripe_customer_id text NOT NULL, stripe_subscription_id text NOT NULL,
  account_id text NOT NULL, gateway_id text NOT NULL, meter_event_name text NOT NULL,
  markup_percent integer NOT NULL DEFAULT 20, status ai_run_status NOT NULL DEFAULT 'running',
  input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_run_user_created_idx ON ai_run(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS ai_run_user_client_idx ON ai_run(user_id, client_run_id);
CREATE TABLE IF NOT EXISTS ai_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES ai_run(id),
  log_id text UNIQUE, model text NOT NULL, status ai_request_status NOT NULL DEFAULT 'pending',
  reserved_nanos bigint NOT NULL CHECK (reserved_nanos >= 0), base_cost_nanos bigint,
  charged_nanos bigint CHECK (charged_nanos >= 0), input_tokens integer, output_tokens integer,
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error text, created_at timestamptz NOT NULL DEFAULT now(), reported_at timestamptz,
  report_started_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_request_retry_idx ON ai_request(status, next_attempt_at);
COMMIT;
