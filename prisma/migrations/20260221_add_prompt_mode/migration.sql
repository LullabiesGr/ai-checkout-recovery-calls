alter table public."Settings"
add column if not exists "promptMode" text not null default 'append';

-- optional: basic guard (αν το θες)
-- alter table public."Settings"
-- add constraint "Settings_promptMode_check"
-- check ("promptMode" in ('append','replace','default_only'));