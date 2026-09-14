// src/lockHint.ts — a lock HINT for car receipts (build 79, 2026-09-14). Never gates behaviour.
//
//   '1'  protected data unavailable — the phone is locked AND has a passcode
//   '0'  protected data available — unlocked, OR no passcode at all: UIKit's property is true "if
//        content protection is not enabled" (uikit_uiapplication_isprotecteddataavailable), so '0'
//        can NEVER be read as "the driver unlocked the phone"
//   'na' not iOS
//   '?'  the binary predates HairpinSystem.protectedDataAvailable (build 78 and older), or it threw
//
// Rides car-status / car-comms-start / reroute-ask-skip rows so the field data can split
// "the phone app was not active" from "the phone was locked" — the open question in the build-79
// Scout-on-a-locked-phone decision. Native half: modules/hairpin-system/ios/HairpinSystemModule.swift.
import { Platform } from 'react-native';

export async function lockHint(): Promise<'1' | '0' | 'na' | '?'> {
  if (Platform.OS !== 'ios') return 'na';
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { HairpinSystem } = require('../modules/hairpin-system');
    if (!HairpinSystem || typeof (HairpinSystem as any).protectedDataAvailable !== 'function') return '?';
    return (await (HairpinSystem as any).protectedDataAvailable()) ? '0' : '1';
  } catch {
    return '?';
  }
}
