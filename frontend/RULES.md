<!-- ═════════ RULE #1 — READ THIS BEFORE ANYTHING ELSE ═════════ -->
# 🛑 NO GUESSING. NO THEORIZING. NO HALLUCINATING.

**Every claim is VERIFIED, or the word HYPOTHESIS is said out loud. No exceptions.**

- **VERIFIED** = I ran the query · read the file · measured it · asked Jeff — and I can show the receipt.
- Reading code and reasoning about it is **NOT** verification. Neither is *"it would explain the symptom."*
- **Never** state a root cause, a fix, or a conclusion I have not tested. Not even a likely-sounding one.
- **Check the instrumentation that ALREADY EXISTS** before inventing an explanation. It usually answers it.
- Separate cleanly: *what the data shows* vs *what I don't know*. Put the unknowns in writing.
- **"I don't know — here is the ONE check that would settle it"** is a GOOD answer.
  A confident wrong answer costs a day and burns trust.

> Jeff, 2026-08-21, in caps: **"ABSOLUTLEY STOP GUESSING, NO THEORYIZING, NO HALLUCENATIONS."**
> Trigger: I declared `ADVANCE_THRESHOLD_M = 25` the root cause of a stuck step index — from a code read alone,
> presented as a finding. The `turn=` breadcrumb, **already in the logs**, refuted it in a single query.
> The instrumentation existed. I guessed instead of reading it. Then I did it again with the timezone.
<!-- ═════════ END RULE #1 ═════════ -->

# Standing rules

The single consolidated list. `CLAUDE.md` holds the architecture; `HANDOFF.md` holds current state;
this file holds **how to work**. Every rule here was written after it was broken and cost something.

---

## 1 · Truth

**Rule #1 above outranks everything else in this repo.** It is repeated at the top of every `.md`
by deliberate policy (`03f02fc`), so it cannot be skipped no matter which document gets opened first.

**Don't state absence as fact.** *"I can't find it"* is **not** *"it doesn't exist."* Say which one
it is, list what you actually checked, then ask. Cost three wrong answers in one session (2026-08-03).

**Research before answering "is there anything better?"** The connected tool list is not the market.
A "no" about the outside world needs outside-world evidence. Jeff found the winning 3D vendor himself
after being told "no" twice.

**Test a vendor's real limit before telling Jeff what it can do.** 2026-08-21: I told him 3D services
accepted 8 photos, from a UI screenshot instead of a test run. **Tripo takes 4**, and its Multi-view
mode wants them ORTHOGONAL — front / left / right / back, straight-on, not three-quarter. A UI slot
existing is not a run completing. 2026-08-23 repeat of the same mistake: I padded the in-app capture
to 8 shots on the theory a future vendor might read more, and Jeff caught it — **build for the input
shape the shipping pipeline actually consumes.** See `HANDOFF-3D.md`.

**The 3D vendor is Tripo, and that question is CLOSED.** Jeff, 2026-08-23: *"we are working with
Tripo now."* Do not benchmark alternatives, re-open a comparison, or suggest another modeler unless
he asks.

**Other agents can be wrong.** Subagent and review output is evidence, not verdict. Re-check
load-bearing claims yourself.

---

## 2 · Talking to Jeff

**Bullets, not paragraphs.** *"i dont need to see massive paragraphs... bullet points and straight to
the point."* Answer first, cut the mechanism, no option menus — pick the default and say so.
**A correct answer he can't parse is a failed answer.**

**Don't open replies to Jeff with "Claude here."** That prefix is for testers only (see §6).

**Flag what you skipped.** If part of a task is blocked, finish everything else in full and say
explicitly what was left out and why. Scaling the work down is his call, not yours.

---

## 3 · Engineering

**FOUR SURFACES, always.** Every fix is reasoned about on **iOS phone, CarPlay, Android phone,
Android Auto**. *"Android doesn't do this"* is not an answer. Anything living in `map.tsx` is
missing from Android Auto **by construction** — check it every time.

**Check the RUNNING build before debugging.** When a shipped fix "doesn't work", confirm **which
bundle is actually running first** — read the map pill. `update_id` / `launch_kind` describe native
*intent*, not the JS that is executing.

**Simulate before asking.** Verify locally before asking Jeff for a photo, a drive, or a paid build.
Say plainly what is VERIFIED vs HYPOTHESIS.

**Grep the other writers before touching shared state.**

**Every constant carries its measurement.** A number with no recorded justification is a future bug.

**Run the adversarial review BEFORE shipping, not after.** On 2026-08-21 this caught three real
defects in `resetAppData` — a `DevSettings.reload` that no-ops outside `__DEV__`, an unawaited
telemetry receipt, and a missing nav/head-unit gate — all before they reached a tester.

