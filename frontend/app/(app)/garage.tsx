import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ImageBackground, SafeAreaView, Dimensions, TextInput, LayoutAnimation,
  Platform, UIManager,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { getSettings, updateSettings } from '../../src/settings';
import { COLORS } from '../../src/theme';
import { getGarageImage } from '../../src/carImages';
import { YEARS, getMakeNames, getModelsForMake, getColorsForModel } from '../../src/carDatabase';

const { width: SCREEN_W } = Dimensions.get('window');
const YELLOW = '#FFD60A';

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
  const [year,  setYear]  = useState('2025');
  const [make,  setMake]  = useState('');
  const [model, setModel] = useState('');
  const [color, setColor] = useState('');
  const [topSpeed, setTopSpeed] = useState<number | null>(null);
  const [callSign, setCallSign] = useState('');

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

  // Load saved settings
  useEffect(() => {
    const s = getSettings();
    if (s.carYear)  setYear(s.carYear);
    if (s.carMake)  setMake(s.carMake);
    if (s.carModel) setModel(s.carModel);
    if (s.carColor) setColor(s.carColor);
    if (s.topSpeed) setTopSpeed(s.topSpeed);
    if (s.callSign) setCallSign(s.callSign);
  }, []);

  const save = useCallback((updates: Record<string, any>) => {
    updateSettings(updates);
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

  // Explicit Save — selections already auto-save, but this confirms + persists
  // the call sign and gives clear feedback before returning.
  const handleSave = async () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await updateSettings({
      carYear: year,
      carMake: make,
      carModel: model,
      carColor: color,
      callSign: callSign.trim(),
    });
    setSaved(true);
    setTimeout(() => router.back(), 650);
  };

  const carImage = getGarageImage(make, model, color);
  const displayColor = colors.find(c => c.name === color);

  return (
    <SafeAreaView style={styles.safe}>
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
              placeholderTextColor="#555"
              maxLength={20}
              autoCapitalize="words"
              returnKeyType="done"
            />
          </View>
        </View>

        {/* Dropdowns */}
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
  title:              { color: '#fff', fontSize: 20, fontWeight: '600' },

  // Premium full-bleed hero — image fades to black (welcome-carousel style),
  // no card/LED border. The car name overlays the bottom fade.
  heroWrap:           { width: SCREEN_W, height: 240, marginBottom: 14, backgroundColor: '#000' },
  heroBg:             { flex: 1, justifyContent: 'flex-end' },
  heroCaption:        { paddingHorizontal: 24, paddingBottom: 22 },
  heroTitle:          { color: '#fff', fontSize: 26, fontWeight: '800', letterSpacing: -0.3 },
  heroColorRow:       { flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 8 },
  heroColorDot:       { width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  heroSub:            { color: '#ccc', fontSize: 15, fontWeight: '500' },
  heroHint:           { color: '#999', fontSize: 14, marginTop: 6 },

  speedCard:          { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 16, backgroundColor: '#111', borderRadius: 16, padding: 14, gap: 12 },
  speedIcon:          { width: 44, height: 44, borderRadius: 12, backgroundColor: '#1A1A00', alignItems: 'center', justifyContent: 'center' },
  speedLabel:         { color: '#fff', fontSize: 15, fontWeight: '600' },
  speedSub:           { color: '#666', fontSize: 12, marginTop: 2 },
  speedValue:         { color: '#FFD60A', fontSize: 28, fontWeight: '700' },
  speedUnit:          { color: '#888', fontSize: 12, alignSelf: 'flex-end', marginBottom: 4 },

  section:            { marginHorizontal: 16, marginBottom: 10 },
  sectionLabel:       { color: '#888', fontSize: 13, fontWeight: '500', marginBottom: 5, textTransform: 'uppercase', letterSpacing: 0.8 },

  // Collapsed field row (dropdown header + call-sign input share this)
  fieldRow:           { flexDirection: 'row', alignItems: 'center', minHeight: 50, borderRadius: 16, backgroundColor: '#111', paddingHorizontal: 16, borderWidth: 1, borderColor: '#1E1E1E' },
  fieldRowOpen:       { borderColor: 'rgba(255,214,10,0.4)', borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  fieldRowDisabled:   { opacity: 0.5 },
  fieldValueRow:      { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  fieldValue:         { color: '#fff', fontSize: 17, fontWeight: '600' },
  fieldPlaceholder:   { color: '#555', fontWeight: '400' },
  swatchDot:          { width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },

  // Expanded options
  optionList:         { backgroundColor: '#0E0E0E', borderBottomLeftRadius: 16, borderBottomRightRadius: 16, borderWidth: 1, borderTopWidth: 0, borderColor: 'rgba(255,214,10,0.4)', overflow: 'hidden' },
  optionRow:          { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 50, borderTopWidth: 1, borderTopColor: '#1A1A1A' },
  optionRowSel:       { backgroundColor: 'rgba(255,214,10,0.08)' },
  optionText:         { color: '#bbb', fontSize: 16 },
  optionTextSel:      { color: '#fff', fontWeight: '600' },

  // Call sign input
  callSignInput:      { flex: 1, color: '#fff', fontSize: 17, fontWeight: '600', paddingVertical: 14 },

  // Save button
  saveBtn:            { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginHorizontal: 16, marginTop: 8, height: 52, borderRadius: 16, backgroundColor: YELLOW },
  saveBtnDone:        { backgroundColor: '#4CD964' },
  saveBtnText:        { color: '#000', fontSize: 17, fontWeight: '700' },
});
