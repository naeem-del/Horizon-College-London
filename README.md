# Horizon College London — website, student portal and LMS

A complete Node.js replacement for the WordPress site: public website, course catalogue with awarding bodies,
enrolment form, student portal (lessons, progress, evidence uploads, assessor feedback) and an admin area.

Built with Express, EJS templates and Node's built-in SQLite (one file, no database server, nothing to compile).

## 1. Run it on your computer

You need Node.js 22.13 or newer (https://nodejs.org — the LTS version is fine). No Visual Studio or build tools needed.

On Windows PowerShell, if `npm` says "running scripts is disabled", run this once:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (or type `npm.cmd` instead of `npm`).

```bash
cd horizon-college
npm install
cp .env.example .env        # Windows: copy .env.example .env
npm run dev                 # restarts automatically when you edit files
```

Open http://localhost:3000

| Account        | Email                              | Password      |
|----------------|------------------------------------|---------------|
| Admin          | admin@horizoncollegelondon.com     | ChangeMe123!  |
| Demo student   | student@example.com                | Student123!   |

These are created the first time the database is made. Change the admin password in `.env` **before** the
first run on your live server, and delete the demo student in Admin → Learners & staff.

To start again from a clean database, stop the server and delete `data/college.db`.

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
server.js            app setup
db.js                database tables + first-run seed data (your Focus Awards courses)
routes/public.js     website pages, enrolment and contact forms
routes/auth.js       log in, register, log out
routes/portal.js     student portal / LMS
routes/admin.js      admin area
views/               page templates (EJS = HTML with <%= %> tags)
public/css/site.css  all website styling — colours are at the top
public/css/admin.css admin styling
uploads/             images, lesson files, SCORM packages, learner evidence
scorm.js             SCORM unzip + manifest reading; public/js/scorm-player.js is the in-browser SCORM API
scripts/import-wordpress.js   pulls courses from the old site
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
   (it gives a temporary password) or ask them to register with the same email.
4. **Keep the WordPress site live** until the new one is tested, then point the domain at the new server.

## 5. Putting it live

Node apps need a host that runs Node. With Hostinger that means a **VPS** plan, or a web hosting plan
whose hPanel offers Node.js apps — check your plan. On a VPS (Ubuntu):

```bash
# install Node 22 and PM2
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs nginx
sudo npm i -g pm2
# upload the project (git clone or SFTP), then:
cd horizon-college && npm install --omit=dev
cp .env.example .env && nano .env      # set NODE_ENV=production, SESSION_SECRET, ADMIN_*, SMTP_*
pm2 start npm --name horizon -- start && pm2 save && pm2 startup
```

Point Nginx at `http://127.0.0.1:3000` and add free HTTPS with `sudo certbot --nginx`.
(`NODE_ENV=production` makes login cookies HTTPS-only, so set up HTTPS first.)

**Email**: fill in the SMTP settings in `.env` (Hostinger: `smtp.hostinger.com`, port 465). Without them,
emails are printed in the server log instead of sent.

**Backups**: back up `data/college.db` and the `uploads/` folder daily — that's all your data.

## 6. Good next steps

- Online payments (Stripe Checkout) on the enrolment form, if you take fees online
- Password-reset emails
- Certificates (PDF) when a course is completed
- Quizzes / knowledge checks as a third lesson type
- Rich text editor for lesson content (e.g. Quill) instead of plain paragraphs
