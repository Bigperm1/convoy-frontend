import ExpoModulesCore
import CallKit

// Reports whether the user is currently on a phone call, used to duck Nova.
// CXCallObserver requires NO entitlement (unlike CallKit's CXProvider for VoIP).
// `isOnCall()` is a synchronous Function so JS can read it inline before a callout.
public class ConvoyCallDetectorModule: Module {
  private let callObserver = CXCallObserver()

  public func definition() -> ModuleDefinition {
    Name("ConvoyCallDetector")

    Function("isOnCall") { () -> Bool in
      // `calls` lists current calls; a call that hasn't ended means we're on one.
      return self.callObserver.calls.contains { !$0.hasEnded }
    }
  }
}
