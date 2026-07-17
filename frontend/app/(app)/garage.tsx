import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ImageBackground, SafeAreaView, Dimensions, TextInput, LayoutAnimation,
  Platform, UIManager, Image, ActivityIndicator, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { getSettings, updateSettings, getSelfMarkerType, getVehicleClass, getClassPaint, type VehicleClass } from '../../src/settings';
import { getVehiclePngOrDefault, CLASS_TOPDOWN } from '../../src/vehicleAssets';
import { TopDownClassSnap } from '../../src/ConvoyMapbox';
import { ClassSprite, PAINT_COLORS } from '../../src/classLayers';
import { useAuth } from '../../src/auth';
import { COLORS } from '../../src/theme';
import { api } from '../../src/api';
import { getGarageImage } from '../../src/carImages';
import { GlassFill } from '../../src/Glass';
import GlassBackdrop from '../../src/components/GlassBackdrop';
import { YEARS, getMakeNames, getModelsForMake, getColorsForModel } from '../../src/carDatabase';

const { width: SCREEN_W } = Dimensions.get('window');
const YELLOW = '#2DEC86';

// Photo avatars are parked until the backend upload endpoint + Supabase Storage
// exist (they need server-side work). Flip to true to re-enable the Photo option;
// the picker/upload code below is already wired for it.
const PHOTO_AVATAR_ENABLED = false;

// ---- "Class" map appearance ----
// Top-down vehicle classes. Hatchback previews with the GR Corolla asset; the
// rest use MCI glyph PLACEHOLDERS until Jeff's top-down class photos land.
const VEHICLE_CLASSES: { key: VehicleClass; label: string; icon: string }[] = [
  { key: 'hatchback',  label: 'Hatchback',  icon: 'car-hatchback' },
  { key: 'coupe',      label: 'Coupe',      icon: 'car-side' },
  { key: 'sports',     label: 'Sports',     icon: 'car-sports' },
  { key: 'exotic',     label: 'Exotic',     icon: 'car-convertible' },
  { key: 'sedan',      label: 'Sedan',      icon: 'car' },
  { key: 'truck',      label: 'Truck',      icon: 'car-pickup' },
  { key: 'electric',   label: 'Electric',   icon: 'car-electric' },
  { key: 'atv',        label: 'ATV',        icon: 'atv' },
  { key: 'motorcycle', label: 'Motorcycle', icon: 'motorbike' },
  { key: 'sxs',        label: 'SxS',        icon: 'go-kart' },
  { key: 'boat',       label: 'Boat',       icon: 'sail-boat' },
];
// Same palette as Settings → Route Color, per Jeff ("use the color swatch from
// the route line").
const CLASS_PRESETS = [
  '#2DEC86', '#0A84FF', '#00D6E0', '#5E5CE6', '#BF5CFF',
  '#FF2D95', '#FF3B30', '#FF9500', '#FFD60A', '#FFFFFF',
];

// Enable LayoutAnimation on Android for the smooth dropdown expand/collapse.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ---- Tap-to-expand dropdown (Year / Make / Model / Color) ----
type DropdownProps = {
  label: string;
  items: string[];
  selected: string;
  open: boolean;
  onToggle: () => void;
  onSelect: (val: string) => void;
  placeholder?: string;
  // Optional color swatch hex per item (used by the Color dropdown).
  swatchFor?: (val: string) => string | undefined;
};

