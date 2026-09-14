// HairpinTimerPump.mm — build 79 (iOS only)
//
// Keeps React Native's JS timers (setTimeout/setInterval) AND requestAnimationFrame running on
// the CarPlay screen while the iPhone's built-in display is off.
//
// WHY (RN 0.81.5, bridgeless — sources read 2026-09-13, re-read 2026-09-14):
//  * timers + rAF are C++ host functions (Libraries/Core/setUpTimers.js:22, the bridgeless branch);
//    rAF = createTimer(delay 0) (ReactCommon/react/runtime/TimerManager.cpp:228-262, :287-321, :386-393).
//  * they land in -[RCTTiming createTimerForNextFrame:] (ObjCTimerRegistry.mm:48-61) and fire only
//    from -[RCTTiming didUpdateFrame:] (RCTTiming.mm:242-316).
//  * didUpdateFrame is driven by RCTDisplayLink's `[CADisplayLink displayLinkWithTarget:]`
//    (React/Base/RCTDisplayLink.m:32) on the JS run loop (RCTInstance.mm:409, :434-436). Apple DTS,
//    developer.apple.com/forums/thread/777989: such a link follows the BUILT-IN display and "will
//    pause while the display is powered off". RCTTiming's NSTimer fallback exists only in
//    background/resign-active (RCTTiming.mm:139-148, :300-303) or for >1 s targets while paused
//    (:311-313) — a CarPlay-foreground app is ACTIVE, so neither applies.
//  * field: 2,263 `timer-starve surf=car` rows dt>60 s, 50 iOS instances, raf=0 on every one (21 d
//    to 09-13); heat-probe app=a raf=0 windows kept moving the car camera via onCarFrame — the
//    CarPlay-screen link and native->JS delivery stay alive while RN's link is silent.
//  * React Native's own fix path (patch RCTTiming) is not open to us: iOS links the PREBUILT
//    React.xcframework (ios/Podfile:17-18, RCT_USE_PREBUILT_RNCORE), which ignores a patch-package
//    patch of node_modules/react-native. scripts/trap-check.py blocks that patch and pins RN 0.81.5.
//
// WHAT: a CADisplayLink from the CarPlay window's UIScreen watches RN's link. Only when RN's link is
// ARMED (unpaused) but silent for kStarveAfterS does it run RN's own -_jsThreadUpdate: once on the JS
// run loop (the same CFRunLoopPerformBlock + CFRunLoopWakeUp RN uses, RCTMessageThread.mm:38-48).
//
// HEAT, display ON (2026-09-14, the build-79 bar: no runaway with the phone display on):
//  * RN's link ticks, so every car tick returns after two atomic reads and a counter — no JS work.
//  * With the phone scene foregroundActive the pump additionally waits a full 1 s of silence
//    (review P4: a >100 ms JS stall must not double a frame). `drvFg` in the receipt counts any
//    pass made anyway; it must stay ~0 in the field.
//  * Never more than ONE pass that ACTS (gDrivePending + gDriveGen: a re-queue after the 1 s escape supersedes the
//    older block), never two within kMinSyntheticSpacingS, never faster than the car screen's vsync.
//  * RN link paused (nothing scheduled, or RCTTiming in background mode — a backgrounded RCTTiming
//    is always _paused, RCTTiming.mm:180-189 + :207-233, and RCTDisplayLink.m:127 skips paused
//    observers): the pump is inert, so the background NSTimer rAF runaway path is untouched.
//
// No React headers, no source build: hooks install by NAME at +load and refuse unless every
// selector/ivar has the expected shape (stats.why says which one did not).

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#import <CarPlay/CarPlay.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <os/lock.h>
#import <os/log.h>
#include <atomic>
#include <cstdlib>

@interface HairpinTimerPump : NSObject
+ (NSDictionary<NSString *, id> *)stats;
+ (void)ensureCarLink;
+ (void)ensureCarLinkExcluding:(UIScene *)gone;
+ (void)debugSimulateStarve:(BOOL)on;
+ (void)debugDisablePump:(BOOL)on;
@end

// RN's link counts as starved once ARMED and silent this long: 3 frames at a throttled 30 Hz,
// 12 at 120 Hz — a live link never trips it.
static const CFTimeInterval kStarveAfterS = 0.10;
// With the phone scene foregroundActive (display on, app visible) the pump waits this long instead.
static const CFTimeInterval kPhoneForegroundStarveAfterS = 1.0;

