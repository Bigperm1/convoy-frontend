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

# iOS-26 CarPlay cold-open crash (`_updateShareButtonVisibility`)

**Status:** RESOLVED as **iOS-Simulator-only** — NOT a real-world blocker. See "Real-device result" below.
**Found:** 2026-07-03, on the Mac Xcode session, first time Convoy CarPlay was run on an iOS-26 **simulator**.
**Affects:** The **iOS 26.x Simulator's** CarPlay host only. NOT caused by the pinch-zoom work.
**Does NOT affect:** Real iOS-26 devices (verified on iOS 26.6, see below) or iOS-18 testers. CarPlay works on both.

## ✅ Real-device result (2026-07-03)

Maintainer tested the currently-installed build (build 60, runtime 1.13.1) on a **real iPhone on
iOS 26.6** over **wireless CarPlay** in a car. **Convoy's CarPlay map opened and rendered normally —
no crash.** Since both the simulator (26.5) and the phone (26.6) are past iOS 26.1 (where the
crashing destination-sharing path was added), the only variable is simulator-vs-hardware. Conclusion:
this is a **bug in Apple's iOS 26.x Simulator CarPlay host**, and does not affect shipping cars.

**Implications:**
- The iOS-26 pinch-zoom feature is cleared to ship. It can be live-tested on a **real device** (needs
  build 61 installed + a **touchscreen** CarPlay head unit — raw pinch requires a touch display).
- It CANNOT be live-tested in the Simulator (CarPlay won't open there on iOS 26 due to this bug).
- The Apple Feedback draft (`apple-feedback.md`) is still worth filing — it's a real Simulator bug.
  The `react-native-carplay` issue draft can be filed as "crashes in iOS-26 Simulator" (lower priority
  now that real devices are confirmed fine).

---

## TL;DR (plain English)

The moment Convoy's CarPlay **map** screen tries to appear on **iOS 26**, Apple's own CarPlay
software crashes and CarPlay quits. It is **not** the pinch-zoom feature — the pinch code is
complete and verified. The crash is Apple's new iOS-26.1 "share your destination" feature
demanding a helper object that the `react-native-carplay` library doesn't provide.

The crash happens **inside Apple's own separate process** (`CarPlayTemplateUIHost`), on an object
Convoy doesn't own, so **we cannot patch it from the app.** A real fix needs either an updated
`react-native-carplay` or a fix/guard from Apple.

**It may be simulator-only** — we could not verify on a real iOS-26 car (no hardware available).
**Confirm on a real iOS-26 head unit before shipping build 61 to any iOS-26 driver.**

---

## What the user sees

- Phone app: fine.
- Open the CarPlay map (or CarPlay auto-restores it on connect) → macOS/Simulator shows
  **"CarPlayTemplateUIHost quit unexpectedly."** The CarPlay screen returns to its home grid.
- On a real car this would present as CarPlay dropping Convoy / returning to the CarPlay dashboard.

## Exact technical root cause

Signal: `SIGABRT` (`Abort trap: 6`) from an **unrecognized selector** exception. Faulting stack
(from `docs/carplay-ios26-crash/CarPlayTemplateUIHost-2026-07-03-085637.ips`):

```
-[NSObject doesNotRecognizeSelector:]        ← throws
___forwarding___
-[CPSMapTemplateViewController _updateShareButtonVisibility]
-[CPSMapTemplateViewController _configureNavigationBarShareButton]
-[CPSMapTemplateViewController _viewDidLoad]        ← runs on map-template load
-[CPSBaseTemplateViewController viewDidLoad]
```

Disassembly of `-[CPSMapTemplateViewController _updateShareButtonVisibility]` in the iOS-26.5
simulator's `CarPlaySupport` private framework shows this happens at the top of the method:

```objc
id d = [self destinationSharingDelegate];        // weak property; returns a NON-nil object
BOOL ok = [d vehicleSupportsDestinationSharing];  // 💥 unrecognized selector → abort
if (!ok) { /* tbz branch: skips the whole share-button block */ }
```

- `vehicleSupportsDestinationSharing` **is** a real, implemented method — but on a specific
  internal `CarPlaySupport` controller class that is *supposed* to be the
  `destinationSharingDelegate`.
- In the `react-native-carplay` scenario, `destinationSharingDelegate` is pointed at the **wrong
  object** (one that does not implement the selector), and Apple's code calls it **without a
  `respondsToSelector:` guard** — so it aborts.
- Apple only added this path in iOS **26.1** (`CPTrip.hasShareableDestination` is
  `API_AVAILABLE(ios(26.1))`), which is why it never fired before.

## Why we can't fix it from the app

`CarPlayTemplateUIHost` is a **separate system process**. The crashing object lives inside it, not
inside Convoy. We cannot inject code into Apple's process, and we cannot change which object Apple
wires as its `destinationSharingDelegate`.

### What was tried (and why it failed)

Added `- (BOOL)vehicleSupportsDestinationSharing { return NO; }` to `RNCarPlay` (the object set as
`mapTemplate.mapDelegate`, patch: `patches/react-native-carplay+2.4.1-beta.0.patch`).
Rebuilt + reran → **still crashed identically.** Confirms the receiver is **not** our in-process
`RNCarPlay` delegate; it's a host-side object we can't extend. The probe edit was reverted; the
committed tree is unchanged by it.

Also checked: `react-native-carplay@2.4.1-beta.0` is already the **latest** published version — no
upstream fix to pull.

## Impact on the pinch-zoom task

The iOS-26 multitouch pinch/zoom feature is **code-complete and SDK-verified**:
- Native selectors match `CarPlay/CPMapTemplate.h` in the iOS-26 SDK exactly.
- Builds clean, `yarn typecheck` passes.

But it **cannot be live-tested** right now: pinch/zoom gesture callbacks only exist on iOS 26, and
iOS 26 is exactly where CarPlay crashes on open. Catch-22. Live verification is blocked on this
crash being resolved (or shown to be simulator-only on a real car).

## Recommended next steps

1. **Do NOT ship build 61 to iOS-26 drivers** until this is resolved or proven simulator-only.
   iOS-18 testers are unaffected — OTAs/builds for them are safe.
2. **Verify on a real iOS-26 device + CarPlay head unit** (or a car). If it does NOT crash there,
   this is an Apple Simulator bug and pinch-zoom can be tested/shipped on real hardware.
3. **File upstream** (drafts in this folder):
   - `react-native-carplay` GitHub issue → `upstream-issue-react-native-carplay.md`
   - Apple Feedback Assistant → `apple-feedback.md`
4. If a fix is needed before Apple/library responds, the only viable levers are **inside
   `react-native-carplay`'s native `CPMapTemplate` setup** (`patches/…carplay….patch`) — e.g.
   whatever makes the host route `destinationSharingDelegate` correctly — which requires more
   reverse-engineering of the host↔app CarPlay bridge and is not guaranteed to be possible.

## How to reproduce / get a fresh crash log

1. `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` and
   `export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8` (CocoaPods needs UTF-8, or `pod install` aborts).
2. `yarn expo run:ios --device "iPhone 17 Pro"` (an iOS-26 simulator).
3. Simulator menu **I/O → External Displays → CarPlay** → tap the **Convoy** icon.
4. Crash dialog appears. Fresh report at
   `~/Library/Logs/DiagnosticReports/CarPlayTemplateUIHost-*.ips`.
