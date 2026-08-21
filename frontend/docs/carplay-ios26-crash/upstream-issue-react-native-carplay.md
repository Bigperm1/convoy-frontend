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

<!-- Ready to post at: https://github.com/birkir/react-native-carplay/issues/new -->
<!-- Title: -->
CPMapTemplate crashes on iOS 26 at map-template load — `-[CPSMapTemplateViewController _updateShareButtonVisibility]` unrecognized selector `vehicleSupportsDestinationSharing`

<!-- Body: -->
## Summary

On **iOS 26.1+**, presenting a `CPMapTemplate` crashes the `CarPlayTemplateUIHost` process
immediately when the map template's view controller loads. CarPlay never paints. This reproduces
in the **iOS 26.5 Simulator** (Xcode 26.6). It does **not** occur on iOS 18.

## Version

- `react-native-carplay@2.4.1-beta.0` (latest)
- React Native 0.81, New Architecture, Expo SDK 54-era
- Xcode 26.6, iOS 26.5 Simulator (iPhone 17 Pro)

## Crash

`SIGABRT` — `NSInvalidArgumentException` / unrecognized selector. Faulting thread:

```
-[NSObject doesNotRecognizeSelector:]
___forwarding___
-[CPSMapTemplateViewController _updateShareButtonVisibility]
-[CPSMapTemplateViewController _configureNavigationBarShareButton]
-[CPSMapTemplateViewController _viewDidLoad]
-[CPSBaseTemplateViewController viewDidLoad]
-[UIViewController _sendViewDidLoadWithAppearanceProxyObjectTaggingEnabled]
```

## Root cause (from disassembling `CarPlaySupport`)

`-[CPSMapTemplateViewController _updateShareButtonVisibility]` (iOS 26.1+, tied to the new
`CPTrip.hasShareableDestination` / destination-sharing feature) does, at the top of the method:

```objc
id d = [self destinationSharingDelegate];         // non-nil
BOOL ok = [d vehicleSupportsDestinationSharing];   // no respondsToSelector: guard → crash
```

`vehicleSupportsDestinationSharing` is implemented by an internal `CarPlaySupport` class that is the
*intended* `destinationSharingDelegate`. With this library, that delegate resolves to an object
that does not implement the selector, and Apple invokes it unguarded, so the host aborts.

## Reproduction

1. Present a `CPMapTemplate` as root (any map app) on an iOS 26.1+ target.
2. `I/O → External Displays → CarPlay` in Simulator, open the app.
3. Host crashes at map-template `viewDidLoad`.

## Notes / attempted workaround

Adding `- (BOOL)vehicleSupportsDestinationSharing { return NO; }` to the object set as
`mapTemplate.mapDelegate` does **not** help — the crash is in the separate `CarPlayTemplateUIHost`
process, on a host-side object, so an app-process method is never consulted.

Happy to provide the full `.ips` and disassembly. Is there a known iOS-26 path (e.g. a template
config or a delegate the library should wire) that satisfies the new destination-sharing setup?
