-- Housekeeping every 15 minutes inside the database (a serverless app has no long-running timer):
-- expired login sessions, expired password links, and failed-login counters older than the 15-minute window.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;

SELECT cron.schedule('horizon-cleanup', '*/15 * * * *', $job$
  DELETE FROM public.sessions WHERE expires < (extract(epoch FROM now()) * 1000)::bigint;
  DELETE FROM public.password_tokens WHERE expires_at < (extract(epoch FROM now()) * 1000)::bigint;
  DELETE FROM public.login_attempts WHERE first_at < now() - interval '15 minutes';
$job$);
