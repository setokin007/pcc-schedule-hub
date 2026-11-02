# PCC Schedule Hub

The Polynesian Cultural Center's schedule of record: operating hours, activity and show times, transportation runs, seasons, special events and closures. Staff sign in with their @polynesia.com email; editors keep it accurate; every change is recorded and can be undone.

**Stack:** a static site on **Vercel** + **Supabase** (Postgres database, email sign-in, live updates). No server code to maintain.

---

## How access works

| Who | Can do |
|---|---|
| Not signed in | Nothing. The sign-in screen is all they see; the database refuses every request without a valid session. |
| **Viewer** (anyone with a @polynesia.com email who signs in) | See every view, print, export CSV. |
| **Editor** | Everything a Viewer can, plus change the schedule (Manage tab, Open/Close day, etc.). |
| **Admin** | Everything an Editor can, plus give or remove access and restore earlier versions (Admin page). |

**Sign-in:** staff enter their work email and type a 6-digit code that's emailed to them. A code is used instead of a clickable link because corporate mail scanners often "click" links in incoming mail to check them, which uses up one-time links before staff see them.

**Why it's safe to let any @polynesia.com address in:** receiving the code proves the person controls that mailbox; the domain check runs inside the database (not the browser); and new accounts can only *view*. When IT disables a mailbox, that person can no longer get codes.

**No silent overwrites:** each save says which version it was based on. If someone else saved in between, the save is refused, the editor sees "Someone else saved a change just now", and the latest schedule loads automatically.

**Full history:** every save is stored with who, when and a description (e.g. "Opened Nov 1, 2026 (Monday schedule)"). Admins can download or restore any version from the Admin page. Restores are recorded too.

---

## One-time setup (about 30 minutes)

### 1. Create the Supabase project

1. Go to <https://supabase.com>, sign in (create an org for PCC), **New project**. Pick the region closest to Hawaiʻi (a US West region). Save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste all of `supabase/migrations/20261101000000_schedule_hub.sql`, and **Run**.
3. New query again, paste `supabase/seed.sql`, **Run**. This loads the schedule exactly as it was in the claude.ai artifact on Nov 1, 2026.

### 2. Configure sign-in (Authentication settings)

1. **Authentication → Sign In / Providers → Email:** Email enabled. Keep **Allow new users to sign up** ON (the database limits sign-ups to @polynesia.com). Set **Email OTP expiration** to `600` seconds and OTP length to `6`.
2. **Authentication → Emails → SMTP Settings: set up custom SMTP. This is required.** Supabase's built-in mailer is for testing only (it sends only to your project's team members, a few emails per hour). Use any of: your Microsoft 365 mail relay, Resend, SendGrid, Postmark or Amazon SES. Use a sender like `schedule@polynesia.com`, and ask IT to add the provider's SPF/DKIM records and allow-list the sender so codes don't land in Quarantine.
3. **Authentication → Emails → Templates:** edit **Magic Link** *and* **Confirm signup** so they show the code instead of a link (first-time users get "Confirm signup", returning users get "Magic Link"):

   Subject: `Your PCC Schedule Hub sign-in code`

   ```html
   <h2>PCC Schedule Hub</h2>
   <p>Your sign-in code is:</p>
   <p style="font-size:28px;font-weight:700;letter-spacing:6px">{{ .Token }}</p>
   <p>It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.</p>
   ```
