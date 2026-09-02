-- 20260902001000_launch_caps.sql — pipeline_flags sized for the GRC club launch.
--
-- Jeff, 2026-09-02: Ultra ($14.99) includes two scans; "ultra users don't get bound by
-- credit amounts or by the scans being really slow". 170 members × 2 scans = 340 cars =
-- 17,000 credits = $170 total. The training-wheels daily cap (300 = 6 cars/day) would
-- have parked member #7 until the next day — with no error, just waiting.
--
--   daily_credit_cap 6000  = 100 cars per rolling 24 h, $60/day worst case (the
--                            60-credit per-job ceiling is what the guards reserve)
--   per_user_cap     2     = the two included scans (identity binding is part 2:
--                            server-issued scan slots, see register-scan)
--   min_balance      300   = the worker stops BUYING when the Tripo balance would drop
--                            below 300 after a car; with no self-disable (worker v3)
--                            a top-up resumes rendering with no human step.
--
-- NOT applied at write time. Apply with the v3 deploy (switch off → one supervised
-- run → on). Idempotent.
update public.pipeline_flags
   set daily_credit_cap = 6000,
       per_user_cap     = 2,
       min_balance      = 300,
       updated_at       = now()
 where id = 1;
