create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  contact text not null check (char_length(contact) between 3 and 200),
  message text not null check (char_length(message) between 10 and 5000),
  attachment_path text,
  attachment_name text,
  attachment_mime text,
  status text not null default 'new' check (status in ('new', 'in_progress', 'resolved')),
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.support_requests enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('support-media', 'support-media', false, 20971520, array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
