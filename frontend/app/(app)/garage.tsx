// The Garage — "The Showroom" (Jeff, 2026-09-22: "go build the new garage...", after approving the four
// tier views drawn on the Design canvas). One page for every tier:
//
//   header   back · GARAGE · the tier chip (FREE / SILVER / GOLD in that metal; Ultra: the scan pips)
//   stage    today's car turning on a lit turntable; swipe through every car you OWN (neighbours peek,
//            dimmed); the last spot is the next tier, LOCKED with its metal H (tap → that tier's paywall),
//            or, for Ultra, "+ Scan a car" (→ the scan flow, never a paywall)
//   plate    your CALL SIGN as a licence plate + two facts
//   button   "Drive this today" in the page metal — or "Driving today ✓" when it already is
//   up next  ONE card for the next rung (prices only from src/pricing.ts), or Ultra's scan tray
//   actions  360° spin (the 3D cars) · Customize (the old long scroll, now a sheet) · Share
//
// What a switch writes, what each surface reads, and why a scan gets PARKED: src/garageCars.ts.
// What the Garage remembers on its own: src/garageStore.ts. The stage: src/components/showroom/Stage.tsx.
//
// KEPT FROM THE OLD SCREEN (every write shape and backend PUT unchanged):
//   • hydrate once per mount, after auth — local settings win, the backend profile fills blanks, the
//     retired "Widebody" paint never comes back, a one-time upward sync of an existing local car;
//   • the scan RETURN LEG — refresh on every focus, a 20 s poll only while something is building,
//     reconcile with the server first, the HEAL for a missing map twin, the one-shot celebration keyed
//     on the persisted flag, the hero shot uploaded once per scan;
//   • the skin follows the pick (SKIN_FOR_MARKER, unchanged values) — through "Drive this today" now;
//   • locks wear the FEATURE's metal (useFeatureTier), never the member's skin.
// CHANGED ON PURPOSE:
//   • swiping only PREVIEWS; "Drive this today" switches (the carousel used to switch on landing);
//   • the page wears the tier's metal all the way through, on the plain stage black of the approved
//     design (the carousel's tier wallpaper is gone with the carousel);
//   • Silver's locked Gold spot opens the Gold paywall (openPaywall('car_3d')); the old locked 3D tile
//     went to the Garage Scan pitch instead (Jeff 8/20) — the Ultra spot keeps that job now.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, SafeAreaView, Share, Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { getSettings, updateSettings, useSettings } from '../../src/settings';
import { useFeatureTier, openPaywall, useEntitlementVersion } from '../../src/PremiumBadge';
import { useAuth } from '../../src/auth';
import { api } from '../../src/api';
import { skin } from '../../src/tierTheme';
import { ULTRA } from '../../src/pricing';
import CarViewer3D from '../../src/CarViewer3D';
import { ScanReadyOverlay } from '../../src/ScanHero';
import { CandyCta } from '../../src/components/CandyCta';
import {
  checkScanReady, deliverSubmittedScan, fetchScanSlots, reconcileScanState, uploadScanHero, SHOTS_TOTAL,
} from '../../src/carScan';
import { getGarage, useGarage } from '../../src/garageStore';
import {
  activeCarId, adoptActiveScan, checkBuildingScans, claimGarageFor, driveToday, garageViewTier, ownedCars,
  parkStrayScan, refreshScanList, retryProfileClear, scanCarId, scanCars, type GarageCar,
} from '../../src/garageCars';
import Stage, { type StageLabels, type StageSlot } from '../../src/components/showroom/Stage';
import { AddSlotArt, CarSlotArt, LockedBadge, LockedSlotArt, carGlbUrl } from '../../src/components/showroom/SlotArt';
import PlateStrip, { type PlateFact } from '../../src/components/showroom/PlateStrip';
import TierChip from '../../src/components/showroom/TierChip';
import UpNextCard from '../../src/components/showroom/UpNextCard';
import CustomizeSheet from '../../src/components/showroom/CustomizeSheet';
import { garageMetal, nextRung, upNextCopy } from '../../src/components/showroom/tier';
import { carName, carSub, scannedOn } from '../../src/components/showroom/labels';