static os_log_t gLog;
// nil (not a literal) so no static initializer can ever race +load; nil reads as "not-loaded".
static NSString *gWhy = nil;

static os_unfair_lock gLock = OS_UNFAIR_LOCK_INIT;
static void *gRctLinkPtr = NULL;                // identity only; guarded by gLock
static CFRunLoopRef gJsRunLoop = NULL;          // retained; guarded by gLock
static __weak id gRctLink;                      // STORED under gLock, LOADED outside it (a load retains)
static Ivar gJsLinkIvar = NULL;
static Ivar gObserversIvar = NULL;              // RCTDisplayLink._frameUpdateObservers (receipt only)
static SEL gJsThreadUpdateSel = NULL;

static std::atomic<bool> gInstalled{false};
static std::atomic<bool> gMainPaused{true};
static std::atomic<double> gLastMainTick{0};
static std::atomic<bool> gDrivePending{false};
static std::atomic<uint64_t> gDriveGen{0};         // bumped per queued pass; only the newest block acts (Codex 2026-09-14)
static std::atomic<uint64_t> gDriveStale{0};       // superseded blocks that returned without driving (receipt)
static std::atomic<double>   gLastSyntheticAt{0};  // CACurrentMediaTime of the last synthetic pass
static const CFTimeInterval  kMinSyntheticSpacingS = 0.012;   // < one 60-120 Hz car frame
static std::atomic<double> gDrivePendingAt{0};
static std::atomic<bool> gDebugStarve{false};
static std::atomic<bool> gDebugBindMain{false};
static std::atomic<bool> gDebugNoPump{false};
static std::atomic<bool> gCarLive{false};
static std::atomic<bool> gCarOnMain{false};
static std::atomic<int> gCarFps{0};
static std::atomic<int> gAppState{-1};
static std::atomic<int> gCarSceneState{-1};
static std::atomic<int> gProtectedData{-1};
// most-foreground non-CarPlay UIWindowScene: 0 foregroundActive, 1 foregroundInactive, 2 background, -1 none
static std::atomic<int> gPhoneScene{-1};
static std::atomic<double> gStarveStart{0};     // written on main only
static std::atomic<uint64_t> gMainTicks{0}, gMainDropped{0}, gCarTicks{0}, gDrives{0}, gSkipFresh{0},
    gSkipPaused{0}, gStarveEp{0}, gStarveMaxMs{0}, gStuck{0}, gDrivesPhoneFg{0}, gSkipPhoneFg{0};

static void (*gOrigAddToRunLoop)(id, SEL, NSRunLoop *);
static void (*gOrigJsThreadUpdate)(id, SEL, CADisplayLink *);
static void (*gOrigUpdateState)(id, SEL);
static void (*gOrigInvalidate)(id, SEL);

// main thread only
static CADisplayLink *gCarLink;
static __weak UIScreen *gCarScreen;
static __weak UIScene *gCarScene;
static CFTimeInterval gLastStarveLogAt = 0;

#pragma mark - RCTDisplayLink hooks (JS thread)

// Is `me` the RCTDisplayLink the pump is bound to? An expo-updates reload runs an OLD instance
// (old JS thread) alongside the new one until it is invalidated (RCTInstance.mm -invalidate), and
// its frames/pause state must not overwrite the new instance's (review P8).
static bool HPIsCurrentLink(id me) {
  os_unfair_lock_lock(&gLock);
  bool cur = gRctLinkPtr == (__bridge void *)me;
  os_unfair_lock_unlock(&gLock);
  return cur;
}

static void HPAddToRunLoop(id me, SEL cmd, NSRunLoop *runLoop) {
  gOrigAddToRunLoop(me, cmd, runLoop);
  CFRunLoopRef rl = runLoop ? [runLoop getCFRunLoop] : NULL;
  if (rl) CFRetain(rl);
  CFRunLoopRef old = NULL;
  os_unfair_lock_lock(&gLock);
  gRctLinkPtr = (__bridge void *)me;
  gRctLink = me;                                // weak STORE retains nothing: safe under the lock
  old = gJsRunLoop;
  gJsRunLoop = rl;
  os_unfair_lock_unlock(&gLock);
  if (old) CFRelease(old);
  // A fresh instance's RCTTiming starts _paused (RCTTiming.mm -setup) and un-pauses through its
  // pauseCallback -> updateJSDisplayLinkState when the first timer is created, which re-arms this
  // mirror. Reset here so a previous instance's "armed" state cannot carry over a reload.
  gMainPaused.store(true, std::memory_order_relaxed);
  gLastMainTick.store(CACurrentMediaTime(), std::memory_order_relaxed);
  os_log(gLog, "rct link bound");
  [HairpinTimerPump ensureCarLink];             // hops to main
}

