# Convoy — TestFlight Build Checklist

Last updated: June 2025 (v1.0.1 / build 1)

This is the step-by-step playbook to get a working TestFlight build into your
friends' hands. Everything in code is already wired — these are the human-side
steps that **must be done outside this container**.

---

## 1. Pre-flight — Apple Developer Account

- [ ] Active **Apple Developer Program** membership ($99/yr)
- [ ] App Store Connect record created for **`com.convoy.app`**
  - App name: **Convoy**
  - Bundle ID: `com.convoy.app`
  - SKU: anything unique (e.g. `convoy-2025`)
  - Primary language: English (US)
- [ ] If you previously registered `app.convoy.driver`, **delete it** or rename — we changed the bundle id to match Firebase.
- [ ] Push Notifications capability **enabled** in App Store Connect → Capabilities (required for the Hail feature)
- [ ] Background Modes capability enabled (location, audio, fetch — already declared in `app.json`)

## 2. Pre-flight — Expo Account

- [ ] `npm install -g eas-cli` (latest)
- [ ] `eas login` with your Expo account
- [ ] `eas init` inside `/app/frontend` to link the project to your account (creates `extra.eas.projectId` in app.json)
- [ ] In **eas.json**, replace the 3 `REPLACE_WITH_YOUR_*` placeholders under `submit.production.ios` with your real Apple ID, ASC App ID, and Apple Team ID.

## 3. Pre-flight — Backend (Server-side)

- [ ] Set `SEED_DEMO_DATA=0` in the **production** backend environment to suppress the demo users (DemoDriver / AlexGT / SaraS2K) and the two seed communities.
- [ ] **Drop or migrate** any existing demo data from the production Mongo + Supabase. Locally:
  ```
  mongosh "$MONGO_URL" --eval 'db.users.deleteMany({email:{$in:["demo@revradar.app","alex@revradar.app","sara@revradar.app"]}})'
  mongosh "$MONGO_URL" --eval 'db.communities.deleteMany({name:{$in:["Bay Area Drivers","Mountain Pass Crew"]}})'
  ```
- [ ] Verify `OPENAI_API_KEY` has **billing credits** (TTS navigation voice will fall back to robotic `expo-speech` otherwise — not a build blocker, but a UX hit).
- [ ] Verify `EMERGENT_PUSH_KEY` will be injected by the deploy pipeline (it stays as `placeholder` in code — DO NOT commit a real key).
- [ ] Verify Supabase service-role key and Spotify client id are set in the **production** backend `.env`.

## 4. Pre-flight — Frontend (Client-side)

- [ ] Confirm `app.json` has the correct values (already done):
  - `version: "1.0.1"`
  - `ios.buildNumber: "1"`
  - `ios.bundleIdentifier: "com.convoy.app"`
  - `android.package: "com.convoy.app"`
  - `android.versionCode: 1`
  - `android.googleServicesFile: "./google-services.json"`
  - `plugins: [..., "expo-notifications"]`
- [ ] Confirm `google-services.json` is at `/app/frontend/google-services.json`
- [ ] **Do NOT** commit `google-services.json` to a public repo if you push to GitHub — it contains your Firebase API key.
- [ ] Verify the new app icon renders correctly: open `assets/images/icon.png` and `assets/images/brand-mark.png` — these are the splash/icon assets.

## 5. Build (Local — runs on EAS Cloud)

From `/app/frontend` on your local machine (NOT in this container — `eas-cli` needs interactive login):

```bash
# Sanity check the manifest first
npx expo-doctor
npx expo prebuild --clean   # optional: regenerates ios/android dirs locally

# Build for TestFlight (production profile, IPA upload-ready)
eas build --platform ios --profile production

# When the build finishes (~15-25 min), submit it:
eas submit --platform ios --latest
```

The submit step uploads the IPA to App Store Connect. From there:

1. Wait ~10-30 min for Apple's automated processing ("Processing" → "Ready to Submit").
2. In App Store Connect → **TestFlight** tab:
   - Add Internal Testers (your friends' Apple IDs / emails)
   - Submit the build for Beta App Review (first build only — usually approved in <24h)
   - Distribute to testers — they get an email with the TestFlight invite link.

## 6. Smoke Test on a Real Device Before Distributing

- [ ] Sign in (use a real account — demo seed is disabled in prod!)
- [ ] Onboarding flow shows on first launch (uninstall + reinstall to repro)
- [ ] Map screen loads, user marker appears
- [ ] Hazard report (Police + Hazard) → confirmation toast
- [ ] Hail another tester → they receive the OS push notification
- [ ] PTT walkie-talkie transmit + receive
- [ ] Spotify deep-link opens the Spotify app
- [ ] Tapping a push notification banner opens the Map tab

## 7. Known Limitations (Communicate to Beta Testers)

- **Apple CarPlay** is not enabled yet — you need to apply for the CarPlay entitlement from Apple (3-6 week review). The UI is ready but the entitlement gate is closed until Apple approves.
- **OpenAI TTS** navigation voice may sound robotic if your OpenAI account has no billing credits. The fallback is `expo-speech` (system text-to-speech).
- **External Waze feed** is permanently removed — hazards are convoy-only.

## 8. Bumping Version for the Next Build

For every subsequent TestFlight build, you MUST bump these BEFORE `eas build`:

- `app.json` → `ios.buildNumber` ← Apple requires this to monotonically increase
- `app.json` → `android.versionCode` ← Google Play requires this to monotonically increase
- `app.json` → `version` ← only for user-visible releases (1.0.1 → 1.0.2 = bug fix; 1.1.0 = feature; 2.0.0 = major)

The `production` build profile in `eas.json` has `autoIncrement: true`, so EAS will bump the build number automatically — but only after the first build. The first build is whatever's in `app.json`.

---

Questions or stuck? Check `eas build --help`, or visit the Expo Discord — the EAS team is responsive.
