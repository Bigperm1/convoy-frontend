-- car-scans — the private, write-only bucket behind Garage Scan (src/carScan.ts).
--
-- WHY STORAGE AND NOT THE BACKEND
-- The existing image-upload path (hub.tsx pickLogo/pickBanner -> POST /communities
-- with logo_b64) stores base64 IN THE DATABASE ROW. That is fine for a 40 KB club
-- logo and completely unworkable for eight full-resolution car photos, which run
-- 16-32 MB per scan and are deliberately NOT downscaled — resolution is the whole
-- point of the capture.
--
-- WHY ANON INSERT IS SAFE HERE
-- Same shape as crash_reports: the shipped anon key may ADD rows and can never
-- read, list, overwrite or delete them. There is no SELECT/UPDATE/DELETE policy,
-- so a leaked anon key buys an attacker the ability to upload JPEGs into a bucket
-- nobody can read back — not the ability to see a single tester's photos. Scans
-- are pulled down from the workstation with the service-role key.
--
-- APPLIED 2026-08-23 to project pgtbjiszjglznjagolse, then probed with the real
-- shipped anon key. Measured, in order: upload JPEG 200 · read back 400 ·
-- public URL without a key 400 · list [] · text/plain 415 invalid_mime_type ·
-- delete 400. Write-only, exactly as intended.
--
-- INSERT-ONLY MEANS NO UPSERT. Overwriting an existing path is an UPDATE, which
-- anon does not have: `x-upsert: true` on a path already in the bucket returns
-- 403 "new row violates row-level security policy". src/carScan.ts therefore
-- uploads with upsert:false and treats the resulting 409 as success. If you ever
-- grant UPDATE here, you also let one client overwrite another's photos.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'car-scans',
  'car-scans',
  false,                                        -- private: no public read URL
  12582912,                                     -- 12 MB/file; a 12 MP JPEG lands ~2-4 MB
  array['image/jpeg', 'application/json']       -- photos + the per-scan manifest
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Insert-only. Deliberately no SELECT/UPDATE/DELETE policy for anon.
drop policy if exists "car_scans_anon_insert" on storage.objects;
create policy "car_scans_anon_insert"
  on storage.objects
  for insert
  to anon, authenticated
  with check (bucket_id = 'car-scans');