static void HPJsThreadUpdate(id me, SEL cmd, CADisplayLink *link) {
  if (link != nil && HPIsCurrentLink(me)) {     // RN's own link; the pump passes nil
    if (gDebugStarve.load(std::memory_order_relaxed)) {   // bench: behave as if the display were off
      gMainDropped.fetch_add(1, std::memory_order_relaxed);
      return;
    }
    gLastMainTick.store(CACurrentMediaTime(), std::memory_order_relaxed);
    gMainTicks.fetch_add(1, std::memory_order_relaxed);
  }
  gOrigJsThreadUpdate(me, cmd, link);
}

static void HPUpdateState(id me, SEL cmd) {
  gOrigUpdateState(me, cmd);
  if (!HPIsCurrentLink(me)) return;
  CADisplayLink *link = object_getIvar(me, gJsLinkIvar);
  bool paused = (link == nil) || link.paused;
  bool was = gMainPaused.exchange(paused, std::memory_order_relaxed);
  // Grace on un-pause: RN's link gets one threshold to deliver its first frame before the pump may
  // drive, so a live display never sees a doubled frame. Costs <=100 ms (<=1 s with the phone scene
  // foregroundActive) per paused->unpaused transition while starved; the 1 s timerLiveness heartbeat
  // keeps RCTTiming unpaused in this app, so transitions are rare.
  if (was && !paused) gLastMainTick.store(CACurrentMediaTime(), std::memory_order_relaxed);
}

static void HPInvalidate(id me, SEL cmd) {
  CFRunLoopRef old = NULL;
  os_unfair_lock_lock(&gLock);
  if (gRctLinkPtr == (__bridge void *)me) {
    gRctLinkPtr = NULL;
    gRctLink = nil;                             // weak STORE of nil: safe under the lock
    old = gJsRunLoop;
    gJsRunLoop = NULL;
  }
  os_unfair_lock_unlock(&gLock);
  if (old) CFRelease(old);
  gOrigInvalidate(me, cmd);
}

#pragma mark - install

static Method HPOwnMethod(Class cls, SEL sel) {
  unsigned int n = 0;
  Method *list = class_copyMethodList(cls, &n);
  Method found = NULL;
  for (unsigned int i = 0; i < n; i++) {
    if (method_getName(list[i]) == sel) { found = list[i]; break; }
  }
  free(list);
  return found;
}

static BOOL HPVoidMethod(Method m, unsigned int argc, BOOL objectArg) {
  if (m == NULL || method_getNumberOfArguments(m) != argc) return NO;
  char t[16];
  method_getReturnType(m, t, sizeof t);
  if (t[0] != 'v') return NO;
  if (objectArg) {
    method_getArgumentType(m, 2, t, sizeof t);
    if (t[0] != '@') return NO;
  }
  return YES;
}

static NSString *HPInstall(void) {
  Class cls = NSClassFromString(@"RCTDisplayLink");
  if (cls == Nil) return @"no-class";
  SEL sAdd = sel_registerName("addToRunLoop:");
  SEL sUpd = sel_registerName("_jsThreadUpdate:");
  SEL sState = sel_registerName("updateJSDisplayLinkState");
  SEL sInv = sel_registerName("invalidate");
  Method mAdd = HPOwnMethod(cls, sAdd), mUpd = HPOwnMethod(cls, sUpd);
  Method mState = HPOwnMethod(cls, sState), mInv = HPOwnMethod(cls, sInv);
  if (!HPVoidMethod(mAdd, 3, YES)) return @"shape-addToRunLoop";
  if (!HPVoidMethod(mUpd, 3, YES)) return @"shape-jsThreadUpdate";
  if (!HPVoidMethod(mState, 2, NO)) return @"shape-updateState";
  if (!HPVoidMethod(mInv, 2, NO)) return @"shape-invalidate";
  Ivar iv = class_getInstanceVariable(cls, "_jsDisplayLink");
  const char *enc = iv ? ivar_getTypeEncoding(iv) : NULL;
  if (enc == NULL || enc[0] != '@') return @"shape-jsDisplayLink";
  Ivar ob = class_getInstanceVariable(cls, "_frameUpdateObservers");
  const char *obEnc = ob ? ivar_getTypeEncoding(ob) : NULL;
  gObserversIvar = (obEnc && obEnc[0] == '@') ? ob : NULL;   // receipt only; install does not depend on it
  gJsLinkIvar = iv;
  gJsThreadUpdateSel = sUpd;
  gOrigAddToRunLoop = (void (*)(id, SEL, NSRunLoop *))method_setImplementation(mAdd, (IMP)HPAddToRunLoop);
  gOrigJsThreadUpdate = (void (*)(id, SEL, CADisplayLink *))method_setImplementation(mUpd, (IMP)HPJsThreadUpdate);
  gOrigUpdateState = (void (*)(id, SEL))method_setImplementation(mState, (IMP)HPUpdateState);
  gOrigInvalidate = (void (*)(id, SEL))method_setImplementation(mInv, (IMP)HPInvalidate);
  return @"";
}

