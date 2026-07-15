// WhenPicker — hand-rolled date+time selector for Event/Cruise scheduling (Hub P2).
//
// Deliberately NOT @react-native-community/datetimepicker: that's a native module,
// which would gate the Hub on a paid native build. This is pure JS (OTA-shippable)
// and matches the app's chip language (hub tag chips / category pills): a day rail
// (next 30 days), an hour rail, and a minute rail (15-min steps) — glanceable and
// thumb-friendly, no modal-in-modal.

import React, { useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../theme';

type Props = {
  value: Date;
  onChange: (d: Date) => void;
};

const DAY_COUNT = 30;
const MINUTES = [0, 15, 30, 45];

function dayLabel(d: Date, today: Date): string {
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(d) - startOf(today)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function fmtWhen(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    + ' · '
    + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export default function WhenPicker({ value, onChange }: Props) {
  const today = new Date();
  const days = useMemo(() => {
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    return Array.from({ length: DAY_COUNT }, (_, i) => new Date(base.getTime() + i * 86_400_000));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setDay = (d: Date) => {
    const next = new Date(value);
    next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    onChange(next);
  };
  const setHour = (h: number) => { const n = new Date(value); n.setHours(h); onChange(n); };
  const setMinute = (m: number) => { const n = new Date(value); n.setMinutes(m, 0, 0); onChange(n); };

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const hour12 = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? ' AM' : ' PM'}`;

  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {days.map((d) => {
          const on = sameDay(d, value);
          return (
            <TouchableOpacity key={d.toDateString()} onPress={() => setDay(d)} style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{dayLabel(d, today)}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {Array.from({ length: 24 }, (_, h) => h).map((h) => {
          const on = value.getHours() === h;
          return (
            <TouchableOpacity key={h} onPress={() => setHour(h)} style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{hour12(h)}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {MINUTES.map((m) => {
          const on = value.getMinutes() === m;
          return (
            <TouchableOpacity key={m} onPress={() => setMinute(m)} style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{`:${m.toString().padStart(2, '0')}`}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <Text style={styles.preview}>{fmtWhen(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: { gap: 8, paddingVertical: 5, paddingRight: 8 },
  chip: {
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  chipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipText: { color: '#D9D9DE', fontSize: 13.5, fontWeight: '700' },
  chipTextOn: { color: '#0A1A10' },
  preview: { color: COLORS.primary, fontWeight: '800', fontSize: 14, marginTop: 8, textAlign: 'center' },
});
