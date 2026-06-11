package com.sw0rdfisch.convoy.calldetector

import android.content.Context
import android.media.AudioManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Reports whether the user is on a phone call, used to duck Nova. Uses
// AudioManager's mode (MODE_IN_CALL = cellular call, MODE_IN_COMMUNICATION =
// VoIP), which needs NO permission — unlike PhoneStateListener / READ_PHONE_STATE.
// `isOnCall()` is a synchronous Function so JS can read it inline before a callout.
class ConvoyCallDetectorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ConvoyCallDetector")

    Function("isOnCall") {
      val ctx = appContext.reactContext ?: return@Function false
      val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return@Function false
      val mode = am.mode
      return@Function mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION
    }
  }
}