#pragma mark - pump (main thread) -> JS run loop

static void HPSamplePhoneScene(void) {   // main thread
  Class cp = NSClassFromString(@"CPTemplateApplicationScene");
  int best = -1;
  for (UIScene *sc in UIApplication.sharedApplication.connectedScenes) {
    if ((cp && [sc isKindOfClass:cp]) || ![sc isKindOfClass:UIWindowScene.class]) continue;
    int a = (int)sc.activationState;
    if (a >= 0 && (best < 0 || a < best)) best = a;
  }
  gPhoneScene.store(best, std::memory_order_relaxed);
}

static void HPSampleStates(void) {   // main thread
  HPSamplePhoneScene();
  UIApplication *app = UIApplication.sharedApplication;
  gAppState.store((int)app.applicationState, std::memory_order_relaxed);
  gProtectedData.store(app.protectedDataAvailable ? 1 : 0, std::memory_order_relaxed);
  UIScene *s = gCarScene;
  gCarSceneState.store(s ? (int)s.activationState : -1, std::memory_order_relaxed);
}

static void HPEndStarve(CFTimeInterval now) {   // main thread
  double start = gStarveStart.exchange(0, std::memory_order_relaxed);
  if (start <= 0) return;
  uint64_t ms = (uint64_t)((now - start) * 1000.0);
  if (ms > gStarveMaxMs.load(std::memory_order_relaxed)) gStarveMaxMs.store(ms, std::memory_order_relaxed);
  os_log(gLog, "starve end ms=%llu drives=%llu", (unsigned long long)ms,
         (unsigned long long)gDrives.load(std::memory_order_relaxed));
}

static void HPDrive(CFTimeInterval now) {   // main thread
  if (gDrivePending.load(std::memory_order_relaxed)) {
    // A block whose run loop died (a reload quits the old JS thread, RCTJSThreadManager -dealloc)
    // must not wedge the pump forever. Also counts a JS thread busy >1 s — informational only.
    if (now - gDrivePendingAt.load(std::memory_order_relaxed) < 1.0) return;
    gStuck.fetch_add(1, std::memory_order_relaxed);
  }
  CFRunLoopRef rl = NULL;
  os_unfair_lock_lock(&gLock);
  if (gJsRunLoop != NULL && gRctLinkPtr != NULL) rl = (CFRunLoopRef)CFRetain(gJsRunLoop);
  os_unfair_lock_unlock(&gLock);
  if (rl == NULL) return;
  // GENERATION (2026-09-14, Codex review [medium]): the 1 s escape above re-queues while an earlier block may still be
  // sitting on a live-but-busy JS run loop. Without a generation every queued block would run back-to-back when JS
  // recovers — each passes the freshness check (synthetic passes never move gLastMainTick) and each drives RN's frame
  // observers, i.e. a burst of timer + rAF passes exactly while recovering from a stall. Only the NEWEST block may act;
  // older ones return without touching gDrivePending, which the newest clears.
  const uint64_t gen = gDriveGen.fetch_add(1, std::memory_order_relaxed) + 1;
  gDrivePendingAt.store(now, std::memory_order_relaxed);
  gDrivePending.store(true, std::memory_order_relaxed);
  CFRunLoopPerformBlock(rl, kCFRunLoopCommonModes, ^{
    @autoreleasepool {
      if (gen != gDriveGen.load(std::memory_order_relaxed)) {
        gDriveStale.fetch_add(1, std::memory_order_relaxed);
        return;                                  // superseded by a newer queued pass
      }
      gDrivePending.store(false, std::memory_order_relaxed);
      // SPACING: never two synthetic passes inside one car frame, whatever queued them.
      CFTimeInterval t = CACurrentMediaTime();
      if (t - gLastSyntheticAt.load(std::memory_order_relaxed) < kMinSyntheticSpacingS) return;
      id link = gRctLink;                        // weak LOAD, outside the lock
      if (link == nil) return;
      bool same;
      os_unfair_lock_lock(&gLock);
      same = (gRctLinkPtr == (__bridge void *)link) && (gJsRunLoop == CFRunLoopGetCurrent());
      os_unfair_lock_unlock(&gLock);
      if (!same) return;                         // a reload swapped links/threads meanwhile
      if (gMainPaused.load(std::memory_order_relaxed)) return;
      if (CACurrentMediaTime() - gLastMainTick.load(std::memory_order_relaxed) < kStarveAfterS) return;
      gDrives.fetch_add(1, std::memory_order_relaxed);
      if (gPhoneScene.load(std::memory_order_relaxed) == 0) gDrivesPhoneFg.fetch_add(1, std::memory_order_relaxed);
      gLastSyntheticAt.store(CACurrentMediaTime(), std::memory_order_relaxed);
      ((void (*)(id, SEL, id))objc_msgSend)(link, gJsThreadUpdateSel, nil);
    }
  });
  CFRunLoopWakeUp(rl);
  CFRelease(rl);
}

