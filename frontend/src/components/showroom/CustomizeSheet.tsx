// showroom/CustomizeSheet.tsx — everything that used to be the Garage's long scroll, in one sheet
// (2026-09-22). Opened from the Showroom's "Customize" action (or the plate) for the car on the stage.
//
// KEPT EXACTLY, from the old app/(app)/garage.tsx (every write shape and backend PUT unchanged):
//   • CALL SIGN — saved ONLY by Save (no blur commit), maxLength 20: settings.callSign, then
//     PUT /auth/profile with the identity + {handle} (only when non-empty), then refresh() so the new
//     name takes effect app-wide. Errors swallowed, "Saved", then close after 650 ms (the old screen
//     navigated back instead — this is a sheet on the Garage now).
//   • YEAR / MAKE / MODEL / COLOR — free text, committed on blur (never per keystroke: each commit PUTs
//     the profile), mandatory ONLY where they are shown (the 3D cars) with the "Finish your car" alert
//     and the inline "X and Y required" hint. Limits 4 / 28 / 32 / 28.
//   • CLASS — the 8 offered classes; tapping one loads THAT class's saved paint (legacy classColors as
//     the primary) and resets to primary; the per-class real-paint palette (CLASS_SWATCHES) or the 20
//     generic swatches; one colour (no secondary slot). Save writes classPaint[class] (deleted when
//     both are empty) AND deletes the legacy classColors[class] so it cannot shadow the new paint.
//   • ARROW — Primary (body) / Secondary (rim) slots, the "original" chip, the generic 20 swatches;
//     arrowPaint is undefined when both are empty.
//   • HEX — exactly 6 hex digits with an optional '#', stored as uppercase '#RRGGBB'; anything else gets
//     the 'Invalid color code' alert. Arrow sheet → the active slot; class sheet → the class primary.
// CHANGED ON PURPOSE:
//   • ONE Save commits whatever the sheet shows — the arrow's own "Save Arrow" button is gone, as the
//     class panel's was (Jeff, 8/23: "just have the original save").
//   • Saving paint no longer writes selfMarkerType. The old panels only existed while that appearance
//     was already selected, so the write was always a no-op there; here you can paint a car you are
//     not driving, and saving must not switch cars behind your back — "Drive this today" does that.
//   • The identity of a car that is not today's car is remembered in the garage store, not settings
//     (settings + the backend profile carry today's car only — src/garageCars.ts).
//   • Drafts are seeded when the sheet OPENS, not at first render (the old screen read getSettings() at
//     mount and could seed from DEFAULT_SETTINGS if settings had not loaded yet).
//   • The 3D CLASS car (Gold's 4th spot) has no typed Year/Make/Model/Color any more: it gets a 3D CLASS PICKER
//     — Hot Hatch · Supercar · Exotic, and the five classes still to come as disabled "Coming soon" chips — and
//     that class's REAL bakes as its colours (Jeff, 2026-09-23: "in that section in customize it should have the
//     3d class car picker with colour options"). Save stores the choice in the garage store
//     (garageCars.setClass3dPick) and, when the 3D class car is ON THE ROAD (isToday — the Garage passes the
//     stage's own test, class3dOnMap), puts a CHANGED choice on the map (garageCars.applyClass3dToday: the class's
//     make/model and the bake's paint, the member's own identity kept aside) — settings only: peers draw it from live
//     presence, and the save's PUT /auth/profile leaves the car fields out while settings hold the class car (the
//     profile is the member's real car). A save that changed nothing writes no car. The typed fields stay for a scan.

