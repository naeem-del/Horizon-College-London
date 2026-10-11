# Horizon College London — website, student portal and LMS

A complete Node.js replacement for the WordPress site: public website, course catalogue with awarding bodies,
enrolment form, student portal (lessons, progress, evidence uploads, assessor feedback) and an admin area.

Built with Express and EJS templates. Data lives in Supabase (Postgres database and file storage), and the site
is deployed on Vercel.

## 1. Run it on your computer

You need Node.js 22 (https://nodejs.org — the LTS version is fine) and a Supabase project (https://supabase.com).
Use a separate Supabase project for development, so testing never touches live data.

On Windows PowerShell, if `npm` says "running scripts is disabled", run this once:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (or type `npm.cmd` instead of `npm`).

```bash
cd Horizon_College_WebSite_LMS
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

Fill in `.env`: `DATABASE_URL` (Supabase → Connect → Transaction pooler, port 6543, with your database password),
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API), a long random `SESSION_SECRET`, and the
first admin's `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Then set up the project once:

```bash
npm run migrate             # creates the tables (safe to run again: only new files in supabase/migrations run)
npm run seed                # first admin, a demo learner and the starter courses (only on an empty database)
npm run setup-storage       # creates the "media" (public) and "private" storage buckets
npm run dev                 # restarts automatically when you edit files
```

Open http://localhost:3000

| Account        | Email                              | Password                   |
|----------------|------------------------------------|----------------------------|
| Admin          | your `ADMIN_EMAIL`                 | your `ADMIN_PASSWORD`      |
| Demo student   | student@example.com                | Student123!                |

Delete the demo student (Admin → Learners) before real learners use the site.

## 2. What's included

**Public website** — home page, course list with search and filters (awarding body, level), course pages,
awarding body pages, enrolment form (name, date of birth, postcode, email, course — emailed to
info@horizoncollegelondon.com), contact form.

**Student portal** (`/portal`) — my courses with progress bars, course player with module sidebar,
lessons with video (YouTube/Vimeo), downloadable resources and SCORM 1.2/2004 packages (played in the lesson,
progress saved and resumed, auto-completed on finish/pass, scores shown on the learner's admin page), evidence tasks where learners upload files,
assessor feedback, my details and password change.

**Admin** (`/admin`)
- Dashboard with things needing attention
- Courses: add/edit, cover image, publish/draft, feature on home page
- Course content builder: modules → lessons and evidence tasks, reorder modules
- Awarding bodies with logos
- Enquiries from the website, with one-click "Enrol learner" (creates the account and opens the course)
- Enrolments: confirm pending, decline, complete
- Learners & staff: create accounts, enrol on courses, change roles
- Evidence review: download, feedback, accept or ask for resubmission

**Roles**: `admin` (everything), `tutor` (dashboard, learners, evidence review), `student` (portal).

**Security basics**: hashed passwords (bcrypt), CSRF protection on every form, login throttling,
private evidence files (only the learner and staff can download), upload type/size limits.

## 3. Where things are

```
server.js              app setup (exports the app; listens on a port only when run directly)
api/index.js           Vercel entry point; vercel.json routes every non-static request to it
db.js                  Postgres connection and query helpers (db.get / db.all / db.run / db.tx)
supabase/migrations/   the database tables; add a new numbered .sql file to change them, then npm run migrate
storage.js             Supabase Storage: upload rules, signed upload and download links
scorm.js               SCORM manifest reading, signed package addresses, learner status
routes/public.js       website pages, enrolment and contact forms
routes/auth.js         log in, register, password links, log out
routes/portal.js       student portal / LMS
routes/admin.js        admin area
routes/scorm-content.js  serves SCORM package files to lessons from our own domain
views/                 page templates (EJS = HTML with <%= %> tags)
public/                CSS, images and browser scripts (served by Vercel's CDN)
public/js/direct-upload.js   uploads files straight from the browser to storage
public/js/scorm-upload.js    unzips SCORM packages in the browser and uploads their files
scripts/               migrate, seed, setup-storage, import-wordpress
```

**Your logo**: the header uses a drawn horizon mark in `views/partials/mark.ejs`. To use your real logo,
put it at `public/img/logo.png` and replace the contents of `mark.ejs` with
`<img class="brand-mark" src="/img/logo.png" alt="">`.

## 4. Moving from WordPress

Elementor, Tutor LMS and WooCommerce are WordPress (PHP) plugins, so they can't run inside a Node app —
this project replaces them. Your *content* comes across:

1. **Courses** — run `node scripts/import-wordpress.js https://horizoncollegelondon.com`. They arrive as
   drafts; add level, awarding body and duration in Admin, then publish. If WordPress returns 404, copy
   the course text across by hand (three courses is quick) or export via WordPress Tools → Export.
2. **Images** — download from WordPress Media Library and upload in the course / awarding body forms.
3. **Existing learners** — WordPress passwords can't be copied. Create each learner in Admin → Learners
   (they get an email link to choose a password) or ask them to register with the same email.
4. **Keep the WordPress site live** until the new one is tested, then point the domain at the new server.

## 5. Putting it live (Vercel + Supabase)

Use a **separate Supabase project for the live site**, set up as in section 1 (`npm run migrate`, `npm run seed`,
`npm run setup-storage` with that project's values in `.env`).

1. Push the project to GitHub and import it in Vercel (Add New → Project). Framework preset: **Other**.
   Leave the Build Command and Output Directory overrides **off**: `vercel.json` sets everything, including the
   Dublin region (`dub1`, next to a Supabase project in eu-west-1; change it if your project is elsewhere).
2. Add the environment variables (Project → Settings → Environment Variables): `DATABASE_URL`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `SITE_URL` (the live address, no trailing slash), `SITE_NAME`,
   `NOTIFY_EMAIL` and the `SMTP_*` / `MAIL_FROM` settings. Mark the secrets as sensitive. Don't set `PORT` or
   `NODE_ENV`; Vercel sets them.
3. Deploy, then point your domain at Vercel (Project → Settings → Domains). HTTPS is automatic.

Plans: Vercel's free Hobby plan is for non-commercial use, so a college site needs **Vercel Pro**. Supabase Free
limits each file to 50 MB, pauses projects after a week without activity and has no point-in-time restore, so a live
LMS should be on **Supabase Pro** (then raise `MAX_VIDEO_MB` / `MAX_FILE_MB` and run `npm run setup-storage` again).

**Email**: fill in the SMTP settings (Hostinger: `smtp.hostinger.com`, port 465). Without them, emails are written to
the log instead of sent, and the admin area shows set-password links for you to pass on.

**Backups**: Supabase Pro backs up the database daily. Files in Storage are **not** part of those backups: copy the
`media` and `private` buckets regularly (for example with the Supabase CLI), or keep your own copy of course materials.

**Housekeeping**: expired sessions, password links and login-attempt counters are cleared every 15 minutes by a
database job (`supabase/migrations/0002_cleanup_jobs.sql`).

## 6. Good next steps

- Online payments (Stripe Checkout) on the enrolment form, if you take fees online
- Password-reset emails
- Certificates (PDF) when a course is completed
- Quizzes / knowledge checks as a third lesson type
- Rich text editor for lesson content (e.g. Quill) instead of plain paragraphs
