# Horizon College London — website, student portal and LMS

A complete Node.js replacement for the WordPress site: public website, course catalogue with awarding bodies,
enrolment form, student portal (lessons, progress, evidence uploads, assessor feedback) and an admin area.

Built with Express and EJS templates. Data lives in Supabase (Postgres database and file storage); the app runs on
a VPS behind Nginx (see section 5).

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
deploy/                Nginx config for running on a VPS
api/index.js           Vercel entry point (only used if deploying to Vercel instead)
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
public/                CSS, images and browser scripts
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

## 5. Putting it live (VPS + Supabase)

The app runs on a VPS (any Ubuntu 24.04 server; 1 vCPU and 1–2 GB of RAM is plenty). The database and all uploaded
files stay in Supabase, so the server holds no data and can be rebuilt at any time. Choose a VPS in Europe
(London, Dublin or Frankfurt): every page makes several database queries, so being close to Supabase (Ireland) matters.

Use a **separate Supabase project for the live site**, set up as in section 1 (`npm run migrate`, `npm run seed`,
`npm run setup-storage` with that project's values in `.env`).

**1. Prepare the server** (as root, or with sudo):

```bash
apt update && apt upgrade -y
apt install -y nginx git unattended-upgrades          # unattended-upgrades installs security fixes automatically
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
npm install -g pm2
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable   # only SSH, HTTP and HTTPS are reachable
```

**2. Get the code and settings**:

```bash
git clone https://github.com/naeem-del/Horizon-College-London.git /var/www/horizon
cd /var/www/horizon
npm ci --omit=dev
cp .env.example .env && nano .env
```

In `.env` set `NODE_ENV=production` (secure login cookies; needs HTTPS, step 4), `PORT=3000`, `DB_POOL_MAX=10`,
`SITE_URL=https://horizoncollegelondon.com` and the Supabase, `SESSION_SECRET` and Resend values. Protect it with
`chmod 600 .env`.

**3. Start the app and keep it running** (PM2 restarts it after a crash or a reboot):

```bash
pm2 start npm --name horizon -- start
pm2 save && pm2 startup                 # run the command it prints, so the app starts on boot
pm2 install pm2-logrotate               # keeps the log files from filling the disk
```

**4. Nginx and HTTPS**: first point the domain at the server (below), then:

```bash
cp deploy/nginx-horizon.conf /etc/nginx/sites-available/horizon
ln -s /etc/nginx/sites-available/horizon /etc/nginx/sites-enabled/horizon && rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
apt install -y certbot python3-certbot-nginx
certbot --nginx -d horizoncollegelondon.com -d www.horizoncollegelondon.com   # free certificate, renews itself
```

**Pointing the domain**: the domain is registered at GoDaddy but its DNS is managed at **Hostinger** (hPanel → Domains
→ DNS Zone). There, change the `A` record for `@` to the VPS's IP address and make `www` an `A` record to the same IP
(replacing the current `CNAME` to Hostinger's CDN). Leave the Google Workspace `MX`, SPF and verification records
and the Resend records alone, and don't change the nameservers.

**Updating** after changes are pushed to GitHub:

```bash
cd /var/www/horizon && git pull && npm ci --omit=dev
npm run migrate                         # only if there are new files in supabase/migrations
pm2 reload horizon
```

**Logs**: `pm2 logs horizon` (add `--lines 200` for more). **Status**: `pm2 status`.

Plans: a live LMS should be on **Supabase Pro** (daily backups, files over 50 MB, no pausing after a quiet week); then
raise `MAX_VIDEO_MB` / `MAX_FILE_MB` and run `npm run setup-storage` again.

The project also still deploys to Vercel if ever needed (`api/index.js` and `vercel.json`): import the repository
with the Framework preset **Other**, add the same environment variables except `PORT`, `NODE_ENV` and `DB_POOL_MAX`,
and use Vercel Pro (the free Hobby plan is non-commercial only).

**Email** is sent through Resend (resend.com). In Resend, add the domain `horizoncollegelondon.com` (region Ireland)
and copy the DNS records it lists into the domain's DNS zone, which is at **Hostinger** (the domain is registered at
GoDaddy but uses Hostinger's nameservers). Resend's records sit on a `send.` subdomain and a `resend._domainkey`
key, so they don't affect the Google Workspace mailboxes: leave the existing `MX` and SPF records as they are. Then
create an API key and set `RESEND_API_KEY`. Without it, emails are written to the log instead of sent, and the
admin area shows set-password links for you to pass on. A DMARC record (`_dmarc` TXT:
`v=DMARC1; p=none; rua=mailto:info@horizoncollegelondon.com`) helps both Google and Resend mail reach inboxes.

**Backups**: Supabase Pro backs up the database daily, but files in Storage are **not** part of those backups.
`npm run backup-storage -- <folder>` copies both buckets into a folder, fetching only new or changed files on later
runs (deleted files are kept). Copy that folder off the server as well (to another machine or cloud storage).

**Housekeeping**: expired sessions, password links and login-attempt counters are cleared every 15 minutes by a
database job (`supabase/migrations/0002_cleanup_jobs.sql`). Files uploaded from forms that were never saved stay in
Storage until `npm run cleanup-uploads` removes them: it lists unused files older than 24 hours, and deletes them
only with `-- --delete`.

Run both every night on the VPS (`crontab -e` as the user that runs the app). The backup runs first, so anything
the clean-up removes has already been copied:

```
30 2 * * * cd /var/www/horizon && npm run -s backup-storage -- /var/backups/horizon-storage >> $HOME/horizon-backup.log 2>&1
0 3 * * * cd /var/www/horizon && npm run -s cleanup-uploads -- --delete >> $HOME/horizon-cleanup.log 2>&1
```

(Create the backup folder first: `sudo mkdir -p /var/backups/horizon-storage && sudo chown $USER /var/backups/horizon-storage`.)

## 6. Good next steps

- Online payments (Stripe Checkout) on the enrolment form, if you take fees online
- Certificates (PDF) when a course is completed
- Quizzes / knowledge checks as a third lesson type
- Rich text editor for lesson content (e.g. Quill) instead of plain paragraphs
