create table if not exists commerce_driver_applications (
  id text primary key,
  user_id text not null,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists commerce_driver_applications_user_idx on commerce_driver_applications(user_id);
create index if not exists commerce_driver_applications_status_idx on commerce_driver_applications(status);