import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { getClassPaint, getSettings, getVehicleClass, updateSettings, type VehicleClass } from "../../settings";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { COLORS } from "../../theme";
import { skin, type VisualTier } from "../../tierTheme";
import { withAlpha } from "../../appSkin";
import { GlassFill } from "../../Glass";
import { CandyCta } from "../CandyCta";
import { ClassSprite, PAINT_COLORS } from "../../classLayers";
import { CLASS_SWATCHES, classPaintName } from "../../classModels";
import { CLASS_TOPDOWN } from "../../vehicleAssets";
import { TopDownClassSnap } from "../../ConvoyMapbox";
import { getColorsForModel } from "../../carDatabase";
import { ensureGarageLoaded, getGarage } from "../../garageStore";
import {
  CLASS_3D_CARS,
  applyClass3dToday,
  carHasIdentity,
  class3dChoice,
  class3dPalette,
  identityFor,
  isClass3dKey,
  pinClass3dIfOnMap,
  rememberIdentity,
  saveIdentity,
  garageIsFor,
  settingsHoldClassCar,
  setClass3dPick,
  setNickname,
  type Class3dKey,
  type GarageCar,
} from "../../garageCars";
import { PressableScale } from "../../ui/PressableScale";
import { haptics } from "../../haptics";
import { CLASS_3D_PICKER, VEHICLE_CLASSES, classLabel } from "./labels";
import { Class3DStill } from "./CarArt";

// Check-mark contrast on an arbitrary palette hex (moved from garage.tsx).
const isLightHex = (hex: string) => {
  const n = parseInt(hex.replace("#", ""), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 160;
};

// ---- Typed identity field (Year / Make / Model / Color) — moved unchanged from garage.tsx ----
// Was a dropdown bound to carDatabase. Jeff, 2026-08-23: "it should be fillable from the user not a
// picker" — a scanned car can be ANY car, so a list of the few models we happen to ship is the wrong
// control entirely.
function TextField({
  label, value, onChangeText, onBlur, placeholder, keyboardType, maxLength, swatch,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  onBlur: () => void;
  placeholder?: string;
  keyboardType?: "default" | "number-pad";
  maxLength?: number;
  /** Hex for a leading colour dot, when the typed paint happens to be one we know. */
  swatch?: string;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.fieldRow}>
        <GlassFill style={{ borderRadius: 16, overflow: "hidden" }} />
        {swatch ? <View style={[styles.swatchDot, { backgroundColor: swatch, marginRight: 9 }]} /> : null}
        <TextInput
          style={styles.fieldInput}
          value={value}
          onChangeText={onChangeText}
          onBlur={onBlur}
          onEndEditing={onBlur}
          placeholder={placeholder}
          placeholderTextColor={COLORS.textDim}
          keyboardType={keyboardType ?? "default"}
          maxLength={maxLength}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="done"
          // Free text needs a way out — retyping a long model name because you fat-fingered one
          // character is the kind of small cruelty that makes people give up on a form.
          clearButtonMode="while-editing"
        />
      </View>
    </View>
  );
}