function Dropdown({
  label, items, selected, open, onToggle, onSelect, placeholder, swatchFor,
}: DropdownProps) {
  const disabled = items.length === 0;
  const displayValue = selected || (placeholder ?? 'Select');
  const selectedSwatch = swatchFor?.(selected);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>

      {/* Collapsed field — tap to expand */}
      <TouchableOpacity
        style={[styles.fieldRow, open && styles.fieldRowOpen, disabled && styles.fieldRowDisabled]}
        activeOpacity={0.8}
        disabled={disabled}
        onPress={() => {
          if (disabled) return;
          Haptics.selectionAsync();
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          onToggle();
        }}
      >
        <GlassFill style={{ borderRadius: 16, overflow: 'hidden' }} />
        <View style={styles.fieldValueRow}>
          {selectedSwatch ? <View style={[styles.swatchDot, { backgroundColor: selectedSwatch }]} /> : null}
          <Text style={[styles.fieldValue, !selected && styles.fieldPlaceholder]}>
            {disabled ? (placeholder ?? 'Select above first') : displayValue}
          </Text>
        </View>
        <Ionicons
          name={open ? 'chevron-up' : 'chevron-down'}
          size={20}
          color={disabled ? '#444' : YELLOW}
        />
      </TouchableOpacity>

      {/* Expanded option list */}
      {open && !disabled ? (
        <View style={styles.optionList}>
          <GlassFill style={StyleSheet.absoluteFill} />
          {items.map((item) => {
            const isSel = item === selected;
            const sw = swatchFor?.(item);
            return (
              <TouchableOpacity
                key={item}
                style={[styles.optionRow, isSel && styles.optionRowSel]}
                activeOpacity={0.7}
                onPress={() => {
                  Haptics.selectionAsync();
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  onSelect(item);
                }}
              >
                <View style={styles.fieldValueRow}>
                  {sw ? <View style={[styles.swatchDot, { backgroundColor: sw }]} /> : null}
                  <Text style={[styles.optionText, isSel && styles.optionTextSel]}>{item}</Text>
                </View>
                {isSel ? <Ionicons name="checkmark" size={18} color={YELLOW} /> : null}
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
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
  // Auto-boat-on-water toggle (persists immediately; the map polls it live).
  const [autoBoat, setAutoBoat] = useState<boolean>(() => getSettings().autoBoatOnWater !== false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  // Which dropdown is currently expanded ('year' | 'make' | 'model' | 'color' | null).
  // Only one open at a time keeps the screen tidy.
  const [openField, setOpenField] = useState<string | null>(null);
  const toggle = (field: string) => setOpenField(prev => (prev === field ? null : field));

  const [saved, setSaved] = useState(false);

  const makes      = getMakeNames();
  const models     = make ? getModelsForMake(make).map(m => m.name) : [];
  const colors     = (make && model) ? getColorsForModel(make, model) : [];
  const colorNames = colors.map(c => c.name);
  const swatchFor  = (name: string) => colors.find(c => c.name === name)?.hex;

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
    const cl = s.carColor || user?.car_color || '';
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
    if (!s.carColor && user?.car_color) patch.carColor = user.car_color;
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

  const handleYear = (v: string) => { setYear(v); save({ carYear: v }); setOpenField(null); };

  const handleMake = (v: string) => {
    setMake(v); setModel(''); setColor('');
    save({ carMake: v, carModel: '', carColor: '' });
    setOpenField(null);
  };

  const handleModel = (v: string) => {
    setModel(v); setColor('');
    save({ carModel: v, carColor: '' });
    // Auto-select first color so the hero immediately shows a real photo
    const cols = getColorsForModel(make, v);
    if (cols.length > 0) {
      setColor(cols[0].name);
      save({ carModel: v, carColor: cols[0].name });
    }
    setOpenField(null);
  };

  // Color selection drives the hero image; collapse after pick.
  const handleColor = (v: string) => { setColor(v); save({ carColor: v }); setOpenField(null); };

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
    if (type === 'photo' && !avatarUrl) { pickAndUploadAvatar(); return; }
    applyMarkerType(type);
  };

  // ---- Paint actions (class + arrow) ----
  // Pick into the ACTIVE slot (primary/secondary); null = original / stock.
  const pickColor = useCallback((color: string | null, arrow: boolean) => {
    Haptics.selectionAsync();
    if (arrow) { (paintSlot === 'primary' ? setArrPriDraft : setArrSecDraft)(color); }
    else { (paintSlot === 'primary' ? setPriDraft : setSecDraft)(color); }
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
    const activeColor = paintSlot === 'primary' ? pri : sec;
    return (
      <>
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
        <Text style={styles.clsHint}>Have a paint code? Enter the hex — applies to the selected slot</Text>
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
        {/* Auto-boat: while driving ON WATER the map marker switches itself to
            the boat sprite (saved boat paint), and back on land. Class panel
            only — arrow has its own panel. */}
        {!arrow && (
          <TouchableOpacity
            style={styles.clsToggleRow}
            activeOpacity={0.8}
            onPress={() => {
              Haptics.selectionAsync();
              const next = !autoBoat;
              setAutoBoat(next);
              void updateSettings({ autoBoatOnWater: next });
            }}
          >
            <Ionicons name={autoBoat ? 'checkbox' : 'square-outline'} size={20} color={autoBoat ? '#2DEC86' : '#8E8E93'} />
            <Text style={styles.clsToggleText}>Auto-switch to boat on water</Text>
          </TouchableOpacity>
        )}
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

  const carImage = getGarageImage(make, model, color);
  const displayColor = colors.find(c => c.name === color);

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

        {/* Car hero — full-bleed image that fades to black (welcome-carousel
            style). No card/LED border; the photo melts into the page and the
            car name sits over the bottom fade for a premium showroom feel. */}
        <View style={styles.heroWrap}>
          <ImageBackground source={carImage} style={styles.heroBg} resizeMode="cover">
            {/* Subtle top vignette + strong bottom fade to black so the image
                blends into the #000 background like the onboarding slides. */}
            <LinearGradient
              colors={['rgba(0,0,0,0.55)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.4)', 'rgba(0,0,0,0.97)']}
              locations={[0, 0.28, 0.62, 1]}
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.heroCaption}>
              <Text style={styles.heroTitle}>
                {year && make && model ? `${year} ${make} ${model}` : 'Select your car'}
              </Text>
              {color ? (
                <View style={styles.heroColorRow}>
                  {displayColor && <View style={[styles.heroColorDot, { backgroundColor: displayColor.hex }]} />}
                  <Text style={styles.heroSub}>{color}</Text>
                </View>
              ) : (
                <Text style={styles.heroHint}>Pick your year, make & model below</Text>
              )}
            </View>
          </ImageBackground>
        </View>

        {/* Top speed badge */}
        {topSpeed ? (
          <View style={styles.speedCard}>
            <View style={styles.speedIcon}>
              <Ionicons name="speedometer" size={22} color={YELLOW} />
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
              style={[styles.apCard, markerType === 'arrow' && styles.apCardSel]}
              activeOpacity={0.85}
              onPress={() => handleAppearance('arrow')}
            >
              <Ionicons name="navigate" size={25} color={markerType === 'arrow' ? '#000' : YELLOW} />
              <Text style={[styles.apLabel, markerType === 'arrow' && styles.apLabelSel]}>Arrow</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.apCard, markerType === 'class' && styles.apCardSel]}
              activeOpacity={0.85}
              onPress={() => handleAppearance('class')}
            >
              <MaterialCommunityIcons name="car-hatchback" size={25} color={markerType === 'class' ? '#000' : YELLOW} />
              <Text style={[styles.apLabel, markerType === 'class' && styles.apLabelSel]}>Class</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.apCard, markerType === 'car' && styles.apCardSel]}
              activeOpacity={0.85}
              onPress={() => handleAppearance('car')}
            >
              <Ionicons name="car-sport" size={25} color={markerType === 'car' ? '#000' : YELLOW} />
              <Text style={[styles.apLabel, markerType === 'car' && styles.apLabelSel]}>3D</Text>
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
                  <Ionicons name="person-circle" size={26} color={markerType === 'photo' ? '#000' : YELLOW} />
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
                      {c.key === 'hatchback' ? (
                        // Top-down GR Corolla for Hatchback.
                        <Image source={getVehiclePngOrDefault(getSettings().carColor)} style={styles.clsTileImg} resizeMode="contain" />
                      ) : CLASS_TOPDOWN[c.key] ? (
                        // Real top-down class photo (keyed + nose-up).
                        <Image source={CLASS_TOPDOWN[c.key]} style={styles.clsTileImg} resizeMode="contain" />
                      ) : (
                        // Placeholder glyph until Jeff's photo lands for this class.
                        <MaterialCommunityIcons name={c.icon as any} size={26} color={sel ? '#000' : YELLOW} />
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
        <Dropdown
          label="Year"
          items={YEARS}
          selected={year}
          open={openField === 'year'}
          onToggle={() => toggle('year')}
          onSelect={handleYear}
        />

        <Dropdown
          label="Make"
          items={makes}
          selected={make}
          open={openField === 'make'}
          onToggle={() => toggle('make')}
          onSelect={handleMake}
          placeholder="Select a make"
        />

        <Dropdown
          label="Model"
          items={models}
          selected={model}
          open={openField === 'model'}
          onToggle={() => toggle('model')}
          onSelect={handleModel}
          placeholder="Select a make first"
        />

        {colorNames.length > 0 && (
          <Dropdown
            label="Color"
            items={colorNames}
            selected={color}
            open={openField === 'color'}
            onToggle={() => toggle('color')}
            onSelect={handleColor}
            placeholder="Select a color"
            swatchFor={swatchFor}
          />
        )}
        </>)}

        {/* Save */}
        <TouchableOpacity
          style={[styles.saveBtn, saved && styles.saveBtnDone]}
          activeOpacity={0.85}
          onPress={handleSave}
        >
          <Ionicons
            name={saved ? 'checkmark-circle' : 'save-outline'}
            size={20}
            color="#000"
            style={{ marginRight: 8 }}
          />
          <Text style={styles.saveBtnText}>{saved ? 'Saved' : 'Save'}</Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:               { flex: 1, backgroundColor: '#000' },
  scroll:             { paddingBottom: 60 },
  header:             { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },
  backBtn:            { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  title:              { color: '#F4F4F4', fontSize: 20, fontWeight: '600' },

  // Premium full-bleed hero — image fades to black (welcome-carousel style),
  // no card/LED border. The car name overlays the bottom fade.
  heroWrap:           { width: SCREEN_W, height: 240, marginBottom: 14, backgroundColor: '#000' },
  heroBg:             { flex: 1, justifyContent: 'flex-end' },
  heroCaption:        { paddingHorizontal: 24, paddingBottom: 22 },
  heroTitle:          { color: '#F4F4F4', fontSize: 26, fontWeight: '800', letterSpacing: -0.3 },
  heroColorRow:       { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 8 },
  heroColorDot:       { width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  heroSub:            { color: '#808080', fontSize: 15, fontWeight: '500' },
  heroHint:           { color: '#808080', fontSize: 14, marginTop: 6 },

  speedCard:          { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 16, backgroundColor: '#111', borderRadius: 16, padding: 14, gap: 12 },
  speedIcon:          { width: 44, height: 44, borderRadius: 12, backgroundColor: '#1A1A00', alignItems: 'center', justifyContent: 'center' },
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
  apCardSel:          { backgroundColor: YELLOW, borderColor: YELLOW },
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
