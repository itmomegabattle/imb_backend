# Supabase setup for Megabattle profiles

## 1. Create project

Create a Supabase project and copy:

- Project URL
- anon public key

Create local `.env` from `.env.example`:

```bash
cp .env.example .env
```

Fill:

```env
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Restart `npm run dev` after changing env vars.

## 2. Auth settings for current MVP

Current MVP uses ISU number + password. Internally the app converts ISU to a
synthetic Supabase email:

```txt
123456@isu.megabattle.ru
```

In Supabase Dashboard:

- Authentication → Providers → Email: enabled
- Authentication → Sign In / Providers: email/password enabled
- Email confirmation: disabled for this MVP

Later this auth layer can be replaced with ITMO ID while keeping `profiles`,
`nfc_tags`, and `friendships`.

## 3. Database schema

Run `schema.sql` in Supabase SQL editor.

It creates:

- `profiles`
- `nfc_tags`
- `friendships`
- `profile_views`
- `project_events`
- `team_members`
- `partners`
- `participant_stories`
- `project_passwords`
- `admin_audit_logs`
- public storage buckets
- RLS policies
- admin-ready `profiles.is_admin`

## 4. Content seed

Run `seed-content.sql` in Supabase SQL editor after `schema.sql`.

It imports current JSON content into database tables:

- events;
- team members;
- participant stories;
- partners.

Image fields initially store existing public site paths, for example:

```txt
/images/people/optimized/member-0-small.webp
/images/partners/double.png
/images/events/event1.jpg
```

## 5. Move images to Supabase Storage

SQL cannot upload binary files to Supabase Storage. Use the local migration script.

Add to `.env.local`:

```env
SUPABASE_URL=https://qrvckblzecdtyyoybwtv.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

Get `SUPABASE_SERVICE_ROLE_KEY` in Supabase:

`Project Settings → API → service_role key`

Important: never add the service role key to Vercel or frontend code. Keep it local only.

Run:

```bash
npm run migrate:images
```

The script uploads files from `public/images` into Supabase Storage and updates:

- `project_events.image_url`
- `team_members.small_image_url`
- `team_members.big_image_url`
- `partners.logo_url`
- `participant_stories.image_url`

Buckets:

- `event-images` — events
- `team-images` — team members
- `content-images` — partners and stories

## 6. NFC URL format

Use path-based URLs:

```txt
https://your-domain.ru/nfc/<tag-code>
```

For local testing:

```txt
http://127.0.0.1:5173/nfc/test-keychain-001
```

One profile can claim many NFC tags.
