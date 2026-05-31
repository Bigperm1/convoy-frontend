import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Image, SafeAreaView, Dimensions, FlatList, ViewToken,
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
const ITEM_H = 52;
const VISIBLE = 3;
const PICKER_H = ITEM_H * VISIBLE;

// ââ Drum-roll picker âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
type PickerProps = {
  items: string[];
  selected: string;
  onSelect: (val: string) => void;
  placeholder?: string;
};

function DrumPicker({ items, selected, onSelect, placeholder }: PickerProps) {
  const listRef = useRef<FlatList>(null);
  const selectedIdx = items.indexOf(selected);
  const lastIdx = useRef(selectedIdx);

  useEffect(() => {
    if (selectedIdx >= 0) {
      listRef.current?.scrollToIndex({ index: selectedIdx, animated: true, viewPosition: 0.5 });
    }
  }, [selectedIdx]);

  const onViewableChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    if (viewableItems.length === 0) return;
    const midItem = viewableItems[Math.floor(viewableItems.length / 2)];
    if (!midItem || midItem.index === null) return;
    const newIdx = midItem.index;
    if (newIdx !== lastIdx.current) {
      lastIdx.current = newIdx;
      Haptics.selectionAsync();
      onSelect(items[newIdx]);
    }
  }).current;

  if (items.length === 0) {
    return (
      <View style={styles.pickerEmpty}>
        <Text style={styles.pickerEmptyText}>{placeholder ?? 'Select above first'}</Text>
      </View>
    );
  }

  return (
    <View style={styles.pickerWrap}>
      <View style={styles.pickerHighlight} pointerEvents="none" />
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => item}
        snapToInterval={ITEM_H}
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingVertical: ITEM_H }}
        onViewableItemsChanged={onViewableChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        renderItem={({ item }) => {
          const isSelected = item === selected;
          return (
            <TouchableOpacity
              style={styles.pickerItem}
              onPress={() => {
                Haptics.selectionAsync();
                onSelect(item);
                const idx = items.indexOf(item);
                listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
              }}
              activeOpacity={0.7}
            >
              <Text style={[styles.pickerItemText, isSelected && styles.pickerItemSelected]}>
                {item}
              </Text>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

// ââ Color swatch row âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
type ColorPickerProps = {
  colors: { name: string; hex: string }[];
  selected: string;
  onSelect: (name: string) => void;
};

function ColorPicker({ colors, selected, onSelect }: ColorPickerProps) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.colorRow}>
      {colors.map((c) => {
        const isSelected = c.name === selected;
        return (
          <TouchableOpacity
            key={c.name}
            style={[styles.swatchWrap, isSelected && styles.swatchSelected]}
            onPress={() => {
              Haptics.selectionAsync();
              onSelect(c.name);
            }}
            activeOpacity={0.8}
          >
            <View style={[styles.swatch, { backgroundColor: c.hex }]} />
            <Text style={[styles.swatchLabel, isSelected && styles.swatchLabelSelected]} numberOfLines={1}>
              {c.name}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

// ââ Main screen ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
export default function GarageScreen() {
  const router = useRouter();
  const [year,  setYear]  = useState('2025');
  const [make,  setMake]  = useState('');
  const [model, setModel] = useState('');
  const [color, setColor] = useState('');
  const [topSpeed, setTopSpeed] = useState<number | null>(null);

  const makes   = getMakeNames();
  const models  = make  ? getModelsForMake(make).map(m => m.name)  : [];
  const colors  = (make && model) ? getColorsForModel(make, model) : [];

  // Load saved settings
  useEffect(() => {
    const s = getSettings();
    if (s.carYear)  setYear(s.carYear);
    if (s.carMake)  setMake(s.carMake);
    if (s.carModel) setModel(s.carModel);
    if (s.carColor) setColor(s.carColor);
    if (s.topSpeed) setTopSpeed(s.topSpeed);
  }, []);

  // Save on any change
  const save = useCallback((updates: Record<string, any>) => {
    updateSettings(updates);
  }, []);

  const handleYear = (v: string) => { setYear(v);  save({ carYear: v }); };
  const handleMake = (v: string) => {
    setMake(v); setModel(''); setColor('');
    save({ carMake: v, carModel: '', carColor: '' });
  };
  const handleModel = (v: string) => {
    setModel(v); setColor('');
    save({ carModel: v, carColor: '' });
    // Auto-select first color
    const cols = getColorsForModel(make, v);
    if (cols.length > 0) {
      setColor(cols[0].name);
      save({ carModel: v, carColor: cols[0].name });
    }
  };
  const handleColor = (v: string) => { setColor(v); save({ carColor: v }); };

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

        {/* Car hero card */}
        <View style={styles.heroCard}>
          <View style={styles.heroLedBorder} pointerEvents="none" />
          <LinearGradient
            colors={['#1A1A1A', '#0D0D0D']}
            style={styles.heroGradient}
          >
            <Image
              source={carImage}
              style={styles.heroImage}
              resizeMode="contain"
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
              ) : null}
            </View>
          </LinearGradient>
        </View>

        {/* Top speed badge */}
        {topSpeed ? (
          <View style={styles.speedCard}>
            <View style={styles.speedIcon}>
              <Ionicons name="speedometer" size={22} color="#FFD60A" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.speedLabel}>Top Cruise Speed</Text>
              <Text style={styles.speedSub}>Personal best â beat it on your next drive.</Text>
            </View>
            <Text style={styles.speedValue}>{topSpeed}</Text>
            <Text style={styles.speedUnit}>km/h</Text>
          </View>
        ) : null}

        {/* Pickers */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Year</Text>
          <DrumPicker items={YEARS} selected={year} onSelect={handleYear} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Make</Text>
          <DrumPicker items={makes} selected={make} onSelect={handleMake} placeholder="Select a year first" />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Model</Text>
          <DrumPicker items={models} selected={model} onSelect={handleModel} placeholder="Select a make first" />
        </View>

        {colors.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>Color</Text>
            <ColorPicker colors={colors} selected={color} onSelect={handleColor} />
          </View>
        )}

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

  heroCard:           { marginHorizontal: 16, marginBottom: 16, borderRadius: 24, overflow: 'hidden', position: 'relative' },
  heroLedBorder:      { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 24, borderWidth: 1.5, borderColor: 'rgba(255,214,10,0.5)', zIndex: 2 },
  heroGradient:       { padding: 20, alignItems: 'center', minHeight: 260 },
  heroImage:          { width: SCREEN_W - 72, height: 200 },
  heroCaption:        { alignItems: 'center', marginTop: 8 },
  heroTitle:          { color: '#fff', fontSize: 18, fontWeight: '700' },
  heroColorRow:       { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 6 },
  heroColorDot:       { width: 10, height: 10, borderRadius: 5 },
  heroSub:            { color: '#888', fontSize: 14 },

  speedCard:          { flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginBottom: 16, backgroundColor: '#111', borderRadius: 16, padding: 14, gap: 12 },
  speedIcon:          { width: 44, height: 44, borderRadius: 12, backgroundColor: '#1A1A00', alignItems: 'center', justifyContent: 'center' },
  speedLabel:         { color: '#fff', fontSize: 15, fontWeight: '600' },
  speedSub:           { color: '#666', fontSize: 12, marginTop: 2 },
  speedValue:         { color: '#FFD60A', fontSize: 28, fontWeight: '700' },
  speedUnit:          { color: '#888', fontSize: 12, alignSelf: 'flex-end', marginBottom: 4 },

  section:            { marginHorizontal: 16, marginBottom: 20 },
  sectionLabel:       { color: '#888', fontSize: 13, fontWeight: '500', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.8 },

  pickerWrap:         { height: PICKER_H, borderRadius: 16, backgroundColor: '#111', overflow: 'hidden', position: 'relative' },
  pickerHighlight:    { position: 'absolute', top: ITEM_H, left: 0, right: 0, height: ITEM_H, backgroundColor: 'rgba(255,214,10,0.07)', borderTopWidth: 1, borderBottomWidth: 1, borderColor: 'rgba(255,214,10,0.2)', zIndex: 1 },
  pickerItem:         { height: ITEM_H, alignItems: 'center', justifyContent: 'center' },
  pickerItemText:     { color: '#555', fontSize: 17 },
  pickerItemSelected: { color: '#fff', fontSize: 19, fontWeight: '600' },
  pickerEmpty:        { height: PICKER_H, borderRadius: 16, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' },
  pickerEmptyText:    { color: '#444', fontSize: 15 },

  colorRow:           { paddingVertical: 4, gap: 10, paddingHorizontal: 2 },
  swatchWrap:         { alignItems: 'center', gap: 6, padding: 8, borderRadius: 12, borderWidth: 1.5, borderColor: 'transparent', minWidth: 70 },
  swatchSelected:     { borderColor: '#FFD60A', backgroundColor: 'rgba(255,214,10,0.08)' },
  swatch:             { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)' },
  swatchLabel:        { color: '#666', fontSize: 11, textAlign: 'center' },
  swatchLabelSelected:{ color: '#FFD60A' },
});