export default function CustomizeSheet({ visible, car, carName, isToday, metal, onClose }: {
  visible: boolean;
  /** The car being customized; null renders nothing (the Modal stays closed). */
  car: GarageCar | null;
  carName: string;
  /** Is this today's car — the car the map draws (the Garage's isTodays: the 3D class car only when the map
   *  draws its chosen bake)? Its identity lives in settings; any other car's in the garage store. */
  isToday: boolean;
  metal: VisualTier;
  onClose: () => void;
}) {
  const { user, refresh } = useAuth();
  const sk = skin(metal);

  const [callSign, setCallSign] = useState("");
  const [nickname, setNick] = useState("");
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [color, setColor] = useState("");
  const [vehClass, setVehClass] = useState<VehicleClass>("hatchback");
  const [paintSlot, setPaintSlot] = useState<"primary" | "secondary">("primary");
  const [priDraft, setPriDraft] = useState<string | null>(null);
  const [secDraft, setSecDraft] = useState<string | null>(null);
  const [arrPriDraft, setArrPriDraft] = useState<string | null>(null);
  const [arrSecDraft, setArrSecDraft] = useState<string | null>(null);
  const [hexDraft, setHexDraft] = useState("");
  // The 3D class car's draft: its class and the bake (GRCColorKey) within it.
  const [c3Cls, setC3Cls] = useState<Class3dKey>("hatchback");
  const [c3Key, setC3Key] = useState<string>("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const carId = car?.id;
  // Seed every draft from the live values each time the sheet opens for a car.
  useEffect(() => {
    if (!visible || !carId) return;
    const s = getSettings();
    const g = getGarage();
    setCallSign(s.callSign || user?.handle || "");
    setNick(g.nicknames[carId] ?? "");
    const id = identityFor(carId, s, g);
    setYear(id.year ?? "");
    setMake(id.make ?? "");
    setModel(id.model ?? "");
    setColor(id.color ?? "");
    setVehClass(getVehicleClass(s));
    const cp = getClassPaint(s);
    setPriDraft(cp.primary ?? null);
    setSecDraft(cp.secondary ?? null);
    setArrPriDraft(s.arrowPaint?.primary ?? null);
    setArrSecDraft(s.arrowPaint?.secondary ?? null);
    setPaintSlot("primary");
    setHexDraft("");
    const c3 = class3dChoice(s, g);
    setC3Cls(c3.cls);
    setC3Key(c3.modelKey);
    setSaved(false);
    setBusy(false);
    // user?.handle only seeds a blank call sign; re-seeding on a profile refresh mid-edit would wipe typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, carId]);

  const kind = car?.kind;
  const isArrow = kind === "arrow" || kind === "arrow3d";
  const isClass = kind === "class";
  const isClass3d = kind === "class3d";
  // The typed Year/Make/Model/Color: a scan's. The 3D class car's identity comes from its class picker.
  const showsIdentity = !!car && carHasIdentity(car) && !isClass3d;
  const c3Bakes = class3dPalette(c3Cls);
  const c3Bake = c3Bakes.find((e) => e.modelKey === c3Key) ?? c3Bakes[0];

  // Only used to put a colour dot next to a paint we happen to recognise.
  const knownColors = make && model ? getColorsForModel(make, model) : [];
  const swatchFor = (name: string) => knownColors.find((c) => c.name === name)?.hex;

  // Blur commits: today's car writes settings + the backend profile (the old save()); any other car
  // is remembered for when it is driven again.
  const commitIdentity = (patch: { year?: string; make?: string; model?: string; color?: string }) => {
    if (!carId) return;
    if (isToday) {
      const u: Record<string, string> = {};
      if (patch.year !== undefined) u.carYear = patch.year;
      if (patch.make !== undefined) u.carMake = patch.make;
      if (patch.model !== undefined) u.carModel = patch.model;
      if (patch.color !== undefined) u.carColor = patch.color;
      saveIdentity(u);
    } else {
      void rememberIdentity(carId, {
        year: year.trim(), make: make.trim(), model: model.trim(), color: color.trim(), ...patch,
      });
    }
  };

  const missingFields = showsIdentity
    ? ([["Year", year], ["Make", make], ["Model", model], ["Color", color]] as const)
        .filter(([, v]) => !v.trim()).map(([k]) => k)
    : [];
  const canSave = missingFields.length === 0;

  // ---- paint ----
  const pickColor = useCallback((c: string | null, arrow: boolean) => {
    Haptics.selectionAsync();
    if (arrow) (paintSlot === "primary" ? setArrPriDraft : setArrSecDraft)(c);
    else setPriDraft(c);   // class = single colour, always primary
  }, [paintSlot]);

  const applyHex = useCallback(() => {
    const raw = hexDraft.trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
      Alert.alert("Invalid color code", "Enter a 6-digit hex code, e.g. 2DEC86 or #FF453A.");
      return;
    }
    pickColor("#" + raw.toUpperCase(), isArrow);
    setHexDraft("");
  }, [hexDraft, pickColor, isArrow]);

  const saveClassPaint = async () => {
    // A new Silver class re-points an UNSTORED 3D class choice (its default follows the class): pin it first while
    // it is what the map draws, so the 3D spot never moves off the car on the road (garageCars.pinClass3dIfOnMap).
    await pinClass3dIfOnMap();
    const s = getSettings();
    const nextPaint = { ...(s.classPaint || {}) };
    if (priDraft || secDraft) nextPaint[vehClass] = { primary: priDraft ?? undefined, secondary: secDraft ?? undefined };
    else delete nextPaint[vehClass];
    // retire any legacy single-color entry so it can't shadow the new paint
    const legacy = { ...(s.classColors || {}) }; delete legacy[vehClass];
    await updateSettings({ vehicleClass: vehClass, classPaint: nextPaint, classColors: legacy });
  };

  const saveArrowPaint = async () => {
    await updateSettings({
      arrowPaint: (arrPriDraft || arrSecDraft) ? { primary: arrPriDraft ?? undefined, secondary: arrSecDraft ?? undefined } : undefined,
    });
  };

  const handleSave = async () => {
    if (!car || busy) return;
    if (!canSave) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert("Finish your car", `Add your ${missingFields.join(", ").replace(/, ([^,]*)$/, " and $1").toLowerCase()} first.`);
      return;
    }
    setBusy(true);
    if (isClass) await saveClassPaint();
    if (isArrow) await saveArrowPaint();
    // The 3D class choice is stored whichever car is today's — the Showroom's 3D spot shows it. A class with no
    // model yet can never get here (its chip is disabled), and setClass3dPick refuses one anyway. On the road, a
    // CHANGED choice goes on the map too (applyClass3dToday writes nothing when the map already draws it).
    const c3Saved = isClass3d && !!c3Bake && (await setClass3dPick(c3Cls, c3Bake.modelKey));
    if (c3Saved && isToday) await applyClass3dToday();
    await setNickname(car.id, nickname);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const sign = callSign.trim();
    if (showsIdentity && !isToday) {
      await rememberIdentity(car.id, { year: year.trim(), make: make.trim(), model: model.trim(), color: color.trim() });
    }
    // Today's identity: the drafts when this sheet is showing today's car (a scan); otherwise what settings hold —
    // unless settings hold the 3D class car's, which is not the member's car and never goes on the profile (peers
    // draw it from live presence; the profile keeps the real car — garageCars driveToday). Then only the call sign
    // is sent.
    const s = getSettings();
    const g = await ensureGarageLoaded();
    const typedToday = showsIdentity && isToday;
    // …nor while the garage store is still another account's (garageCars garageIsFor): settings are that account's car.
    const ident = typedToday
      ? { carYear: year, carMake: make, carModel: model, carColor: color }
      : settingsHoldClassCar(s, g) || !garageIsFor(g, user?.id)
        ? undefined
        : { carYear: s.carYear ?? "", carMake: s.carMake ?? "", carModel: s.carModel ?? "", carColor: s.carColor ?? "" };
    await updateSettings({ ...(typedToday ? ident : {}), callSign: sign });
    // Push the identity to the backend so peers render us correctly AND the call sign (= account
    // handle) persists to the account: it survives a reinstall and is the name other drivers see on the
    // map and in comms.
    try {
      await api.put("/auth/profile", {
        ...(ident ? {
          car_make: ident.carMake || undefined,
          car_model: ident.carModel || undefined,
          car_color: ident.carColor || undefined,
          car_year: parseInt(ident.carYear, 10) || undefined,
        } : {}),
        ...(sign ? { handle: sign } : {}),
      });
      // Refresh the in-memory auth user so the new call sign takes effect app-wide (map self-marker,
      // presence, Hub header) without a relaunch.
      await refresh();
    } catch {}
    setSaved(true);
    setTimeout(onClose, 650);
  };

  // ---- the paint picker (class + arrow) — moved from garage.tsx renderPaintPicker ----
  const renderPaintPicker = (arrow: boolean) => {
    const pri = arrow ? arrPriDraft : priDraft;
    const sec = arrow ? arrSecDraft : secDraft;
    // Class has no slot row, so its paint always lands on primary.
    const slot = arrow ? paintSlot : "primary";
    const activeColor = slot === "primary" ? pri : sec;
    // CLASS panels show the CLASS's own palette — real factory paints from that class's marques
    // (CLASS_SWATCHES; Jeff 2026-08-27). The arrow isn't a class, so it keeps the generic ramp.
    const entries: { name?: string; hex: string }[] =
      !arrow && CLASS_SWATCHES[vehClass]
        ? CLASS_SWATCHES[vehClass]!
        : PAINT_COLORS.map((hex) => ({ hex }));
    return (
      <>
        {/* Two paint slots are an ARROW thing (body + rim). A class sprite is one colour (Jeff 8/23). */}
        {arrow && (
          <View style={styles.slotRow}>
            {(["primary", "secondary"] as const).map((sl) => {
              const on = paintSlot === sl;
              const col = sl === "primary" ? pri : sec;
              return (
                <TouchableOpacity
                  key={sl}
                  style={[styles.slotBtn, on && { borderColor: sk.accent, backgroundColor: withAlpha(sk.accent, 0.1) }]}
                  activeOpacity={0.85}
                  onPress={() => { Haptics.selectionAsync(); setPaintSlot(sl); }}
                >
                  <View style={[styles.slotDot, { backgroundColor: col ?? "transparent", borderStyle: col ? "solid" : "dashed" }]} />
                  <Text style={[styles.slotText, on && styles.slotTextOn]}>{sl === "primary" ? "Primary" : "Secondary"}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
        <View style={styles.swatchRow}>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => pickColor(null, arrow)}
            style={[styles.swatch, { backgroundColor: "rgba(255,255,255,0.08)" }, activeColor === null && styles.swatchSel]}
            accessibilityLabel="Original paint"
          >
            <Ionicons name="ban-outline" size={15} color="#9A9A9E" />
          </TouchableOpacity>
          {entries.map(({ name, hex }) => {
            const active = (activeColor ?? "").toLowerCase() === hex.toLowerCase();
            return (
              <TouchableOpacity
                key={name ? name + hex : hex}
                activeOpacity={0.8}
                onPress={() => pickColor(hex, arrow)}
                style={[styles.swatch, { backgroundColor: hex }, active && styles.swatchSel]}
                accessibilityLabel={name ?? hex}
              >
                {active && <Ionicons name="checkmark" size={16} color={isLightHex(hex) ? "#000" : "#FFF"} />}
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={styles.hint}>Have a paint code? Enter the hex</Text>
        <View style={styles.hexRow}>
          <Text style={styles.hexHash}>#</Text>
          <TextInput
            style={styles.hexInput}
            value={hexDraft}
            onChangeText={setHexDraft}
            placeholder="2DEC86"
            placeholderTextColor="#606060"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={7}
            returnKeyType="done"
            onSubmitEditing={applyHex}
          />
          <TouchableOpacity style={[styles.hexApply, { backgroundColor: sk.accent }]} activeOpacity={0.85} onPress={applyHex}>
            <Text style={[styles.hexApplyText, { color: sk.ink }]}>Apply</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  };

  return (
    <Modal visible={visible && !!car} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, { borderColor: withAlpha(sk.accent, 0.35) }]}>
          <View style={styles.grabber} />
          <View style={styles.headRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.headKicker, { color: sk.accent }]}>CUSTOMIZE</Text>
              <Text style={styles.headTitle} numberOfLines={1}>{carName}</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={12} style={styles.close} accessibilityLabel="Close">
              <Ionicons name="close" size={22} color={COLORS.textDim} />
            </TouchableOpacity>
          </View>

          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Call sign — the plate on the Showroom. Saved only by Save, as it always was. */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Call Sign</Text>
              <View style={styles.fieldRow}>
                <Ionicons name="person-circle-outline" size={20} color={sk.accent} style={{ marginRight: 8 }} />
                <TextInput
                  style={styles.fieldInput}
                  value={callSign}
                  onChangeText={setCallSign}
                  placeholder="e.g. Maverick"
                  placeholderTextColor={COLORS.textDim}
                  maxLength={20}
                  autoCapitalize="words"
                  returnKeyType="done"
                />
              </View>
            </View>

            {/* Nickname — this car's name in your garage (this phone only; the map shows your call sign). */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>Nickname</Text>
              <View style={styles.fieldRow}>
                <Ionicons name="pricetag-outline" size={18} color={sk.accent} style={{ marginRight: 8 }} />
                <TextInput
                  style={styles.fieldInput}
                  value={nickname}
                  onChangeText={setNick}
                  placeholder={car ? `e.g. Daily` : ""}
                  placeholderTextColor={COLORS.textDim}
                  maxLength={24}
                  autoCapitalize="words"
                  returnKeyType="done"
                />
              </View>
            </View>

            {isArrow && (
              <View style={styles.panel}>
                <Text style={styles.hint}>Arrow paint — Primary is the body, Secondary is the rim</Text>
                {renderPaintPicker(true)}
              </View>
            )}

            {isClass && (
              <View style={styles.panel}>
                <Text style={styles.hint}>Pick your class — each remembers its own paint</Text>
                <View style={styles.clsGrid}>
                  {VEHICLE_CLASSES.map((c) => {
                    const sel = vehClass === c.key;
                    return (
                      <TouchableOpacity
                        key={c.key}
                        style={[styles.clsTile, sel && { borderColor: sk.rim, overflow: "hidden" }]}
                        activeOpacity={0.85}
                        onPress={() => {
                          Haptics.selectionAsync();
                          setVehClass(c.key);
                          const s = getSettings();
                          const p = s.classPaint?.[c.key] ?? (s.classColors?.[c.key] ? { primary: s.classColors[c.key] } : {});
                          setPriDraft(p.primary ?? null);
                          setSecDraft(p.secondary ?? null);
                          setPaintSlot("primary");
                        }}
                      >
                        {sel && (
                          <LinearGradient colors={sk.colors} locations={sk.locations} style={[StyleSheet.absoluteFill, { borderRadius: 13 }]} />
                        )}
                        {CLASS_TOPDOWN[c.key] ? (
                          <Image source={CLASS_TOPDOWN[c.key]} style={styles.clsTileImg} resizeMode="contain" />
                        ) : (
                          <MaterialCommunityIcons name={c.icon as any} size={26} color={sel ? sk.ink : sk.accent} />
                        )}
                        <Text style={[styles.clsTileLabel, sel && { color: sk.ink }]} numberOfLines={1}>{c.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {/* Live preview — the exact sprite the map draws, in the draft paint. */}
                <View style={styles.previewRow}>
                  {CLASS_TOPDOWN[vehClass] ? (
                    <ClassSprite vehicleClass={vehClass} primary={priDraft} secondary={secDraft} size={56} />
                  ) : (
                    <TopDownClassSnap color={priDraft ?? "#2DEC86"} />
                  )}
                  <Text style={styles.previewText}>
                    {classLabel(vehClass)} · {priDraft ? (classPaintName(vehClass, priDraft) ?? priDraft.toUpperCase()) : "Original"}
                    {secDraft ? ` / ${classPaintName(vehClass, secDraft) ?? secDraft.toUpperCase()}` : ""}
                  </Text>
                </View>

                {renderPaintPicker(false)}
              </View>
            )}

            {/* The 3D class car: which 3D class, and which of its real bakes. The classes Jeff has not scanned
                yet are listed, disabled, as "Coming soon". */}
            {isClass3d && c3Bake && (
              <View style={styles.panel}>
                <Text style={styles.hint}>Pick your 3D class — more classes are coming</Text>
                <View style={styles.clsGrid}>
                  {CLASS_3D_PICKER.map((c) => {
                    const sel = !c.soon && c3Cls === c.key;
                    return (
                      // hitSlop 0: 66 pt tall already, and 8 pt from the next chip — a 12 pt slop would take its edge
                      // (DESIGN.md §11.5).
                      <PressableScale
                        key={c.key}
                        style={[styles.clsTile, sel && { borderColor: sk.rim, overflow: "hidden" }, c.soon && styles.clsTileSoon]}
                        hitSlop={0}
                        disabled={c.soon}
                        accessibilityState={{ disabled: c.soon, selected: sel }}
                        accessibilityLabel={c.soon ? `${c.label}, coming soon` : c.label}
                        onPress={() => {
                          if (!isClass3dKey(c.key) || c.key === c3Cls) return;
                          haptics.tick();
                          const bakes = class3dPalette(c.key);
                          setC3Cls(c.key);
                          // Keep the colour when the new class has the same bake (it never does today); else its first.
                          setC3Key((bakes.find((e) => e.modelKey === c3Key) ?? bakes[0]).modelKey);
                        }}
                      >
                        {sel && (
                          <LinearGradient colors={sk.colors} locations={sk.locations} style={[StyleSheet.absoluteFill, { borderRadius: 13 }]} />
                        )}
                        {CLASS_TOPDOWN[c.key] ? (
                          <Image source={CLASS_TOPDOWN[c.key]} style={styles.clsTileImg} resizeMode="contain" />
                        ) : (
                          <MaterialCommunityIcons name={c.icon as any} size={26} color={sel ? sk.ink : sk.accent} />
                        )}
                        <Text style={[styles.clsTileLabel, sel && { color: sk.ink }]} numberOfLines={1}>{c.label}</Text>
                        {c.soon ? <Text style={styles.clsTileSoonText} numberOfLines={1}>Coming soon</Text> : null}
                      </PressableScale>
                    );
                  })}
                </View>

                {/* Preview — the stage's own still of this class, in this bake's paint. */}
                <View style={styles.previewRow}>
                  <Class3DStill cls={c3Cls} hex={c3Bake.hex} width={104} />
                  <Text style={styles.previewText}>
                    {classLabel(c3Cls)} · {CLASS_3D_CARS[c3Cls].make} {CLASS_3D_CARS[c3Cls].model} · {c3Bake.name}
                  </Text>
                </View>

                {/* The class's real bakes only — each one a GLB of its own, so no hex entry here. */}
                <View style={styles.swatchRow}>
                  {c3Bakes.map((e) => {
                    const active = e.modelKey === c3Bake.modelKey;
                    return (
                      // hitSlop 5: half the row's 10 pt gap — 42 pt to aim at without taking a neighbour's edge
                      // (DESIGN.md §11.5).
                      <PressableScale
                        key={e.modelKey}
                        hitSlop={5}
                        onPress={() => { if (!active) { haptics.tick(); setC3Key(e.modelKey); } }}
                        style={[styles.swatch, { backgroundColor: e.hex }, active && styles.swatchSel]}
                        accessibilityLabel={e.name}
                        accessibilityState={{ selected: active }}
                      >
                        {active && <Ionicons name="checkmark" size={16} color={isLightHex(e.hex) ? "#000" : "#FFF"} />}
                      </PressableScale>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Year / make / model / colour — a scan's (the 3D class car's come from its class picker). They
                feed the peer label, and a scan is filed against them. */}
            {showsIdentity && (
              <>
                <TextField
                  label="Year"
                  value={year}
                  onChangeText={setYear}
                  onBlur={() => commitIdentity({ year: year.trim() })}
                  placeholder="e.g. 2019"
                  keyboardType="number-pad"
                  maxLength={4}
                />
                <TextField
                  label="Make"
                  value={make}
                  onChangeText={setMake}
                  onBlur={() => commitIdentity({ make: make.trim() })}
                  placeholder="e.g. Subaru"
                  maxLength={28}
                />
                <TextField
                  label="Model"
                  value={model}
                  onChangeText={setModel}
                  onBlur={() => commitIdentity({ model: model.trim() })}
                  placeholder="e.g. WRX STI"
                  maxLength={32}
                />
                <TextField
                  label="Color"
                  value={color}
                  onChangeText={setColor}
                  onBlur={() => commitIdentity({ color: color.trim() })}
                  placeholder="e.g. World Rally Blue"
                  maxLength={28}
                  swatch={swatchFor(color)}
                />
              </>
            )}

            {/* Tell them WHICH field is missing — a dead Save with no reason loses people. */}
            {!canSave && (
              <Text style={styles.required}>
                {missingFields.join(", ").replace(/, ([^,]*)$/, " and $1")} required
              </Text>
            )}

            <CandyCta
              label={saved ? "Saved" : "Save"}
              icon={saved ? "checkmark-circle" : "save-outline"}
              onPress={handleSave}
              disabled={!canSave}
              busy={busy && !saved}
              tier={metal}
              style={styles.save}
            />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  sheet: {
    maxHeight: "88%",
    backgroundColor: COLORS.bgElev,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.18)", marginBottom: 6 },
  headRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 18, paddingBottom: 8 },
  headKicker: { fontSize: 11, fontWeight: "800", letterSpacing: 2 },
  headTitle: { color: COLORS.text, fontSize: 20, fontWeight: "800", marginTop: 2 },
  close: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  scroll: { paddingBottom: 40 },

  section: { marginHorizontal: 16, marginBottom: 10 },
  sectionLabel: { color: COLORS.textDim, fontSize: 13, fontWeight: "500", marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.8 },
  fieldRow: { flexDirection: "row", alignItems: "center", minHeight: 50, borderRadius: 16, paddingHorizontal: 16, borderWidth: 1, borderColor: "#1E1E1E" },
  fieldInput: { flex: 1, color: "#F4F4F4", fontSize: 17, fontWeight: "600", paddingVertical: 14 },
  swatchDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)" },

  panel: { marginHorizontal: 16, marginBottom: 12, marginTop: 4 },
  hint: { color: COLORS.textDim, fontSize: 12, fontWeight: "600", marginBottom: 8, marginTop: 4 },
  clsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  clsTile: { width: "23%", flexGrow: 1, height: 66, borderRadius: 13, borderWidth: 1, borderColor: "#1E1E1E", alignItems: "center", justifyContent: "center", gap: 4 },
  clsTileImg: { width: 40, height: 26 },
  clsTileLabel: { color: COLORS.textDim, fontSize: 10.5, fontWeight: "600" },
  clsTileSoon: { opacity: 0.45 },
  clsTileSoonText: { color: COLORS.textDim, fontSize: 9, fontWeight: "600", marginTop: -3 },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12, marginBottom: 4 },
  previewText: { color: "#F4F4F4", fontSize: 13, fontWeight: "700", flexShrink: 1 },
  slotRow: { flexDirection: "row", gap: 8, marginTop: 10, marginBottom: 2 },
  slotBtn: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 13, borderWidth: 1, borderColor: "#1E1E1E" },
  slotDot: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: "rgba(255,255,255,0.4)" },
  slotText: { color: COLORS.textDim, fontSize: 13, fontWeight: "700" },
  slotTextOn: { color: "#F4F4F4" },
  swatchRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 8 },
  swatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" },
  swatchSel: { borderWidth: 3, borderColor: "#FFFFFF" },
  hexRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  hexHash: { color: COLORS.textDim, fontSize: 16, fontWeight: "800" },
  hexInput: { flex: 1, height: 42, borderRadius: 13, borderWidth: 1, borderColor: "#1E1E1E", color: "#F4F4F4", paddingHorizontal: 12, fontSize: 15, fontWeight: "700", letterSpacing: 1 },
  hexApply: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 13 },
  hexApplyText: { fontWeight: "800", fontSize: 13 },

  required: { color: COLORS.warning, fontSize: 13, fontWeight: "600", textAlign: "center", marginTop: 6, marginHorizontal: 16 },
  save: { marginHorizontal: 16, marginTop: 12 },
});