@interface HPCarTarget : NSObject
- (void)tick:(CADisplayLink *)sender;
@end

@implementation HPCarTarget
- (void)tick:(CADisplayLink *)sender {
  uint64_t n = gCarTicks.fetch_add(1, std::memory_order_relaxed);
  if (n % 60 == 0) HPSampleStates();
  CFTimeInterval now = CACurrentMediaTime();
  if (gDebugNoPump.load(std::memory_order_relaxed)) return;
  if (gMainPaused.load(std::memory_order_relaxed)) {
    gSkipPaused.fetch_add(1, std::memory_order_relaxed);
    HPEndStarve(now);
    return;
  }
  CFTimeInterval since = now - gLastMainTick.load(std::memory_order_relaxed);
  // Structural display-on skip (review P4): a phone scene in foregroundActive means the display is
  // on and RN's link should be ticking, so a short silence is a JS stall, not a dark display. The
  // 1 s escape still pumps an unexpected "phone foreground but RN link silent" state.
  bool phoneFg = gPhoneScene.load(std::memory_order_relaxed) == 0;
  if (since < kStarveAfterS || (phoneFg && since < kPhoneForegroundStarveAfterS)) {
    (since < kStarveAfterS ? gSkipFresh : gSkipPhoneFg).fetch_add(1, std::memory_order_relaxed);
    HPEndStarve(now);
    return;
  }
  if (gStarveStart.load(std::memory_order_relaxed) <= 0) {
    gStarveStart.store(now - since, std::memory_order_relaxed);
    gStarveEp.fetch_add(1, std::memory_order_relaxed);
    os_log(gLog, "starve start sinceMainMs=%d", (int)(since * 1000.0));
  } else if (now - gLastStarveLogAt > 10.0) {
    gLastStarveLogAt = now;
    os_log(gLog, "starving ms=%d drives=%llu dropped=%llu", (int)((now - gStarveStart.load()) * 1000.0),
           (unsigned long long)gDrives.load(), (unsigned long long)gMainDropped.load());
  }
  HPDrive(now);
}
@end

static HPCarTarget *HPTarget(void) {
  static HPCarTarget *t;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ t = [HPCarTarget new]; });
  return t;
}

// Scene "Will…" notifications are posted BEFORE the transition, so a sample taken inside the block
// reads the OLD activationState (sim bench 2026-09-14: WillConnect/WillEnterForeground sampled
// Unattached (-1) and the headless sim never posted DidActivate, leaving ps=-1 on a
// ForegroundInactive scene). Sample again on the next main-queue turn, after the transition. The
// car tick also re-samples every 60 frames, so a car-live pump is never more than ~1 s stale.
static void HPSamplePhoneSceneNowAndAfter(void) {
  HPSamplePhoneScene();
  dispatch_async(dispatch_get_main_queue(), ^{ HPSamplePhoneScene(); });
}

