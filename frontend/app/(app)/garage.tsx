import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  SafeAreaView, Dimensions, TextInput,
  Image, ActivityIndicator, Alert,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { getSettings, updateSettings, getSelfMarkerType, getVehicleClass, getClassPaint, type VehicleClass } from '../../src/settings';
import { useFeature, useFeatureTier, openPaywall, TierCornerLock } from '../../src/PremiumBadge';
import { getVehiclePngOrDefault, CLASS_TOPDOWN } from '../../src/vehicleAssets';
import { TopDownClassSnap } from '../../src/ConvoyMapbox';
import { ClassSprite, PAINT_COLORS } from '../../src/classLayers';
import { useAuth } from '../../src/auth';
import { COLORS } from '../../src/theme';
import { api } from '../../src/api';
import CarViewer3D from '../../src/CarViewer3D';
import CarHero3D from '../../src/CarHero3D';
import GarageHeroCarousel from '../../src/GarageHeroCarousel';
import { CandyCta } from '../../src/components/CandyCta';
import { CANDY_RIM, CANDY_INK } from '../../src/components/ManeuverArrow';
import { skin, type VisualTier } from '../../src/tierTheme';
import { LinearGradient } from 'expo-linear-gradient';
import { resolveGRCKey, getVehicleModelUrl } from '../../src/vehicleAssets';
import { GlassFill } from '../../src/Glass';
import GlassBackdrop from '../../src/components/GlassBackdrop';
import { getColorsForModel } from '../../src/carDatabase';

const { width: SCREEN_W } = Dimensions.get('window');
const HERO_H = 300;   // one height for every hero page — the carousel cannot jump
const YELLOW = '#2DEC86';

// Photo avatars are parked until the backend upload endpoint + Supabase Storage
// exist (they need server-side work). Flip to true to re-enable the Photo option;
// the picker/upload code below is already wired for it.
const PHOTO_AVATAR_ENABLED = false;

// Paints that no longer exist and must never be restored from any source — not
// local settings, not the backend profile. "Widebody" was Jeff's own scanned car,
// retired 2026-08-23 ("remove the widebody and start fresh. including my car").
const RETIRED_COLORS = new Set<string>(['Widebody']);

// ---- "Class" map appearance ----
// Top-down vehicle classes. Hatchback previews with the GR Corolla asset; the
// rest use MCI glyph PLACEHOLDERS until Jeff's top-down class photos land.
const VEHICLE_CLASSES: { key: VehicleClass; label: string; icon: string }[] = [
  { key: 'hatchback',  label: 'Hot Hatch',  icon: 'car-hatchback' }, // storage key stays 'hatchback'
  { key: 'muscle',     label: 'Muscle',     icon: 'car-side' },
  { key: 'supercar',   label: 'Supercar',   icon: 'car-sports' },
  { key: 'exotic',     label: 'Exotic',     icon: 'car-convertible' },
  { key: 'sedan',      label: 'Sedan',      icon: 'car' },
  { key: 'truck',      label: 'Truck',      icon: 'car-pickup' },
  { key: 'electric',   label: 'Electric',   icon: 'car-electric' },
  { key: 'jeep',       label: 'Jeep',       icon: 'car-estate' },
  // Motorcycle / ATV / SxS / Boat pulled from the picker 8/20 (Jeff: parked for a future
  // release; the class ladder goes 3D and these have no 3D model planned).
  // The TYPES stay valid so anyone who already picked one keeps rendering.
];
// Same palette as Settings → Route Color, per Jeff ("use the color swatch from
// the route line").
const CLASS_PRESETS = [
  '#2DEC86', '#0A84FF', '#00D6E0', '#5E5CE6', '#BF5CFF',
  '#FF2D95', '#FF3B30', '#FF9500', '#FFD60A', '#FFFFFF',
];

// The candy fill as an absolute layer. Any tile/chip drops one in as its first
// child. `tier` picks the metal: the appearance tiles each wear their own —
// Arrow is free so it stays brand green, Class is Premium silver, 3D is Ultra
// gold (Jeff 8/23). The tile therefore states its price before you tap it.
function CandyFill({ radius, tier = 'brand' }: { radius?: number; tier?: VisualTier }) {
  const sk = skin(tier);
  return (
    <LinearGradient
      colors={sk.colors}
      locations={sk.locations}
      style={[StyleSheet.absoluteFill, radius ? { borderRadius: radius } : null]}
    />
  );
}

// ---- Typed identity field (Year / Make / Model / Color) ----
// Was a dropdown bound to carDatabase. Jeff, 2026-08-23: "it should be fillable
// from the user not a picker" — a scanned car can be ANY car, so a list of the
// few models we happen to ship is the wrong control entirely.
type TextFieldProps = {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  onBlur: () => void;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad';
  maxLength?: number;
  /** Hex for a leading colour dot, when the typed paint happens to be one we know. */
  swatch?: string;
};

function TextField({
  label, value, onChangeText, onBlur, placeholder, keyboardType, maxLength, swatch,
}: TextFieldProps) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <View style={styles.fieldRow}>
        <GlassFill style={{ borderRadius: 16, overflow: 'hidden' }} />
        {swatch ? <View style={[styles.swatchDot, { backgroundColor: swatch, marginRight: 9 }]} /> : null}
        <TextInput
          style={styles.fieldInput}
          value={value}
          onChangeText={onChangeText}
          onBlur={onBlur}
          onEndEditing={onBlur}
          placeholder={placeholder}
          placeholderTextColor="#808080"
          keyboardType={keyboardType ?? 'default'}
          maxLength={maxLength}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="done"
          // Free text needs a way out — retyping a long model name because you
          // fat-fingered one character is the kind of small cruelty that makes
          // people give up on a form.
          clearButtonMode="while-editing"
        />
      </View>
    </View>
  );
}

