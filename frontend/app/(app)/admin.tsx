import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { api, formatErr } from '../../src/api';
import { useAuth } from '../../src/auth';
import { COLORS } from '../../src/theme';

const OWNER_EMAIL = 'jwellsmorton@gmail.com';

type AdminUser = {
  id: string;
  email: string;
  handle: string;
  car_make?: string;
  car_model?: string;
  car_color?: string;
  created_at?: string | null;
  last_seen?: string | null;
};

// Short, friendly timestamp: "just now" / "3h ago" / "Apr 12". Defensive
// against null / unparseable values so a bad row never crashes the list.
function ago(iso?: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '-';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

export default function AdminScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const isOwner = (user?.email || '').trim().toLowerCase() === OWNER_EMAIL;

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // email -> { code, expires_at }, so a freshly minted code stays visible inline.
  const [codes, setCodes] = useState<Record<string, { code: string; expires_at: string }>>({});
  const [busyEmail, setBusyEmail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data } = await api.get('/admin/users');
      setUsers(Array.isArray(data) ? data : []);
    } catch (e: any) {
      const status = e?.response?.status;
      setError(status === 403 ? 'Not authorized.' : formatErr(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (isOwner) load(); else setLoading(false); }, [isOwner, load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        (u.email || '').toLowerCase().includes(q) ||
        (u.handle || '').toLowerCase().includes(q)
    );
  }, [users, query]);

  const genCode = useCallback(async (u: AdminUser) => {
    setBusyEmail(u.email);
    try {
      const { data } = await api.post('/admin/reset-code', { email: u.email });
      setCodes((c) => ({ ...c, [u.email]: { code: data.code, expires_at: data.expires_at } }));
      Alert.alert(
        `Reset code for ${u.handle || u.email}`,
        `${data.code}\n\nRelay this to them. They open "Forgot password", enter their email, then type this code + a new password. Expires in 30 minutes.`,
        [{ text: 'Done' }]
      );
    } catch (e: any) {
      Alert.alert("Couldn't generate code", formatErr(e));
    } finally {
      setBusyEmail(null);
    }
  }, []);

  const renderItem = useCallback(({ item }: { item: AdminUser }) => {
    const code = codes[item.email];
    const busy = busyEmail === item.email;
    return (
      <View style={styles.row}>
        <View style={{ flex: 1, paddingRight: 10 }}>
          <Text style={styles.handle} numberOfLines={1}>{item.handle || '(no handle)'}</Text>
          <Text style={styles.email} numberOfLines={1}>{item.email}</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {[item.car_make, item.car_model].filter(Boolean).join(' ') || 'No car set'} · seen {ago(item.last_seen)}
          </Text>
          {code && (
            <Text selectable style={styles.codePill}>
              Code {code.code} · relay now
            </Text>
          )}
        </View>
        <TouchableOpacity
          style={[styles.resetBtn, busy && { opacity: 0.6 }]}
          onPress={() => genCode(item)}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy
            ? <ActivityIndicator size="small" color="#1a1a1a" />
            : <Text style={styles.resetBtnText}>Reset code</Text>}
        </TouchableOpacity>
      </View>
    );
  }, [codes, busyEmail, genCode]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Admin</Text>
          <Text style={styles.subtitle}>
            {loading ? 'Loading…' : `${users.length} user${users.length === 1 ? '' : 's'} registered`}
          </Text>
        </View>
        <TouchableOpacity onPress={() => { setLoading(true); load(); }} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="refresh" size={22} color={COLORS.textDim} />
        </TouchableOpacity>
      </View>

      {!isOwner ? (
        <View style={styles.center}>
          <Ionicons name="lock-closed" size={40} color={COLORS.textDim} />
          <Text style={styles.centerText}>This area is owner-only.</Text>
        </View>
      ) : loading ? (
        <View style={styles.center}><ActivityIndicator color={COLORS.primary} /></View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.centerText}>{error}</Text>
          <TouchableOpacity onPress={() => { setLoading(true); load(); }} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <View style={styles.searchWrap}>
            <Ionicons name="search" size={16} color="#777" />
            <TextInput
              style={styles.search}
              placeholder="Search email or handle"
              placeholderTextColor="#666"
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
                <Ionicons name="close-circle" size={16} color="#777" />
              </TouchableOpacity>
            )}
          </View>
          <FlatList
            data={filtered}
            keyExtractor={(u) => u.id}
            renderItem={renderItem}
            contentContainerStyle={{ paddingBottom: 120, paddingHorizontal: 14 }}
            ListEmptyComponent={<Text style={styles.centerText}>No matching users.</Text>}
            keyboardShouldPersistTaps="handled"
          />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  backBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: { color: COLORS.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.3 },
  subtitle: { color: COLORS.textDim, fontSize: 12, marginTop: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  centerText: { color: COLORS.textDim, fontSize: 14, textAlign: 'center' },
  retryBtn: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.1)' },
  retryText: { color: COLORS.text, fontWeight: '600' },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 14, marginBottom: 8, paddingHorizontal: 12,
    backgroundColor: '#1a1a1a', borderRadius: 12, borderWidth: 1, borderColor: '#333',
  },
  search: { flex: 1, color: '#fff', fontSize: 15, paddingVertical: Platform.OS === 'ios' ? 11 : 7 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#161618', borderRadius: 14, borderWidth: 1, borderColor: '#262629',
    padding: 12, marginBottom: 8,
  },
  handle: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  email: { color: COLORS.textDim, fontSize: 13, marginTop: 1 },
  meta: { color: '#6b6f6d', fontSize: 12, marginTop: 3 },
  codePill: {
    color: '#FFD60A', fontSize: 14, fontWeight: '800', letterSpacing: 1,
    marginTop: 6,
  },
  resetBtn: {
    backgroundColor: '#FFD60A', borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10, minWidth: 96, alignItems: 'center',
  },
  resetBtnText: { color: '#1a1a1a', fontWeight: '700', fontSize: 13 },
});