static void HPObserveScenes(void) {
  NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
  for (NSNotificationName name in @[ UISceneWillConnectNotification, UISceneDidActivateNotification,
                                     UISceneWillDeactivateNotification, UISceneWillEnterForegroundNotification,
                                     UISceneDidEnterBackgroundNotification ]) {
    [nc addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
      HPSamplePhoneSceneNowAndAfter();
      [HairpinTimerPump ensureCarLink];
    }];
  }
  [nc addObserverForName:UISceneDidDisconnectNotification object:nil queue:NSOperationQueue.mainQueue
              usingBlock:^(NSNotification *note) {
    HPSamplePhoneSceneNowAndAfter();
    [HairpinTimerPump ensureCarLinkExcluding:(UIScene *)note.object];
  }];
}

@implementation HairpinTimerPump

+ (void)load {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    gLog = os_log_create("app.hairpin.timerpump", "pump");
    gWhy = HPInstall();
    gInstalled.store(gWhy.length == 0);
    os_log(gLog, "install %{public}@", gWhy.length ? gWhy : @"ok");
    if (!gInstalled.load()) return;
    // Bench switches: launch ARGUMENTS only (xcrun simctl launch … -HairpinTimerPumpDebugStarve), so a
    // tester can never set one.
    NSArray<NSString *> *args = NSProcessInfo.processInfo.arguments;
    gDebugStarve.store([args containsObject:@"-HairpinTimerPumpDebugStarve"]);
    gDebugBindMain.store([args containsObject:@"-HairpinTimerPumpDebugBindMain"]);
    gDebugNoPump.store([args containsObject:@"-HairpinTimerPumpDebugNoPump"]);
    HPObserveScenes();
  });
}

+ (void)ensureCarLink { [self ensureCarLinkExcluding:nil]; }

+ (void)ensureCarLinkExcluding:(UIScene *)gone {
  if (!NSThread.isMainThread) {
    dispatch_async(dispatch_get_main_queue(), ^{ [HairpinTimerPump ensureCarLinkExcluding:gone]; });
    return;
  }
  if (!gInstalled.load()) return;
  Class cpScene = NSClassFromString(@"CPTemplateApplicationScene");
  UIScene *carScene = nil;
  UIScreen *screen = nil;
  if (cpScene != Nil) {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (scene == gone || ![scene isKindOfClass:cpScene]) continue;
      // As HairpinSystemModule.carPlayScreen(). Never the phone's screen (review P5): a UIWindow's
      // screen is mainScreen until its scene is attached, and a pump bound to the built-in display is
      // silently useless while locked. A later scene notification / host start / stats poll re-binds.
      UIScreen *s = ((CPTemplateApplicationScene *)scene).carWindow.screen;
      if (s != nil && s != UIScreen.mainScreen) { carScene = scene; screen = s; break; }
    }
  }
  BOOL debugMain = NO;
  if (screen == nil && (gDebugStarve.load() || gDebugBindMain.load())) { screen = UIScreen.mainScreen; debugMain = YES; }
  gCarScene = carScene;
  if (screen != nil && gCarLink != nil && gCarScreen == screen) return;
  if (gCarLink != nil) {
    [gCarLink invalidate];
    gCarLink = nil;
    gCarLive.store(false);
    gCarOnMain.store(false);
    HPEndStarve(CACurrentMediaTime());
    os_log(gLog, "car link released");
  }
  gCarScreen = nil;
  if (screen == nil) return;
  CADisplayLink *link = [screen displayLinkWithTarget:HPTarget() selector:@selector(tick:)];
  if (link == nil) return;
  link.preferredFrameRateRange = CAFrameRateRangeMake(30, 60, 60);
  [link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
  gCarLink = link;
  gCarScreen = screen;
  gCarFps.store((int)screen.maximumFramesPerSecond);
  gCarOnMain.store(screen == UIScreen.mainScreen);
  gCarLive.store(true);
  HPSampleStates();
  os_log(gLog, "car link bound fps=%ld debugMain=%d", (long)screen.maximumFramesPerSecond, (int)debugMain);
}

