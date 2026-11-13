-- Schema and seed data for the support-triage demo. All data is fictional.

CREATE TABLE customers (
  id          SERIAL PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL CHECK (plan IN ('free', 'pro', 'enterprise')),
  country     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id           SERIAL PRIMARY KEY,
  customer_id  INT NOT NULL REFERENCES customers(id),
  product      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('processing', 'shipped', 'delivered', 'cancelled', 'refunded')),
  amount_usd   NUMERIC(10, 2) NOT NULL,
  ordered_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_customer_idx ON orders(customer_id);

CREATE TABLE kb_articles (
  id     SERIAL PRIMARY KEY,
  title  TEXT NOT NULL,
  body   TEXT NOT NULL,
  tsv    TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED
);
CREATE INDEX kb_articles_tsv_idx ON kb_articles USING GIN (tsv);

CREATE TABLE tickets (
  id              TEXT PRIMARY KEY,
  customer_email  TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'triaged', 'escalated', 'failed')),
  category        TEXT,
  priority        TEXT,
  sentiment       TEXT,
  summary         TEXT,
  suggested_reply TEXT,
  needs_human     BOOLEAN,
  confidence      NUMERIC(3, 2),
  attempts        INT,
  crm_case_id     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per LLM attempt, so latency, validity and cost can be monitored.
CREATE TABLE llm_runs (
  id                 SERIAL PRIMARY KEY,
  ticket_id          TEXT NOT NULL REFERENCES tickets(id),
  model              TEXT NOT NULL,
  attempt            INT NOT NULL,
  latency_ms         INT NOT NULL,
  valid              BOOLEAN NOT NULL,
  validation_errors  TEXT,
  est_prompt_tokens  INT,
  est_output_tokens  INT,
  est_cost_usd       NUMERIC(10, 6),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Workflow failures captured by the error workflow.
CREATE TABLE workflow_errors (
  id             SERIAL PRIMARY KEY,
  workflow_name  TEXT,
  execution_id   TEXT,
  node_name      TEXT,
  message        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO customers (email, name, plan, country) VALUES
  ('amina.khan@example.com',  'Amina Khan',  'pro',        'PK'),
  ('luca.bianchi@example.com','Luca Bianchi','free',       'IT'),
  ('priya.nair@example.com',  'Priya Nair',  'enterprise', 'IN'),
  ('omar.saeed@example.com',  'Omar Saeed',  'pro',        'AE');

INSERT INTO orders (customer_id, product, status, amount_usd, ordered_at) VALUES
  (1, 'Classroom Display 65"',        'shipped',    1899.00, now() - interval '6 days'),
  (1, 'Wall Mount Kit',               'delivered',    79.00, now() - interval '30 days'),
  (2, 'Classroom Display 55"',        'processing', 1399.00, now() - interval '1 day'),
  (3, 'Classroom Display 75" x 10',   'delivered', 24500.00, now() - interval '45 days'),
  (3, 'Extended Warranty (3 years)',  'refunded',   1200.00, now() - interval '20 days'),
  (4, 'Classroom Display 65"',        'cancelled',  1899.00, now() - interval '9 days');

INSERT INTO kb_articles (title, body) VALUES
  ('Refund policy',
   'Refunds are available within 30 days of delivery for unused products. Cancelled orders are refunded to the original payment method within 5 to 7 business days. Extended warranties can be refunded within 60 days of purchase.'),
  ('Shipping times and tracking',
   'Standard shipping takes 5 to 8 business days. Once an order has shipped you receive a tracking link by email. Orders in processing status have not left the warehouse yet and usually ship within 2 business days.'),
  ('Display will not turn on',
   'If the display shows no picture, check the power cable and the power switch on the back panel, then hold the power button for 10 seconds to reset. If the status light stays red, contact support with the serial number for a replacement.'),
  ('Resetting your account password',
   'Use the Forgot password link on the sign-in page. The reset email is valid for 30 minutes. If you do not receive it, check your spam folder or ask support to verify your email address.'),
  ('Enterprise onboarding',
   'Enterprise customers get a dedicated onboarding manager, bulk device enrolment and single sign-on setup. Contact your account manager to schedule a session.');