**Instrument absence-interpreted rows with `logEventReliable`.** Plain `logEvent` **drops rows
published before the Supabase client exists**, so an app-root breadcrumb can vanish silently and
"no row" will be misread as "the code never ran."

**Location privacy is ONE gate.** Any position leaving the device MUST go through
`locationPrivacy.ts` as `share.lat/lng` — never raw `coords.*`.

**Regenerate patches with `--exclude 'android/build/'`:**
```bash
npx patch-package react-native-carplay --exclude 'android/build/'
```
A stale Gradle tree inside `node_modules` otherwise sweeps in 342 files of `.dex`/`.bin` artifacts
and **silently drops every real diff**, including the entire Android Auto port. Deleting the
directory is not enough — patch-package's pristine reference still carries it. Verify afterwards:
```bash
grep -ac '^diff --git' patches/<name>.patch
```

---

## 4 · Shipping

**ONE nav change per real drive.** After 2026-07-31, eleven OTAs in a single day made the app
*worse*. Every symptom gets its **own** verdict; do not bundle nav behaviour changes.

**`yarn typecheck` must pass clean before every publish.** Required gate. Never publish on a
failing or skipped typecheck.

**Publish to the channel the INSTALLED build listens to — verify, don't assume.**
Run `eas build:list` and read the build's `Channel`, then publish to *that* branch.
The current builds listen to **`mapbox-migration`**. Publishing to `preview` does **not** reach them
— that silently ate three updates on 2026-07-05.

**iOS and Android must stay on the SAME `runtimeVersion`.** A runtime bump only "takes" for the
platform you actually rebuild, so building one platform strands the other from every later OTA.
On 2026-07-06 build 62 bumped 1.13.2 → 1.14.0 for **iOS only**; Android missed six OTAs.
**Whenever you bump `runtimeVersion`, queue BOTH platform builds in the same batch, and verify
parity before every OTA.**

Only bump `runtimeVersion` for a **native** change. Bumping it for JS-only work cuts existing
testers off from OTAs; forgetting to bump after a native change pushes JS an old binary can't run.

**The RED PILL is the one and only OTA pickup instruction.** Tell testers: open the app, wait a few
seconds on the map, tap the red **"Update ready — tap to install"** pill under the search bar.
Never *"Settings → Software Update"* (that row was removed, and it compared the server to what was
*downloaded*, not what was *running*). Never *"cold-start twice."* Two competing instructions
confused testers — Jeff's call, 2026-07-25.

**Always provide an APK + QR** for every Android build.
🚨 But **Android Auto cannot be tested from a sideloaded APK** — it must go to Play internal testing.

---

## 5 · Money and permission

- **STOP for explicit go-ahead before any paid `eas build`.** Batch scope first, and verify
  `yarn typecheck` passes, `yarn.lock` is consistent, and references resolve.
- **Never run `eas submit`** — TestFlight or production — without Jeff's explicit go-ahead.
- **Commit and push app changes to `mapbox-migration` without asking.**
- **Never stage `.env` or `.claude`.**
- API keys are never posted into chat.

---

## 6 · Testers

- Every tester-facing message (WhatsApp / Messages) opens with **"Claude here (Jeff's AI dev)"**.
  **Not** in the chat with Jeff himself.
- **Mask the license plate** before any photo goes to a third-party service. Pure black, plate-tight.
- Query telemetry **by name** — rows carry `handle`. `Settings → Support → Reset app data` is the
  one-tap fresh-install for a tester whose state has gone bad.

---

## 7 · Design locks

These are settled. Do not relitigate them without Jeff reopening them.

- **CarPlay must match the phone.** Same information, same decisions.
- **No static 2D map on CarPlay. Ever.**
- **The green arrow design is LOCKED.**
- **No social post without an image** — branded card, sized per platform (16:9 for X/FB/LI,
  **4:5 for Instagram**).
- **Always preview socials before sending** — a *rendered* mockup of every platform and its card,
  never the draft file. A dry run is not a preview. Publishing needs its own explicit go-ahead.
- **Green means yours. Metal means a tier.** GOLD = Ultra Premium, SILVER = Premium, and the
  **Hairpin H is the lock** — a silver H on Premium, a gold H on Ultra. A screen is one metal all
  the way through; a gold page has no green accents left on it. Never hardcode the metal next to a
  feature gate — derive it with `useFeatureTier(feature)`. Every tiered page carries a
  `<TierTitle>` saying which tier it is, because colour alone is not the fact. Values: **`DESIGN.md`**.