// Called from JS (HairpinSystemModule.swift timerPumpStats, a sync expo Function = the JS thread).
+ (NSDictionary<NSString *, id> *)stats {
  CFTimeInterval now = CACurrentMediaTime();
  double start = gStarveStart.load();
  id rct = gRctLink;                                             // weak LOAD, outside the lock
  BOOL bound = (rct != nil);
  if (gInstalled.load() && !gCarLive.load()) [self ensureCarLink];   // cheap self-heal (async to main)

  // RCTTiming's REAL state (review P2a): `mp` mirrors _jsDisplayLink.paused, which cannot tell "idle"
  // from "_inBackground stuck YES". Read the two ivars directly — only on the bound link's own run
  // loop thread, the one thread that mutates _frameUpdateObservers (RCTInstance.mm:434-436, -invalidate
  // dispatches to it). Anywhere else (e.g. LLDB) it reports -1 rather than race the set.
  int tbg = -1, tp = -1;
  bool onLinkThread = false;
  os_unfair_lock_lock(&gLock);
  onLinkThread = rct != nil && gRctLinkPtr == (__bridge void *)rct && gJsRunLoop == CFRunLoopGetCurrent();
  os_unfair_lock_unlock(&gLock);
  Class timingCls = NSClassFromString(@"RCTTiming");
  if (onLinkThread && gObserversIvar != NULL && timingCls != Nil) {
    Ivar ivBg = class_getInstanceVariable(timingCls, "_inBackground");
    Ivar ivP = class_getInstanceVariable(timingCls, "_paused");
    const char *eb = ivBg ? ivar_getTypeEncoding(ivBg) : NULL, *ep = ivP ? ivar_getTypeEncoding(ivP) : NULL;
    SEL sInst = sel_registerName("instance");
    id observers = object_getIvar(rct, gObserversIvar);
    if ([observers isKindOfClass:NSSet.class]) {
      for (id holder in (NSSet *)observers) {
        if (![holder respondsToSelector:sInst]) continue;
        id inst = ((id (*)(id, SEL))objc_msgSend)(holder, sInst);
        if (![inst isKindOfClass:timingCls]) continue;
        const uint8_t *base = (const uint8_t *)(__bridge void *)inst;
        if (eb && (eb[0] == 'B' || eb[0] == 'c')) tbg = base[ivar_getOffset(ivBg)] ? 1 : 0;
        if (ep && (ep[0] == 'B' || ep[0] == 'c')) tp = base[ivar_getOffset(ivP)] ? 1 : 0;
        break;
      }
    }
  }

  int dbg = (gDebugStarve.load() ? 1 : 0) | (gDebugBindMain.load() ? 2 : 0) | (gDebugNoPump.load() ? 4 : 0);
  return @{
    @"installed" : @(gInstalled.load()), @"why" : gWhy ?: @"not-loaded", @"bound" : @(bound),
    @"car" : @(gCarLive.load()), @"fps" : @(gCarFps.load()), @"dbg" : @(dbg), @"onMain" : @(gCarOnMain.load()),
    @"mainTicks" : @(gMainTicks.load()), @"mainDropped" : @(gMainDropped.load()),
    @"carTicks" : @(gCarTicks.load()), @"drives" : @(gDrives.load()),
    @"skipFresh" : @(gSkipFresh.load()), @"skipPaused" : @(gSkipPaused.load()),
    @"starveEp" : @(gStarveEp.load()), @"starveMaxMs" : @(gStarveMaxMs.load()),
    @"starvingMs" : @(start > 0 ? (now - start) * 1000.0 : 0.0),
    @"sinceMainMs" : @((now - gLastMainTick.load()) * 1000.0),
    @"mainPaused" : @(gMainPaused.load()), @"stuck" : @(gStuck.load()), @"stale" : @(gDriveStale.load()),
    @"appState" : @(gAppState.load()), @"carScene" : @(gCarSceneState.load()),
    @"protectedData" : @(gProtectedData.load()),
    @"timingBg" : @(tbg), @"timingPaused" : @(tp), @"phoneScene" : @(gPhoneScene.load()),
    @"drivesPhoneFg" : @(gDrivesPhoneFg.load()), @"skipPhoneFg" : @(gSkipPhoneFg.load()),
  };
}

// LLDB: expr -l objc -- (void)[(Class)NSClassFromString(@"HairpinTimerPump") debugDisablePump:(BOOL)1]
+ (void)debugSimulateStarve:(BOOL)on { gDebugStarve.store(on); os_log(gLog, "debug starve=%d", (int)on); [self ensureCarLink]; }
+ (void)debugDisablePump:(BOOL)on { gDebugNoPump.store(on); os_log(gLog, "debug nopump=%d", (int)on); }

@end
