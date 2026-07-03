<!-- Ready to submit at: https://feedbackassistant.apple.com -->
<!-- Area: CarPlay. Type: Incorrect/Unexpected Behavior (crash). -->

# Title
CarPlayTemplateUIHost crashes: `-[CPSMapTemplateViewController _updateShareButtonVisibility]` sends `vehicleSupportsDestinationSharing` to destinationSharingDelegate without a respondsToSelector: guard (iOS 26.5 Simulator)

# Description

On iOS 26.1+ (reproduced on the **iOS 26.5 Simulator**, Xcode 26.6), presenting a `CPMapTemplate`
crashes `CarPlayTemplateUIHost` the moment the template's view controller loads its view. CarPlay
does not render.

The crash is an unrecognized-selector `NSInvalidArgumentException` (SIGABRT). Faulting stack:

```
-[NSObject doesNotRecognizeSelector:]
___forwarding___
-[CPSMapTemplateViewController _updateShareButtonVisibility]
-[CPSMapTemplateViewController _configureNavigationBarShareButton]
-[CPSMapTemplateViewController _viewDidLoad]
-[CPSBaseTemplateViewController viewDidLoad]
```

Disassembly of `CarPlaySupport`'s `_updateShareButtonVisibility` shows it calls, unguarded:

```objc
BOOL ok = [[self destinationSharingDelegate] vehicleSupportsDestinationSharing];
```

When `destinationSharingDelegate` is a non-nil object that does not respond to
`vehicleSupportsDestinationSharing` (as happens for third-party map apps whose map-template
delegate is not the internal CarPlaySupport controller that implements this selector), the
unguarded call aborts the process.

# Expected
`_updateShareButtonVisibility` should guard the call (`respondsToSelector:` / nil-check), or the
new destination-sharing delegate should be wired so third-party `CPMapTemplate` apps don't crash.

# Actual
`CarPlayTemplateUIHost` aborts at map-template `viewDidLoad`; CarPlay is unusable for the app on
iOS 26.1+.

# Steps to Reproduce
1. Third-party CarPlay app presenting a `CPMapTemplate` (here via `react-native-carplay`).
2. iOS 26.5 Simulator → I/O → External Displays → CarPlay → open the app.
3. Host crashes immediately. `.ips` attached.

# Notes
Did not occur on iOS 18. Please advise whether a supported delegate/config satisfies the new
destination-sharing path, or whether the unguarded call is the bug.
