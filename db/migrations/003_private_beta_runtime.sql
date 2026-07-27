-- Durable runtime state required for a COD private beta.
-- JSONB payloads match the existing commerce_* table convention and allow
-- incremental schema evolution while application fields are still changing.

create table if not exists commerce_drivers (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists commerce_delivery_jobs (
  id text primary key,
  order_id text not null,
  driver_id text,
  status text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists commerce_delivery_jobs_order_idx
  on commerce_delivery_jobs(order_id);
create index if not exists commerce_delivery_jobs_driver_status_idx
  on commerce_delivery_jobs(driver_id, status);

create table if not exists commerce_driver_ledger (
  id text primary key,
  driver_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists commerce_driver_ledger_driver_idx
  on commerce_driver_ledger(driver_id);

create table if not exists commerce_support_conversations (
  id text primary key,
  user_id text not null unique,
  status text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists commerce_support_conversations_status_idx
  on commerce_support_conversations(status);

create table if not exists commerce_support_messages (
  id text primary key,
  conversation_id text not null references commerce_support_conversations(id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists commerce_support_messages_conversation_idx
  on commerce_support_messages(conversation_id, created_at);

create table if not exists commerce_payouts (
  id text primary key,
  vendor_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists commerce_payouts_vendor_idx
  on commerce_payouts(vendor_id, created_at);

create table if not exists commerce_vendor_payment_requests (
  id text primary key,
  vendor_id text not null,
  status text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists commerce_vendor_payment_requests_vendor_idx
  on commerce_vendor_payment_requests(vendor_id, status);