4. **Authentication → URL Configuration:** set **Site URL** to your Vercel address (you'll have it after step 3; come back and fill it in).
5. **Project Settings → API:** copy the **Project URL** and the **anon / publishable key** for the next step. (This key is meant to be public; access is enforced by the database rules. Never put the `service_role` / secret key in Vercel or in this code.)

### 3. Deploy to Vercel

1. Put this folder in a GitHub repository (private is fine).
2. In Vercel: **Add New → Project → Import** that repository. Framework preset: **Other**. The build settings come from `vercel.json`; leave them alone.
3. **Environment Variables** (Production and Preview):
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_ANON_KEY` = the anon / publishable key

   (If you connect Supabase through Vercel's Supabase integration instead, it sets equivalent variables automatically; the build accepts those names too.)
4. **Deploy.** The build fails on purpose with a clear message if either variable is missing.
5. Optional: **Settings → Domains** to add something like `schedule.polynesia.com`. Then update the Supabase **Site URL** to match.

### 4. Make yourself the first admin

1. Open the site and sign in with your @polynesia.com address. You'll be a Viewer.
2. In Supabase **SQL Editor**, run (with your address):
   ```sql
   update public.profiles set role = 'admin' where email = 'you@polynesia.com';
   ```
3. Reload the site. You'll see **Admin** in the top bar and "Manage users & history". From now on, grant access from the Admin page. Nobody needs the SQL editor again.

### 5. Before going live

- The imported schedule is still flagged as **sample data with placeholder times** (the banner says so). Have Operations correct the times in **Manage**, then choose **Manage → Data → Keep as real entries** to remove the notice. (**Clear sample data** there wipes everything for a blank start.)
- **Authentication → Rate Limits:** the default cap on emails sent per hour is low. Raise it before a group of staff signs in for the first time.
- Ask each editor to click **Add your name** in the top bar, so history shows names instead of email addresses.
- Supabase plan: on the **Free** plan, projects pause after a period of inactivity and there are no automated backups. For a system of record, use **Pro** (daily backups, no pausing) and consider the Point-in-Time Recovery add-on. Check current terms at <https://supabase.com/pricing>. The Admin page's **Download current schedule** gives you a manual backup at any time.

---

## Day-to-day

- **Edit:** sign in as an Editor and use the page as before (Manage tab, Open/Close this day, Edit times, etc.). Changes save immediately and appear for everyone within seconds.
- **Grant access:** Admin page → find the person (they must have signed in once) → choose Viewer / Editor / Admin. There must always be at least one Admin.
- **Undo a mistake:** Admin page → Schedule history → **Restore** on the version you want. Everyone sees it right away, and the restore itself can be undone the same way.
- **Someone left PCC:** IT disabling their mailbox stops new sign-ins. For immediate removal, set them to Viewer on the Admin page, or delete them in Supabase **Authentication → Users**.
- **Embed elsewhere:** the site can be framed only by itself (`frame-ancestors 'self'`). To embed it on another PCC site, add that origin to the `Content-Security-Policy` in `vercel.json`.

---

## What's in this repository

```
public/                     the website (served as-is by Vercel)
  index.html                the Schedule Hub page (from the claude.ai artifact, lightly adapted)
  hub-shim.js               connects the page to Supabase (data, roles, live updates, conflict checks)
  auth.js                   staff sign-in screen (email + 6-digit code), shared by every page
  admin.html                staff access and schedule history (admins only)
  logo.webp, favicon.svg, robots.txt
supabase/
  migrations/…_schedule_hub.sql   tables, sign-up domain rule, row-level security, save/restore functions
  seed.sql                  the schedule as exported from the artifact
scripts/build.mjs           build step: copies the Supabase library and writes public/config.js from env vars
tests/db.test.mjs           29 checks of the access rules against an embedded Postgres
vercel.json                 build settings and security headers (CSP, HSTS, noindex, no-cache for app files)
```

`public/config.js` and `public/vendor/` are generated by the build and not committed.

## Local development

```bash
npm install
cp .env.example .env        # fill in SUPABASE_URL and SUPABASE_ANON_KEY
npm run dev                 # builds, then serves http://localhost:3000
npm run test:db             # verifies the database access rules
```

Add `http://localhost:3000` to Supabase **Authentication → URL Configuration → Redirect URLs** if you test sign-in locally.

## Changing the rules

- **Allowed email domains:** edit the array in `public.is_allowed_email()` in the migration (and re-run that function in the SQL editor), and set `ALLOWED_EMAIL_DOMAINS` in Vercel so the sign-in screen's message matches.
- **Schema changes:** add a new file in `supabase/migrations/`, run it in the SQL editor, and extend `tests/db.test.mjs`.

## How the page talks to the database

The page was built as a claude.ai artifact, which reads and writes through `window.claude.use("db" | "user" | "downloads")`. `hub-shim.js` provides those same calls on top of Supabase, so the original page logic is untouched apart from five small edits (script tags, passing the change description into each save, the "someone else saved" message, a larger size limit, and the connection-error text).

| Page call | Backed by |
|---|---|
| `db.doc("schedule/main")` get / onSnapshot | `schedule_documents` (Supabase Realtime, plus a 60-second and on-focus refresh as a safety net) |
| `db.doc("schedule/main").set(data, {summary})` | `save_document()`: checks role and version, writes the new version and a history row in one transaction |
| `db.doc("schedule/log").get()` | latest 300 rows of `schedule_history` |
| `user.can("data.write")`, `user.id()`, `user.profiles(ids)` | the signed-in user's `profiles` row and role |