// Paints that no longer exist and must never be restored from any source — not local settings, not
// the backend profile. "Widebody" was Jeff's own scanned car, retired 2026-08-23 ("remove the widebody
// and start fresh. including my car").
const RETIRED_COLORS = new Set<string>(['Widebody']);

/** A PB is stored in km/h (server.py top_speed_record); the old card printed it raw with "km/h". */
const fmtSpeed = (kmh: number) => (Number.isInteger(kmh) ? String(kmh) : kmh.toFixed(1));

export default function GarageScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [settings] = useSettings();
  const garage = useGarage();
  // Re-render when the tier (or the QA override) hydrates — getTier()/getDevTier() are 'free'/null
  // until the async read finishes.
  useEntitlementVersion();
  const viewTier = garageViewTier();
  const metal = garageMetal(viewTier);
  const sk = skin(metal);
  const next = nextRung(viewTier);
  // Locks wear the FEATURE's metal, never the page's or the member's skin (DESIGN.md §4). Called
  // unconditionally — Ultra has no next rung, so it asks about car_scan and never uses the answer.
  const lockTier = useFeatureTier(next?.feature ?? 'car_scan');

  // ── the cars ─────────────────────────────────────────────────────────────────────────────────────
  const cars = useMemo(() => ownedCars(viewTier, settings, garage), [viewTier, settings, garage]);
  const derivedActive = activeCarId(settings, garage);
  // The 3D arrow is one map state with the 2D one; a view that does not own it shows the arrow.
  const activeId = cars.some((c) => c.id === derivedActive)
    ? derivedActive
    : derivedActive === 'arrow3d' ? 'arrow' : derivedActive;
  const slots: StageSlot[] = useMemo(() => [
    ...cars.map((c) => ({ key: c.id, type: 'car' as const })),
    next ? { key: 'locked', type: 'locked' as const } : { key: 'add', type: 'add' as const },
  ], [cars, next]);

  // Which spot is centred. null = follow today's car (the first paint, and after a switch).
  const [centredKey, setCentredKey] = useState<string | null>(null);
  const wantKey = centredKey ?? activeId;
  const found = slots.findIndex((sl) => sl.key === wantKey);
  const centredIndex = found >= 0 ? found : Math.max(0, slots.findIndex((sl) => sl.key === activeId));
  const centred = slots[centredIndex] ?? slots[0];
  const centredCar: GarageCar | undefined = centred.type === 'car' ? cars.find((c) => c.id === centred.key) : undefined;
  const onIndexChange = useCallback((i: number) => { const k = slots[i]?.key; if (k) setCentredKey(k); }, [slots]);

  // ── hydrate once per mount, after auth (unchanged) ───────────────────────────────────────────────
  // Local settings win; the backend profile fills blanks, so a fresh install / new build (local
  // storage wiped) still shows the car attached to the account instead of forcing a re-entry.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (user === undefined || hydratedRef.current) return; // wait for auth, run once
    hydratedRef.current = true;
    const s = getSettings();
    // Colour is free text, so it cannot be validated against a list — but a RETIRED paint must still
    // not come back. Clearing it locally is not enough: the BACKEND profile still holds it and the
    // patch below would write it straight back, which is exactly how "Widebody" survived its migration.
    const rawColor = s.carColor || user?.car_color || '';
    const cl = RETIRED_COLORS.has(rawColor) ? '' : rawColor;
    // Appearance: local settings first, backend profile as fallback.
    if (!s.selfMarkerType && (user as any)?.avatar_type) {
      updateSettings({ selfMarkerType: (user as any).avatar_type });
    }
    // If local was empty but the profile had the car, persist it locally so the rest of the app (map
    // self-marker, presence) picks it up immediately too.
    const patch: Record<string, any> = {};
    if (!s.carMake && user?.car_make) patch.carMake = user.car_make;
    if (!s.carModel && user?.car_model) patch.carModel = user.car_model;
    if (!s.carColor && cl) patch.carColor = cl;          // cl, not user.car_color — a retired paint must not come back
    if (s.carColor && !cl) patch.carColor = undefined;   // stored paint is dead — clear it so the field reopens
    if (!s.carYear && user?.car_year != null) patch.carYear = String(user.car_year);
    if (Object.keys(patch).length) updateSettings(patch);
    // One-time sync of any EXISTING local car identity up to the backend, so users who picked their
    // car before backend-sync existed get their paint onto the map without re-selecting anything.
    if (s.carMake || s.carModel || s.carColor) {
      api.put('/auth/profile', {
        car_make: s.carMake || undefined,
        car_model: s.carModel || undefined,
        car_color: s.carColor || undefined,
        car_year: s.carYear ? (parseInt(s.carYear, 10) || undefined) : undefined,
      }).catch(() => {});
    }
  }, [user]);

  // A garage belongs to an ACCOUNT; settings belong to the phone (logout keeps them). A different account
  // signing in here starts from an empty garage, and the last account's scan pointer is dropped
  // (garageCars.claimGarageFor). Claimed at the top of every focus, BEFORE the inventory is fetched —
  // refreshScanList discards an answer whose owner changed mid-flight, so the claim must land first.
  const userId = user?.id;

  // ── the server's scan count (Ultra's plate + chip) ───────────────────────────────────────────────
  // GET /api/entitlement → scanSlots.used. ⚠ The server's max is SCAN_MAX_SLOTS (default 2, and the
  // consent copy still says the second replaces the first) while Ultra includes 3 a year
  // (src/pricing.ts) — the caps and the copy move together in build 80. Until then the "of 3" here is
  // the plan, not the server's gate.
  const [serverUsed, setServerUsed] = useState<number | null>(null);

  // ── the scan return leg (v2, 2026-08-29; the Showroom version 2026-09-22) ───────────────────────
  // Re-check on every FOCUS (this screen lives in a Tabs navigator — "mount" is the first visit of the
  // whole session), and while anything is building keep a 20 s interval running so the car appears
  // while the driver sits here watching the clock. A HEAD against the public bucket is free and misses
  // are never CDN-cached.
  const [scanJustReady, setScanJustReady] = useState(false);
  // In-flight guard: a HEAD slower than the interval (or a blur/refocus racing a tick) would otherwise
  // run two refreshes at once and double-write settings (review find, 2026-08-29).
  const scanBusyRef = useRef(false);
  const refreshScan = useCallback(async () => {
    if (scanBusyRef.current) return;
    scanBusyRef.current = true;
    try {
      // Today's scan goes into the Garage's own list FIRST — before anything (a new capture, a restore)
      // can move the pointer off it.
      await adoptActiveScan();
      let s = getSettings();
      // Server truth first (restore a lost finished scan / surface a failed one), then the local view.
      try { if (await reconcileScanState() !== 'noop') s = getSettings(); } catch {}
      if (s.carScanStatus === 'submitted' && s.carScanId) {
        const id = s.carScanId;
        const owner = getGarage().ownerId;
        const ready = await checkScanReady(id);
        if (ready) {
          // Writes the scan fields — which is also what flips the MAP marker live (map.tsx and carStore
          // subscribe to settings) — and makes the new car today's car unless the member picked another
          // car after submitting it. The same function lands it at launch (carScan.deliverSubmittedScan).
          const how = await deliverSubmittedScan(id, ready, owner);
          if (how === 'active') setCentredKey(scanCarId(id));
          s = getSettings();
        }
      }
      // An old-Garage state (the arrow picked while a scan stayed 'ready') is parked, so every surface
      // shows the arrow the member picked (garageCars.parkStrayScan).
      if (await parkStrayScan()) s = getSettings();
      // HEAL a pre-fix latch: an install that flipped ready while the map twin was still publishing has
      // carScanMapUrl stuck undefined and nothing re-checking. One extra HEAD per focus, only then.
      if (s.carScanStatus === 'ready' && !s.carScanMapUrl && s.carScanId) {
        const healed = await checkScanReady(s.carScanId);
        if (healed) await updateSettings({ carScanMapUrl: healed.mapUrl });
      }
      // A park's profile clear that did not get through (offline) is retried until it does.
      await retryProfileClear();
      // Any OTHER scan the Garage shows as building (a second car, or one whose pointer a newer pick
      // replaced) — it simply becomes a car in the Garage when it finishes.
      const pendingId = getSettings().carScanStatus === 'submitted' ? getSettings().carScanId : undefined;
      const others = scanCars(getSettings(), getGarage())
        .filter((c) => c.building && c.scanId && c.scanId !== pendingId)
        .map((c) => c.scanId!);
      if (others.length) await checkBuildingScans(others);
      // The one-shot celebration. Keyed on the PERSISTED flag, not the transition: a force-quit between
      // the ready-flip and the dismissal must not turn the one-shot into a zero-shot (review, 08-29).
      const after = getSettings();
      if (after.carScanStatus === 'ready' && after.carScanModelUrl && !after.carScanCelebrated) {
        setScanJustReady(true);
      }
    } finally {
      scanBusyRef.current = false;
    }
  }, []);

  const [focused, setFocused] = useState(false);
  useFocusEffect(useCallback(() => {
    setFocused(true);
    let alive = true;
    void (async () => {
      if (userId) await claimGarageFor(userId);
      if (!alive) return;
      void refreshScan();
      // The inventory — every scan this account made (GET /scan/mine), then the building check again
      // once the fresh list is in — and the server's scan count. Only the Ultra view shows either.
      if (viewTier === 'ultra') {
        void fetchScanSlots().then((slots) => { if (alive && slots) setServerUsed(slots.used); });
        await refreshScanList();
        if (alive) void refreshScan();
      }
    })();
    // Capture hands back to this screen mid-build — land the stage on the building car so the clock is
    // what the driver sees.
    const s = getSettings();
    if (s.carScanStatus === 'submitted' && s.carScanId) setCentredKey(scanCarId(s.carScanId));
    return () => { alive = false; setFocused(false); };
  }, [refreshScan, viewTier, userId]));
  // Poll only while something is actually building and this screen is in front — an idle Garage runs no
  // timer. Reactive, so a building scan the fresh /scan/mine answer brings in starts the clock too
  // (Codex review 2026-09-22: the timer used to be decided once, before the list arrived).
  const anyBuilding = settings.carScanStatus === 'submitted' || cars.some((c) => c.building);
  useEffect(() => {
    if (!focused || !anyBuilding) return;
    const t = setInterval(() => { void refreshScan(); }, 20000);
    return () => clearInterval(t);
  }, [focused, anyBuilding, refreshScan]);

  // HERO SHOT (2026-09-03, per scan since 2026-09-22): the first time a scan's hero renders live here,
  // keep a JPEG of it in car-scans/<scanId>/hero.jpg — the Crew / friend tiles show it, and so does this
  // stage for every car that is not the live one. Insert-only upload (a duplicate is a success);
  // carScanHeroShotId still marks today's scan exactly as before.
  const heroShotBusyRef = useRef(false);
  const heroShotDone = useRef(new Set<string>());
  const onHeroShot = useCallback(async (scanId: string, dataUri: string) => {
    const st = getSettings();
    if (!scanId || st.carScanHeroShotId === scanId || heroShotDone.current.has(scanId) || heroShotBusyRef.current) return;
    heroShotBusyRef.current = true;
    try {
      if (await uploadScanHero(scanId, dataUri)) {
        heroShotDone.current.add(scanId);
        const now = getSettings();
        if (now.carScanStatus === 'ready' && now.carScanId === scanId) await updateSettings({ carScanHeroShotId: scanId });
      }
    } catch {} finally { heroShotBusyRef.current = false; }
  }, []);

  // ── actions ──────────────────────────────────────────────────────────────────────────────────────
  const [driving, setDriving] = useState(false);
  const drive = useCallback(async () => {
    if (!centredCar || driving) return;
    Haptics.selectionAsync();
    setDriving(true);
    try {
      const r = await driveToday(centredCar);
      if (r === 'ok') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setCentredKey(centredCar.id);
      } else if (r === 'not-ready') {
        Alert.alert('Not ready yet', 'This car is still being published. Try again in a minute.');
      }
    } finally {
      setDriving(false);
    }
  }, [centredCar, driving]);

  const goScan = useCallback(() => {
    Haptics.selectionAsync();
    router.push('/(app)/garage-scan' as any);
  }, [router]);

  const openNextPaywall = useCallback(() => {
    if (!next) return;
    Haptics.selectionAsync();
    openPaywall(next.feature);
  }, [next]);

  const [viewer3D, setViewer3D] = useState(false);
  const spinUrl = centredCar && (viewTier === 'gold' || viewTier === 'ultra')
    ? carGlbUrl(centredCar, settings, garage)
    : null;

  const onTapCentre = useCallback(() => {
    if (centred.type === 'locked') openNextPaywall();
    else if (centred.type === 'add') goScan();
    else if (spinUrl) { Haptics.selectionAsync(); setViewer3D(true); }
  }, [centred.type, openNextPaywall, goScan, spinUrl]);

  // Customize: the car on the stage, or today's car when the stage shows a spot that is not a car.
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const customizeCar: GarageCar | null =
    (centredCar && !centredCar.building ? centredCar : cars.find((c) => c.id === activeId)) ?? null;

  const callSign = settings.callSign || user?.handle || '';

  const onShare = useCallback(async () => {
    const car = centredCar && !centredCar.building ? centredCar : cars.find((c) => c.id === activeId);
    if (!car) return;
    const lead = car.id === activeId ? "Today's car on Hairpin" : 'In my Hairpin garage';
    const name = carName(car, settings, garage);
    const sub = carSub(car, settings, garage);
    try {
      await Share.share({ message: `${lead}: ${name} (${sub}).${callSign ? ` Call sign ${callSign}.` : ''}` });
    } catch {}
  }, [centredCar, cars, activeId, settings, garage, callSign]);

  // ── what the page says ───────────────────────────────────────────────────────────────────────────
  const scanList = viewTier === 'ultra' ? cars.filter((c) => c.kind === 'scan') : [];
  const used = serverUsed ?? scanList.length;
  const scansLeft = Math.max(0, ULTRA.includedScansPerYear - used);

  const labels: StageLabels | null = (() => {
    if (centred.type === 'add') return null;                         // ScanPlaceholder carries its own words
    if (centred.type === 'locked') {
      if (!next) return null;
      if (next.tier === 'ultra') {
        // Gold's locked Ultra spot: labelled like the other locked spots, so it never reads as the Ultra
        // garage's own "+ Scan a car" (both centre on ScanPlaceholder art).
        return {
          pill: upNextCopy('gold', 0).label,
          pillMetal: lockTier,
          name: 'Your own car',
          sub: 'Scanned to 3D · on the map',
        };
      }
      return {
        pill: `UP NEXT · ${next.word.toUpperCase()}`,
        pillMetal: lockTier,
        name: next.tier === 'silver' ? 'Your class car' : 'Your car in 3D',
        sub: next.tier === 'silver' ? 'Class car in your paint · 2D map' : 'The 3D map, and your car on it in 3D',
      };
    }
    if (!centredCar || centredCar.building) return null;             // ScanCountdown carries its own words
    return {
      pill: centredCar.id === activeId ? "TODAY'S CAR" : 'IN YOUR GARAGE',
      pillMetal: metal,
      name: carName(centredCar, settings, garage),
      sub: carSub(centredCar, settings, garage),
    };
  })();

  const topSpeed = settings.topSpeed || user?.top_speed_record || null;
  const facts: PlateFact[] = (() => {
    const speed: PlateFact = topSpeed && viewTier !== 'free'
      ? { value: `${fmtSpeed(topSpeed)} km/h`, label: 'Top Cruise Speed' }
      : { value: 'Call sign', label: 'on every map' };
    if (viewTier === 'ultra') {
      const scans: PlateFact = { value: `${Math.min(used, 99)} of ${ULTRA.includedScansPerYear} scans used`, label: `${scansLeft} left this year` };
      if (centredCar?.kind === 'scan' && !centredCar.building) {
        const on = scannedOn(centredCar);
        return [{ value: on ? `Scanned ${on}` : 'Scanned', label: `from ${SHOTS_TOTAL} photos` }, scans];
      }
      return [speed, scans];
    }
    const n = cars.length;
    // Short enough for the plate row at 390 pt (the long list truncated in the sim render, 2026-09-22).
    const which = viewTier === 'free' ? 'the 2D arrow'
      : viewTier === 'silver' ? 'arrow · class'
      : 'in 2D and 3D';
    return [speed, { value: `${n} car${n === 1 ? '' : 's'}`, label: which }];
  })();

  const up = upNextCopy(viewTier, scansLeft);

  // ONE live WebView on the page: while the full-screen 360° viewer or the Customize sheet is up, the stage
  // shows its still (Codex review 2026-09-22 — the viewer used to load the same model a second time).
  // And NONE while the Garage is not in front: it is a Tabs screen (app/(app)/_layout.tsx), so it stays
  // mounted behind the map after Back — an auto-rotating model-viewer must not live on under it.
  const stageLive = focused && !viewer3D && !customizeOpen;
  const renderSlot = (slot: StageSlot, _i: number, isCentred: boolean) => {
    if (slot.type === 'locked') {
      return next ? <LockedSlotArt next={next.tier} centred={isCentred} live={isCentred && stageLive} s={settings} /> : null;
    }
    if (slot.type === 'add') return <AddSlotArt centred={isCentred} metal={metal} />;
    const car = cars.find((c) => c.id === slot.key);
    if (!car) return null;
    return (
      <CarSlotArt
        car={car} centred={isCentred} live={isCentred && stageLive}
        s={settings} g={garage} metal={metal} onHeroShot={onHeroShot}
      />
    );
  };

  const renderBadge = (slot: StageSlot, _i: number, isCentred: boolean) =>
    slot.type === 'locked' && next ? <LockedBadge lockTier={lockTier} centred={isCentred} /> : null;

  // ── the primary button ───────────────────────────────────────────────────────────────────────────
  const primary = (() => {
    if (centred.type === 'locked' && next) {
      // Ultra is Gold's add-on, not a rung: the button says what the Up next card says ("Add Ultra" /
      // "See yearly"), never "See Ultra".
      const ctaLabel = next.tier === 'ultra' ? upNextCopy('gold', 0).cta : `See ${next.word}`;
      return <CandyCta label={ctaLabel} icon="sparkles" onPress={openNextPaywall} tier={lockTier} height={52} radius={26} style={styles.primary} />;
    }
    if (centred.type === 'add') {
      return <CandyCta label="Scan a car" icon="scan-outline" onPress={goScan} tier={metal} height={52} radius={26} style={styles.primary} />;
    }
    if (centredCar?.building) {
      return <CandyCta label="Building your car…" icon="hammer-outline" disabled tier={metal} height={52} radius={26} style={styles.primary} />;
    }
    if (centredCar && centredCar.id === activeId) {
      return (
        <View style={[styles.primary, styles.today, { borderColor: sk.accent }]} accessibilityRole="text">
          <Ionicons name="checkmark-circle-outline" size={19} color={sk.accent} />
          <Text style={[styles.todayText, { color: sk.accent }]}>Driving today</Text>
        </View>
      );
    }
    return <CandyCta label="Drive this today" icon="car-sport" onPress={drive} busy={driving} tier={metal} height={52} radius={26} style={styles.primary} />;
  })();

  const canSpin = !!spinUrl;
  const spinTitle = centredCar ? carName(centredCar, settings, garage) : undefined;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={24} color={sk.accent} />
          </TouchableOpacity>
          {/* Centred across the whole row; never in the way of the back button's taps. */}
          <View style={styles.titleWrap} pointerEvents="none">
            <Text style={styles.title}>GARAGE</Text>
          </View>
          <View style={styles.headerRight}>
            <TierChip tier={viewTier} scansLeft={scansLeft} />
          </View>
        </View>

        <Stage
          slots={slots}
          index={centredIndex}
          onIndexChange={onIndexChange}
          onTapCentre={onTapCentre}
          metal={metal}
          labels={labels}
          renderSlot={renderSlot}
          renderBadge={renderBadge}
          overlay={scanJustReady ? (
            <ScanReadyOverlay
              onDismiss={() => {
                setScanJustReady(false);
                void updateSettings({ carScanCelebrated: true });
                router.push('/(app)/map');
              }}
            />
          ) : null}
        />

        <PlateStrip callSign={callSign} metal={metal} facts={facts} onPress={() => setCustomizeOpen(true)} />

        {primary}

        {viewTier === 'ultra' ? (
          <UpNextCard copy={up} variant="scan" metal={metal} onPress={goScan} />
        ) : (
          <UpNextCard copy={up} variant="upsell" metal={lockTier} lockTier={lockTier} onPress={openNextPaywall} />
        )}

        {/* Quiet actions — 360° spin only for the 3D cars (Gold / Ultra), wiring the full-screen viewer
            that nothing opened before (CarViewer3D). */}
        <View style={styles.actions}>
          {canSpin && (
            <TouchableOpacity style={styles.action} onPress={() => { Haptics.selectionAsync(); setViewer3D(true); }} activeOpacity={0.7}>
              <MaterialCommunityIcons name="rotate-3d-variant" size={21} color={sk.accent} />
              <Text style={[styles.actionText, { color: sk.accent }]}>360° spin</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.action}
            onPress={() => { Haptics.selectionAsync(); setCustomizeOpen(true); }}
            activeOpacity={0.7}
            disabled={!customizeCar}
          >
            <Ionicons name="color-palette-outline" size={20} color={sk.accent} />
            <Text style={[styles.actionText, { color: sk.accent }]}>Customize</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.action} onPress={() => { Haptics.selectionAsync(); void onShare(); }} activeOpacity={0.7}>
            <Ionicons name="share-outline" size={20} color={sk.accent} />
            <Text style={[styles.actionText, { color: sk.accent }]}>Share</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <CarViewer3D
        visible={viewer3D && canSpin}
        glbUrl={spinUrl}
        title={spinTitle}
        onClose={() => setViewer3D(false)}
      />

      <CustomizeSheet
        visible={customizeOpen}
        car={customizeCar}
        carName={customizeCar ? carName(customizeCar, settings, garage) : ''}
        isToday={!!customizeCar && customizeCar.id === activeId}
        metal={metal}
        onClose={() => setCustomizeOpen(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#000' },
  scroll: { paddingBottom: 60 },
  header: { height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  backBtn: { width: 44, height: 44, marginLeft: -10, alignItems: 'center', justifyContent: 'center' },
  titleWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  title: { color: '#F4FDFF', fontSize: 13, fontWeight: '800', letterSpacing: 3 },
  headerRight: { minWidth: 44, alignItems: 'flex-end' },
  primary: { marginHorizontal: 16, marginTop: 14 },
  today: {
    height: 52,
    borderRadius: 26,
    borderWidth: 1.5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  todayText: { fontSize: 16, fontWeight: '800' },
  actions: { flexDirection: 'row', marginTop: 6, marginHorizontal: 16 },
  action: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 5 },
  actionText: { fontSize: 12, fontWeight: '600' },
});