// ---- Main screen ----
export default function GarageScreen() {
  const router = useRouter();
  const { user, refresh } = useAuth();
  const [year,  setYear]  = useState('2025');
  const [make,  setMake]  = useState('');
  const [model, setModel] = useState('');
  const [color, setColor] = useState('');
  const [topSpeed, setTopSpeed] = useState<number | null>(null);
  const [callSign, setCallSign] = useState('');
  const classUnlocked = useFeature('class_marker');
  const car3dUnlocked = useFeature('car_3d');
  // Which metal each lock wears — read from the entitlement ladder so a re-rank
  // changes the badge automatically instead of drifting.
  const classTier = useFeatureTier('class_marker');   // premium -> silver H
  const car3dTier = useFeatureTier('car_3d');         // ultra   -> gold H
  // How the driver appears on the convoy map: arrow / class sprite / 3D car / photo.
  const [markerType, setMarkerType] = useState<'car' | 'arrow' | 'photo' | 'class'>('car');
  // Paint drafts (PRIMARY + SECONDARY slots; null = original / stock). The
  // class panel and the arrow panel each keep their own pair; Save commits.
  const [vehClass, setVehClass] = useState<VehicleClass>(getVehicleClass(getSettings()));
  const [paintSlot, setPaintSlot] = useState<'primary' | 'secondary'>('primary');
  const [priDraft, setPriDraft] = useState<string | null>(getClassPaint(getSettings()).primary ?? null);
  const [secDraft, setSecDraft] = useState<string | null>(getClassPaint(getSettings()).secondary ?? null);
  const [arrPriDraft, setArrPriDraft] = useState<string | null>(getSettings().arrowPaint?.primary ?? null);
  const [arrSecDraft, setArrSecDraft] = useState<string | null>(getSettings().arrowPaint?.secondary ?? null);
  const [classHexDraft, setClassHexDraft] = useState<string>('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  const [saved, setSaved] = useState(false);
  // Which hero page is showing. Kept in sync with markerType so the tiles below
  // and the carousel always agree.
  const [heroIndex, setHeroIndex] = useState(0);
  // markerType -> page. Selecting a tile below slides the carousel to match, so
  // the two controls can never disagree about what you have chosen.
  useEffect(() => {
    const i = markerType === 'arrow' ? 0 : markerType === 'class' ? 1 : 2;
    setHeroIndex(i);
  }, [markerType]);

  // Only used to put a colour dot next to a paint we happen to recognise. The
  // field itself accepts anything, so an unknown paint simply gets no dot.
  const colors    = (make && model) ? getColorsForModel(make, model) : [];
  const swatchFor = (name: string) => colors.find(c => c.name === name)?.hex;

  // Load saved settings — prefer locally-saved values, but fall back to the
  // backend profile so a fresh install / new build (local storage wiped) still
  // shows the car attached to the account instead of forcing a re-entry.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (user === undefined || hydratedRef.current) return; // wait for auth, run once
    hydratedRef.current = true;
    const s = getSettings();
    const y  = s.carYear  || (user?.car_year != null ? String(user.car_year) : '');
    const mk = s.carMake  || user?.car_make  || '';
    const md = s.carModel || user?.car_model || '';
    // Colour is free text, so it cannot be validated against a list — but a
    // RETIRED paint must still not come back. Clearing it locally is not enough:
    // the BACKEND profile still holds it and the patch below would write it
    // straight back, which is exactly how "Widebody" survived its own migration.
    const rawColor = s.carColor || user?.car_color || '';
    const cl = RETIRED_COLORS.has(rawColor) ? '' : rawColor;
    if (y)  setYear(y);
    if (mk) setMake(mk);
    if (md) setModel(md);
    if (cl) setColor(cl);
    if (s.topSpeed) setTopSpeed(s.topSpeed);
    else if (user?.top_speed_record) setTopSpeed(user.top_speed_record);
    if (s.callSign) setCallSign(s.callSign);
    else if (user?.handle) setCallSign(user.handle);
    // Appearance: local settings first, backend profile as fallback.
    setMarkerType(getSelfMarkerType(s));
    if (s.avatarUrl) setAvatarUrl(s.avatarUrl);
    else if ((user as any)?.avatar_url) setAvatarUrl((user as any).avatar_url);
    if (!s.selfMarkerType && (user as any)?.avatar_type) {
      setMarkerType((user as any).avatar_type);
      updateSettings({ selfMarkerType: (user as any).avatar_type });
    }

    // If local was empty but the profile had the car, persist it locally so the
    // rest of the app (map self-marker, presence) picks it up immediately too.
    const patch: Record<string, any> = {};
    if (!s.carMake  && user?.car_make)  patch.carMake  = user.car_make;
    if (!s.carModel && user?.car_model) patch.carModel = user.car_model;
    if (!s.carColor && cl) patch.carColor = cl;          // cl, not user.car_color — a retired paint must not come back
    if (s.carColor && !cl) patch.carColor = undefined;   // stored paint is dead — clear it so the picker reopens
    if (!s.carYear  && user?.car_year != null) patch.carYear = String(user.car_year);
    if (Object.keys(patch).length) updateSettings(patch);

    // One-time sync of any EXISTING local car identity up to the backend, so
    // users who picked their car before backend-sync existed get their paint
    // onto the map without having to re-select anything.
    if (s.carMake || s.carModel || s.carColor) {
      api.put('/auth/profile', {
        car_make: s.carMake || undefined,
        car_model: s.carModel || undefined,
        car_color: s.carColor || undefined,
        car_year: s.carYear ? (parseInt(s.carYear, 10) || undefined) : undefined,
      }).catch(() => {});
    }
  }, [user]);

  const save = useCallback((updates: Record<string, any>) => {
    updateSettings(updates);
    // Mirror car identity to the BACKEND profile so OTHER drivers see the
    // right paint/model on the map. Presence, /users/nearby AND the /location
    // broadcast all read the backend user doc — the Garage used to save only
    // locally, which is why a peer's car reverted to the default Heavy Metal
    // color the moment they started moving (live frames came from the backend,
    // which never knew the chosen color).
    const profile: Record<string, any> = {};
    if ('carMake' in updates) profile.car_make = updates.carMake;
    if ('carModel' in updates) profile.car_model = updates.carModel;
    if ('carColor' in updates) profile.car_color = updates.carColor;
    if ('carYear' in updates) { const y = parseInt(updates.carYear, 10); if (y) profile.car_year = y; }
    if (Object.keys(profile).length > 0) {
      api.put('/auth/profile', profile).catch(() => {});
    }
  }, []);

  // Year / Make / Model / Colour are TYPED, not picked (Jeff, 2026-08-23). A
  // dropdown limited to the handful of cars in carDatabase contradicts the whole
  // premise of scanning YOUR car — the 3D marker can be any car in the world, so
  // the identity fields have to accept any car in the world.
  //
  // Committed on blur rather than per keystroke: save() mirrors to the backend
  // profile, and one PUT per character would hammer it. The Save button commits
  // too, so a field left focused is not lost.
  const commitYear  = () => save({ carYear: year.trim() });
  const commitMake  = () => save({ carMake: make.trim() });
  const commitModel = () => save({ carModel: model.trim() });
  const commitColor = () => save({ carColor: color.trim() });

  // ---- Appearance (how you're drawn on the map: car / arrow / photo) ----
  // Persist the choice locally AND to the backend profile (avatar_type) so peers,
  // /users/nearby and the live /location broadcast all render you the same way —
  // exactly like carColor is mirrored above.
  const applyMarkerType = useCallback((type: 'car' | 'arrow' | 'photo' | 'class') => {
    Haptics.selectionAsync();
    setMarkerType(type);
    updateSettings({ selfMarkerType: type });
    api.put('/auth/profile', { avatar_type: type }).catch(() => {});
  }, []);

  // Photo mode: pick a square photo → send as base64 to the backend, which stores
  // it (Supabase Storage) and returns a hosted avatar_url. Same base64→profile
  // pattern the community logo/cover uploads already use.
  const pickAndUploadAvatar = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') {
        return Alert.alert('Photo access needed', 'Allow photo access to set a profile picture.');
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true, aspect: [1, 1], quality: 0.6, base64: true,
      });
      if (res.canceled || !res.assets?.[0]?.base64) return;
      const asset = res.assets[0];
      const mime = asset.mimeType || 'image/jpeg';
      const dataUri = `data:${mime};base64,${asset.base64}`;
      setUploadingAvatar(true);
      // Backend uploads to Supabase Storage and returns { avatar_url }.
      const r = await api.put('/auth/profile', { avatar_b64: dataUri, avatar_type: 'photo' });
      const url: string | undefined = r?.data?.avatar_url || r?.data?.user?.avatar_url;
      if (url) {
        setAvatarUrl(url);
        setMarkerType('photo');
        await updateSettings({ selfMarkerType: 'photo', avatarUrl: url });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        Alert.alert('Upload failed', 'Could not save your photo. Please try again.');
      }
    } catch {
      Alert.alert('Upload failed', 'Could not upload your photo. Please try again.');
    } finally {
      setUploadingAvatar(false);
    }
  }, []);

  // Tap an appearance option. Photo: if we don't have a picture yet, open the
  // picker; otherwise just switch back to the saved photo.
  const handleAppearance = (type: 'car' | 'arrow' | 'photo' | 'class') => {
    // Build-80 free tier: Class and 3D are premium (green arrow stays free).
    // No-ops while ENTITLEMENTS_ENFORCED is false.
    if (type === 'class' && !classUnlocked) { openPaywall('class_marker'); return; }
    if (type === 'car' && !car3dUnlocked) {
      // Jeff 8/20: locked 3D doesn't get the plain sheet — it opens the
      // Apple-style animated Ultra pitch (the Garage Scan experience).
      router.push('/(app)/garage-scan' as any);
      return;
    }
    if (type === 'photo' && !avatarUrl) { pickAndUploadAvatar(); return; }
    applyMarkerType(type);
  };

  // ---- Paint actions (class + arrow) ----
  // Pick into the ACTIVE slot (primary/secondary); null = original / stock.
  const pickColor = useCallback((color: string | null, arrow: boolean) => {
    Haptics.selectionAsync();
    if (arrow) { (paintSlot === 'primary' ? setArrPriDraft : setArrSecDraft)(color); }
    else { setPriDraft(color); }   // class = single colour, always primary
  }, [paintSlot]);
  const saveClassPaint = useCallback(async () => {
    const s = getSettings();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const nextPaint = { ...(s.classPaint || {}) };
    if (priDraft || secDraft) nextPaint[vehClass] = { primary: priDraft ?? undefined, secondary: secDraft ?? undefined };
    else delete nextPaint[vehClass];
    // retire any legacy single-color entry so it can't shadow the new paint
    const legacy = { ...(s.classColors || {}) }; delete legacy[vehClass];
    await updateSettings({ selfMarkerType: 'class', vehicleClass: vehClass, classPaint: nextPaint, classColors: legacy });
  }, [vehClass, priDraft, secDraft]);
  const saveArrowPaint = useCallback(async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await updateSettings({
      selfMarkerType: 'arrow',
      arrowPaint: (arrPriDraft || arrSecDraft) ? { primary: arrPriDraft ?? undefined, secondary: arrSecDraft ?? undefined } : undefined,
    });
  }, [arrPriDraft, arrSecDraft]);
  const applyClassHex = useCallback(() => {
    const raw = classHexDraft.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
      Alert.alert('Invalid color code', 'Enter a 6-digit hex code, e.g. 2DEC86 or #FF453A.');
      return;
    }
    pickColor('#' + raw.toUpperCase(), markerType === 'arrow');
    setClassHexDraft('');
  }, [classHexDraft, pickColor, markerType]);

  // Shared Primary/Secondary paint picker (class + arrow panels): two slot
  // buttons (each shows its current color dot), the 7-swatch palette + an
  // "Original/Stock" chip, and a hex field that applies to the ACTIVE slot.
  const renderPaintPicker = (arrow: boolean) => {
    const pri = arrow ? arrPriDraft : priDraft;
    const sec = arrow ? arrSecDraft : secDraft;
    // Class has no slot row, so its paint always lands on primary.
    const slot = arrow ? paintSlot : 'primary';
    const activeColor = slot === 'primary' ? pri : sec;
    return (
      <>
        {/* Two paint slots are an ARROW thing (body + rim). A class sprite is
            one colour, so the slot row was asking a question with one answer —
            removed for class (Jeff 8/23). */}
        {arrow && (
          <View style={styles.slotRow}>
            {(['primary', 'secondary'] as const).map((slot) => {
              const on = paintSlot === slot;
              const col = slot === 'primary' ? pri : sec;
              return (
                <TouchableOpacity key={slot} style={[styles.slotBtn, on && styles.slotBtnOn]} activeOpacity={0.85}
                  onPress={() => { Haptics.selectionAsync(); setPaintSlot(slot); }}>
                  <View style={[styles.slotDot, { backgroundColor: col ?? 'transparent', borderStyle: col ? 'solid' : 'dashed' }]} />
                  <Text style={[styles.slotText, on && styles.slotTextOn]}>
                    {slot === 'primary' ? 'Primary' : 'Secondary'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
        <View style={styles.clsSwatchRow}>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => pickColor(null, arrow)}
            style={[styles.clsSwatch, { backgroundColor: 'rgba(255,255,255,0.08)' }, activeColor === null && styles.clsSwatchSel]}
          >
            <Ionicons name="ban-outline" size={15} color="#9A9A9E" />
          </TouchableOpacity>
          {PAINT_COLORS.map((hex) => {
            const active = (activeColor ?? '').toLowerCase() === hex.toLowerCase();
            return (
              <TouchableOpacity
                key={hex}
                activeOpacity={0.8}
                onPress={() => pickColor(hex, arrow)}
                style={[styles.clsSwatch, { backgroundColor: hex }, active && styles.clsSwatchSel]}
              >
                {active && <Ionicons name="checkmark" size={16} color={hex === '#FFFFFF' || hex === '#FFD60A' ? '#000' : '#FFF'} />}
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={styles.clsHint}>Have a paint code? Enter the hex</Text>
        <View style={styles.clsHexRow}>
          <Text style={styles.clsHexHash}>#</Text>
          <TextInput
            style={styles.clsHexInput}
            value={classHexDraft}
            onChangeText={setClassHexDraft}
            placeholder="2DEC86"
            placeholderTextColor="#606060"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={7}
            returnKeyType="done"
            onSubmitEditing={applyClassHex}
          />
          <TouchableOpacity style={styles.clsHexSave} activeOpacity={0.85} onPress={applyClassHex}>
            <Text style={styles.clsSaveText}>Apply</Text>
          </TouchableOpacity>
        </View>
        {/* Arrow keeps its own Save; the CLASS paint commits through the main
            garage Save button below (Jeff: "just have the original save"). */}
        {arrow && (
          <TouchableOpacity style={styles.clsSaveBtn} activeOpacity={0.85} onPress={() => void saveArrowPaint()}>
            <Text style={styles.clsSaveText}>Save Arrow</Text>
          </TouchableOpacity>
        )}
      </>
    );
  };

  // Explicit Save — selections already auto-save, but this confirms + persists
  // the call sign and gives clear feedback before returning. In CLASS mode it
  // ALSO commits the paint drafts (the panel has no Save of its own — Jeff:
  // "just have the original save button").
  const handleSave = async () => {
    if (!canSave) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert('Finish your car', `Add your ${missingFields.join(', ').replace(/, ([^,]*)$/, ' and $1').toLowerCase()} first.`);
      return;
    }
    if (markerType === 'class') await saveClassPaint();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const sign = callSign.trim();
    await updateSettings({
      carYear: year,
      carMake: make,
      carModel: model,
      carColor: color,
      callSign: sign,
    });
    // Push the full identity to the backend so peers render us correctly AND
    // the call sign (= account handle) persists to the account: it survives a
    // reinstall and is the name other drivers see on the map and in comms.
    try {
      await api.put('/auth/profile', {
        car_make: make || undefined,
        car_model: model || undefined,
        car_color: color || undefined,
        car_year: parseInt(year, 10) || undefined,
        ...(sign ? { handle: sign } : {}),
      });
      // Refresh the in-memory auth user so the new call sign takes effect
      // app-wide (map self-marker, presence, Hub header) without a relaunch.
      await refresh();
    } catch {}
    setSaved(true);
    setTimeout(() => router.back(), 650);
  };

  const [viewer3D, setViewer3D] = useState(false);
  // The driver's OWN scanned car wins over the authored fleet model. Since the
  // widebody was retired there is no personal car baked into the app any more —
  // it comes from a scan or not at all.
  const [scanModelUrl, setScanModelUrl] = useState<string | null>(null);
  const [scanPending, setScanPending] = useState(false);
  useEffect(() => {
    (async () => {
      const s = await getSettings();
      setScanModelUrl(s.carScanModelUrl ?? null);
      setScanPending(s.carScanStatus === 'submitted');
    })();
  }, []);
  const heroModelUrl = (() => {
    if (scanModelUrl) return scanModelUrl;
    try {
      const k = resolveGRCKey(color);
      return k ? getVehicleModelUrl(color) : null;
    } catch { return null; }
  })();
  const displayColor = colors.find(c => c.name === color);

  // Year / Make / Model / Colour are MANDATORY (Jeff, 2026-08-23). They are what
  // peers see on the map and what a scan is filed against, so a half-filled car
  // is worse than none. Only enforced where the fields are actually shown —
  // Arrow and Class hide them, and blocking Save on invisible fields would be a
  // dead button with no explanation.
  const carFieldsShown = markerType !== 'arrow' && markerType !== 'class';
  const missingFields = carFieldsShown
    ? ([['Year', year], ['Make', make], ['Model', model], ['Color', color]] as const)
        .filter(([, v]) => !v.trim()).map(([k]) => k)
    : [];
  const canSave = missingFields.length === 0;

  return (
    <SafeAreaView style={styles.safe}>
      <GlassBackdrop source={require("../../assets/images/glass-bgt.png")} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={24} color={COLORS.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Garage</Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Car hero — what renders depends on the selected appearance:
              class → the high-res class sprite in the SAVED/draft paint,
                      rotated nose-LEFT (showroom profile pose)
              arrow → the Hairpin word logo
              3D car / photo → the original showroom image (untouched) */}
        {/* The hero is a SHOWROOM, not a preview of the one thing you own.
            Arrow / Class / your car sit side by side and you swipe between them
            — the locked ones render in full with the tier's H on top, because
            you cannot want what you cannot see (Jeff 8/23). */}
        <GarageHeroCarousel
          height={HERO_H}
          index={heroIndex}
          onIndexChange={(i) => setHeroIndex(i)}
          onSelect={(page) => {
            Haptics.selectionAsync();
            handleAppearance(page.key as 'arrow' | 'class' | 'car');
          }}
          pages={[
            {
              key: 'arrow',
              label: 'Arrow',
              tier: 'brand',
              render: () => (
                <View style={styles.heroPage}>
                  <Image
                    source={require('../../assets/images/hairpin-word.png')}
                    style={styles.heroWordLogo}
                    resizeMode="contain"
                  />
                </View>
              ),
            },
            {
              key: 'class',
              label: 'Class',
              tier: classTier,
              locked: !classUnlocked,
              render: () => (
                <View style={styles.heroPage}>
                  <View style={{ transform: [{ rotate: '-90deg' }] }}>
                    <ClassSprite vehicleClass={vehClass} primary={priDraft} secondary={secDraft} size={260} />
                  </View>
                </View>
              ),
            },
            {
              key: 'car',
              label: 'Your car',
              tier: car3dTier,
              locked: !car3dUnlocked,
              render: () => (
                <CarHero3D
                  glbUrl={heroModelUrl}
                  // Non-interactive INSIDE the carousel — a pager and a
                  // finger-spinnable model both want horizontal drags and the
                  // model wins, which would trap you on this page. It still
                  // auto-rotates; tap to spin it full screen.
                  interactive={false}
                  style={StyleSheet.absoluteFill}
                  emptyLabel={scanPending ? 'Building your car…' : 'No car yet'}
                  emptyHint={scanPending ? 'It appears here when it is ready' : 'Scan yours to put it on the map'}
                />
              ),
            },
          ]}
        />

        {/* Year / make / model / colour sit BELOW the car, not on top of it
            (Jeff 8/23: "move the year make model color under the car down so you
            see the whole car"). They used to be an absolute overlay with a fade
            behind them, which cropped the rear wheels on every model. */}
        {heroIndex === 2 && (
          <View style={styles.heroCaption}>
            <Text style={styles.heroTitle}>
              {year && make && model ? `${year} ${make} ${model}` : 'Your car'}
            </Text>
            {color ? (
              <View style={styles.heroColorRow}>
                {displayColor && <View style={[styles.heroColorDot, { backgroundColor: displayColor.hex }]} />}
                <Text style={styles.heroSub}>{color}</Text>
              </View>
            ) : (
              <Text style={styles.heroHint}>Fill in your year, make &amp; model below</Text>
            )}
          </View>
        )}

        <CarViewer3D
          visible={viewer3D}
          glbUrl={heroModelUrl}
          title={color || undefined}
          onClose={() => setViewer3D(false)}
        />

        {/* Top speed badge */}
        {topSpeed ? (
          <View style={styles.speedCard}>
            <View style={styles.speedIcon}>
              <CandyFill />
              <Ionicons name="speedometer" size={22} color={CANDY_INK} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.speedLabel}>Top Cruise Speed</Text>
              <Text style={styles.speedSub}>Personal best - beat it on your next drive.</Text>
            </View>
            <Text style={styles.speedValue}>{topSpeed}</Text>
            <Text style={styles.speedUnit}>km/h</Text>
          </View>
        ) : null}

        {/* Call sign */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Call Sign</Text>
          <View style={styles.fieldRow}>
            <Ionicons name="person-circle-outline" size={20} color={YELLOW} style={{ marginRight: 8 }} />
            <TextInput
              style={styles.callSignInput}
              value={callSign}
              onChangeText={setCallSign}
              placeholder="e.g. Maverick"
              placeholderTextColor="#808080"
              maxLength={20}
              autoCapitalize="words"
              returnKeyType="done"
            />
          </View>
        </View>

        {/* Map Appearance — how you're drawn on the live convoy map */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Map Appearance</Text>
          {/* Order per Jeff: Arrow · Class · 3D (3D slated to become premium). */}
          <View style={styles.apRow}>
            <TouchableOpacity
              style={[styles.apCard, markerType === 'arrow' && styles.apCardSel, markerType === 'arrow' && styles.apCardSelBrand]}
              activeOpacity={0.85}
              onPress={() => handleAppearance('arrow')}
            >
              {markerType === 'arrow' && <CandyFill tier="brand" />}
              <Ionicons name="navigate" size={25} color={markerType === 'arrow' ? skin('brand').ink : YELLOW} />
              <Text style={[styles.apLabel, markerType === 'arrow' && styles.apLabelSel]}>Arrow</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.apCard, markerType === 'class' && styles.apCardSel, markerType === 'class' && styles.apCardSelPremium]}
              activeOpacity={0.85}
              onPress={() => handleAppearance('class')}
            >
              {markerType === 'class' && <CandyFill tier="premium" />}
              <MaterialCommunityIcons name="car-hatchback" size={25} color={markerType === 'class' ? skin('premium').ink : skin('premium').accent} />
              <Text style={[styles.apLabel, markerType === 'class' && styles.apLabelSel]}>Class</Text>
              {!classUnlocked && <TierCornerLock tier={classTier} size={24} />}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.apCard, markerType === 'car' && styles.apCardSel, markerType === 'car' && styles.apCardSelUltra]}
              activeOpacity={0.85}
              onPress={() => handleAppearance('car')}
            >
              {markerType === 'car' && <CandyFill tier="ultra" />}
              <Ionicons name="car-sport" size={25} color={markerType === 'car' ? skin('ultra').ink : skin('ultra').accent} />
              <Text style={[styles.apLabel, markerType === 'car' && styles.apLabelSel]}>3D</Text>
              {!car3dUnlocked && <TierCornerLock tier={car3dTier} size={24} />}
            </TouchableOpacity>

            {PHOTO_AVATAR_ENABLED ? (
              <TouchableOpacity
                style={[styles.apCard, markerType === 'photo' && styles.apCardSel]}
                activeOpacity={0.85}
                onPress={() => handleAppearance('photo')}
                disabled={uploadingAvatar}
              >
                {uploadingAvatar ? (
                  <ActivityIndicator color={markerType === 'photo' ? '#000' : YELLOW} />
                ) : avatarUrl ? (
                  <Image source={{ uri: avatarUrl }} style={styles.apPhoto} />
                ) : (
                  <Ionicons name="person-circle" size={26} color={markerType === 'photo' ? CANDY_INK : YELLOW} />
                )}
                <Text style={[styles.apLabel, markerType === 'photo' && styles.apLabelSel]}>Photo</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {PHOTO_AVATAR_ENABLED && markerType === 'photo' && avatarUrl ? (
            <TouchableOpacity onPress={pickAndUploadAvatar} style={styles.apChange} activeOpacity={0.7}>
              <Ionicons name="camera-outline" size={15} color={YELLOW} />
              <Text style={styles.apChangeText}>Change photo</Text>
            </TouchableOpacity>
          ) : null}

          {/* Scan your car — the Ultra pitch. 3D ONLY: it advertises the
              exact-car scan, which has nothing to do with the arrow or a class
              sprite, and sat under both of them looking like a global action. */}
          {/* Follows the VISIBLE hero page, not the saved markerType — swiping
              changes what you are looking at, and this line has to belong to
              what is on screen or it reads as a global action again. */}
          {heroIndex === 2 && (
          <TouchableOpacity
            onPress={() => { Haptics.selectionAsync(); router.push('/(app)/garage-scan' as any); }}
            style={styles.apChange}
            activeOpacity={0.7}
          >
            <Ionicons name="scan-outline" size={15} color={YELLOW} />
            <Text style={styles.apChangeText}>Scan your car — build your real car in 3D</Text>
          </TouchableOpacity>
          )}

          {/* ---- Arrow panel: primary (body) + secondary (rim) paint ---- */}
          {markerType === 'arrow' && (
            <View style={styles.clsPanel}>
              <Text style={styles.clsHint}>Arrow paint — Primary is the body, Secondary is the rim</Text>
              {renderPaintPicker(true)}
            </View>
          )}

          {/* ---- Class panel: top-down class picker + per-class paint ---- */}
          {markerType === 'class' && (
            <View style={styles.clsPanel}>
              <Text style={styles.clsHint}>Pick your class — each remembers its own paint</Text>
              <View style={styles.clsGrid}>
                {VEHICLE_CLASSES.map((c) => {
                  const sel = vehClass === c.key;
                  return (
                    <TouchableOpacity
                      key={c.key}
                      style={[styles.clsTile, sel && styles.clsTileSel]}
                      activeOpacity={0.85}
                      onPress={() => {
                        Haptics.selectionAsync();
                        setVehClass(c.key);
                        const p = getSettings().classPaint?.[c.key] ?? (getSettings().classColors?.[c.key] ? { primary: getSettings().classColors![c.key] } : {});
                        setPriDraft(p.primary ?? null);
                        setSecDraft(p.secondary ?? null);
                        setPaintSlot('primary');
                      }}
                    >
                      {CLASS_TOPDOWN[c.key] ? (
                        // Real top-down class photo (keyed + nose-up).
                        <Image source={CLASS_TOPDOWN[c.key]} style={styles.clsTileImg} resizeMode="contain" />
                      ) : (
                        // Placeholder glyph until Jeff's photo lands for this class.
                        <MaterialCommunityIcons name={c.icon as any} size={26} color={sel ? CANDY_INK : YELLOW} />
                      )}
                      <Text style={[styles.clsTileLabel, sel && styles.clsTileLabelSel]} numberOfLines={1}>{c.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Live preview — the exact sprite the map draws, in the draft paint. */}
              <View style={styles.clsPreviewRow}>
                {CLASS_TOPDOWN[vehClass] ? (
                  <ClassSprite vehicleClass={vehClass} primary={priDraft} secondary={secDraft} size={56} />
                ) : (
                  <TopDownClassSnap color={priDraft ?? '#2DEC86'} />
                )}
                <Text style={styles.clsPreviewText}>
                  {VEHICLE_CLASSES.find((c) => c.key === vehClass)?.label} · {priDraft ? priDraft.toUpperCase() : 'Original'}{secDraft ? ` / ${secDraft.toUpperCase()}` : ''}
                </Text>
              </View>

              {renderPaintPicker(false)}
            </View>
          )}
        </View>

        {/* Dropdowns — the car identity (feeds the 3D GRC + peer rendering).
            Shown ONLY in 3D mode (Jeff 2026-07-17): Arrow and Class replace
            them with the primary/secondary paint picker. */}
        {markerType !== 'arrow' && markerType !== 'class' && (<>
        <TextField
          label="Year"
          value={year}
          onChangeText={setYear}
          onBlur={commitYear}
          placeholder="e.g. 2019"
          keyboardType="number-pad"
          maxLength={4}
        />

        <TextField
          label="Make"
          value={make}
          onChangeText={setMake}
          onBlur={commitMake}
          placeholder="e.g. Subaru"
          maxLength={28}
        />

        <TextField
          label="Model"
          value={model}
          onChangeText={setModel}
          onBlur={commitModel}
          placeholder="e.g. WRX STI"
          maxLength={32}
        />

        <TextField
          label="Color"
          value={color}
          onChangeText={setColor}
          onBlur={commitColor}
          placeholder="e.g. World Rally Blue"
          maxLength={28}
          swatch={swatchFor(color)}
        />
        </>)}

        {/* Tell them WHICH field is missing — a dead Save button with no reason
            is the most common way a form loses someone. */}
        {!canSave && (
          <Text style={styles.requiredHint}>
            {missingFields.join(', ').replace(/, ([^,]*)$/, ' and $1')} required
          </Text>
        )}

        {/* Save — the map banner's candy gradient (Jeff 8/23) */}
        <CandyCta
          label={saved ? 'Saved' : 'Save'}
          icon={saved ? 'checkmark-circle' : 'save-outline'}
          onPress={handleSave}
          disabled={!canSave}
          style={styles.saveCta}
        />

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  heroPage:           { width: SCREEN_W, height: HERO_H, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  saveCta:            { marginHorizontal: 16, marginTop: 8, marginBottom: 28 },
  requiredHint:       { color: COLORS.warning, fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: 14, marginHorizontal: 16 },
  badge360: {
    position: 'absolute', top: 14, right: 14,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: COLORS.brand, borderRadius: 999,
    paddingHorizontal: 9, paddingVertical: 4,
  },
  badge360Text: { color: '#04150B', fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  safe:               { flex: 1, backgroundColor: '#000' },
  scroll:             { paddingBottom: 60 },
  header:             { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },
  backBtn:            { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title:              { color: '#F4F4F4', fontSize: 20, fontWeight: '600' },

  // Premium full-bleed hero — image fades to black (welcome-carousel style),
  // no card/LED border. The car name overlays the bottom fade.
  heroWrap:           { width: SCREEN_W, height: 260, marginBottom: 0, backgroundColor: '#000' },
  // heroTall: the class-sprite / arrow-logo hero fills most of the screen
  heroTall:           { width: SCREEN_W, height: 430, marginBottom: 14, backgroundColor: '#000' },
  heroAlt:            { alignItems: 'center', justifyContent: 'center' },
  heroWordLogo:       { width: '94%', height: 240 },
  heroBg:             { flex: 1, justifyContent: 'flex-end' },
  // Normal flow, UNDER the hero — never an overlay, so it can't cover the car.
  heroCaption:        { paddingHorizontal: 24, paddingTop: 2, paddingBottom: 18 },
  heroTitle:          { color: '#F4F4F4', fontSize: 26, fontWeight: '800', letterSpacing: -0.3 },
  heroColorRow:       { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 8 },
  heroColorDot:       { width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  heroSub:            { color: '#808080', fontSize: 15, fontWeight: '500' },
  heroHint:           { color: '#808080', fontSize: 14, marginTop: 6 },

  speedCard:          { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 16, backgroundColor: '#111', borderRadius: 16, padding: 14, gap: 12 },
  speedIcon:          { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 1, borderColor: CANDY_RIM },
  speedLabel:         { color: '#F4F4F4', fontSize: 15, fontWeight: '600' },
  speedSub:           { color: '#808080', fontSize: 12, marginTop: 2 },
  speedValue:         { color: '#2DEC86', fontSize: 28, fontWeight: '700' },
  speedUnit:          { color: '#808080', fontSize: 12, alignSelf: 'flex-end', marginBottom: 4 },

  section:            { marginHorizontal: 16, marginBottom: 10 },
  sectionLabel:       { color: '#808080', fontSize: 13, fontWeight: '500', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.8 },

  // Collapsed field row (dropdown header + call-sign input share this)
  fieldRow:           { flexDirection: 'row', alignItems: 'center', minHeight: 50, borderRadius: 16, backgroundColor: 'transparent', paddingHorizontal: 16, borderWidth: 1, borderColor: '#1E1E1E' },
  fieldRowOpen:       { borderColor: 'rgba(45,236,134,0.4)', borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  fieldRowDisabled:   { opacity: 0.5 },
  fieldValueRow:      { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  fieldValue:         { color: '#F4F4F4', fontSize: 17, fontWeight: '600' },
  fieldInput:         { flex: 1, color: '#F4F4F4', fontSize: 17, fontWeight: '600', paddingVertical: 14 },
  fieldPlaceholder:   { color: '#808080', fontWeight: '400' },
  swatchDot:          { width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },

  // Expanded options
  optionList:         { backgroundColor: 'transparent', borderBottomLeftRadius: 16, borderBottomRightRadius: 16, borderWidth: 1, borderTopWidth: 0, borderColor: 'rgba(45,236,134,0.4)', overflow: 'hidden' },
  optionRow:          { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 50, borderTopWidth: 1, borderTopColor: '#1A1A1A' },
  optionRowSel:       { backgroundColor: 'rgba(45,236,134,0.08)' },
  optionText:         { color: '#808080', fontSize: 16 },
  optionTextSel:      { color: '#F4F4F4', fontWeight: '600' },

  // Call sign input
  callSignInput:      { flex: 1, color: '#F4F4F4', fontSize: 17, fontWeight: '600', paddingVertical: 14 },

  // Map appearance selector (3D car / arrow / photo)
  apRow:              { flexDirection: 'row', gap: 10 },
  // ---- Class panel ----
  clsPanel:           { marginTop: 12 },
  clsHint:            { color: '#808080', fontSize: 12, fontWeight: '600', marginBottom: 8, marginTop: 4 },
  clsGrid:            { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  clsTile:            { width: '23%', flexGrow: 1, height: 66, borderRadius: 13, borderWidth: 1, borderColor: '#1E1E1E', alignItems: 'center', justifyContent: 'center', gap: 4 },
  clsTileSel:         { backgroundColor: YELLOW, borderColor: YELLOW },
  clsTileImg:         { width: 40, height: 26 },
  clsTileLabel:       { color: '#808080', fontSize: 10.5, fontWeight: '600' },
  clsTileLabelSel:    { color: '#000' },
  clsPreviewRow:      { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12, marginBottom: 4 },
  clsPreviewText:     { color: '#F4F4F4', fontSize: 13, fontWeight: '700' },
  clsSwatchRow:       { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 8 },
  slotRow:            { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 2 },
  slotBtn:            { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 13, borderWidth: 1, borderColor: '#1E1E1E' },
  slotBtnOn:          { borderColor: YELLOW, backgroundColor: 'rgba(45,236,134,0.10)' },
  slotDot:            { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)' },
  slotText:           { color: '#808080', fontSize: 13, fontWeight: '700' },
  slotTextOn:         { color: '#F4F4F4' },
  clsSwatch:          { width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' },
  clsSwatchSel:       { borderWidth: 3, borderColor: '#FFFFFF' },
  clsSaveBtn:         { marginTop: 12, alignSelf: 'flex-start', paddingHorizontal: 18, paddingVertical: 10, borderRadius: 13, backgroundColor: YELLOW },
  clsSaveText:        { color: '#000', fontWeight: '800', fontSize: 13 },
  clsHexRow:          { flexDirection: 'row', alignItems: 'center', gap: 8 },
  clsToggleRow:       { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  clsToggleText:      { color: '#E5E5EA', fontSize: 13, fontWeight: '600' },
  clsHexHash:         { color: '#808080', fontSize: 16, fontWeight: '800' },
  clsHexInput:        { flex: 1, height: 42, borderRadius: 13, borderWidth: 1, borderColor: '#1E1E1E', color: '#F4F4F4', paddingHorizontal: 12, fontSize: 15, fontWeight: '700', letterSpacing: 1 },
  clsHexSave:         { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 13, backgroundColor: YELLOW },
  apCard:             { flex: 1, height: 86, borderRadius: 16, borderWidth: 1, borderColor: '#1E1E1E', alignItems: 'center', justifyContent: 'center', gap: 7 },
  apCardSel:          { overflow: 'hidden' },
  apCardSelBrand:     { borderColor: CANDY_RIM },
  apCardSelPremium:   { borderColor: 'rgba(255,255,255,0.62)' },
  apCardSelUltra:     { borderColor: 'rgba(255,231,163,0.62)' },
  apLabel:            { color: '#808080', fontSize: 13, fontWeight: '600' },
  apLabelSel:         { color: '#000', fontWeight: '800' },
  apPhoto:            { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(0,0,0,0.25)' },
  apChange:           { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 8, paddingVertical: 4 },
  apChangeText:       { color: YELLOW, fontSize: 13, fontWeight: '600' },

  // Save button
  saveBtn:            { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginHorizontal: 16, marginTop: 8, height: 52, borderRadius: 16, backgroundColor: YELLOW },
  saveBtnDone:        { backgroundColor: '#4CD964' },
  saveBtnText:        { color: '#000', fontSize: 17, fontWeight: '700' },
});
