create table if not exists commerce_vendors (
  id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists commerce_categories (
  id text primary key,
  vendor_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists commerce_products (
  id text primary key,
  vendor_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists commerce_products_vendor_idx on commerce_products(vendor_id);

create table if not exists commerce_orders (
  id text primary key,
  vendor_id text not null,
  customer_user_id text,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists commerce_orders_vendor_idx on commerce_orders(vendor_id);
create index if not exists commerce_orders_customer_user_idx on commerce_orders(customer_user_id);

create table if not exists commerce_payments (
  id text primary key,
  order_id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists commerce_payments_order_idx on commerce_payments(order_id);

create table if not exists commerce_ledger (
  id text primary key,
  vendor_id text not null,
  order_id text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists commerce_ledger_vendor_idx on commerce_ledger(vendor_id);

create table if not exists commerce_vendor_applications (
  id text primary key,
  status text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists commerce_vendor_applications_status_idx on commerce_vendor_applications(status);

create table if not exists commerce_webhook_events (
  event_id text primary key,
  created_at timestamptz not null default now()
);

create table if not exists commerce_payment_idempotency (
  idem_key text primary key,
  payment_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists commerce_payment_idempotency_created_at_idx
  on commerce_payment_idempotency(created_at);
