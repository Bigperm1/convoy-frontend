import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, FlatList, ScrollView,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Swipeable, GestureHandlerRootView } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { api, formatErr } from '../../src/api';
import { useAuth } from '../../src/auth';
import Constants from 'expo-constants';
import { COLORS } from '../../src/theme';
import { useAccent, memberSkin } from '../../src/appSkin';
import { skin } from '../../src/tierTheme';

// ADMIN — owner-only (2026-09-24 rebuild, Jeff: "lets build out the admin panel better… filters so i can
// search users by name/email/car/version/orphaned with ability to swipe delete in app… all the clubs in
// there so i can see who is in each club with a running number of members… a running monthly cost… a
// graphical usage stat for each service"). Three tabs: Users · Clubs · Costs. Privacy: nothing here that a
// member can't already see about themselves or their club-mates (handle, tier, car, last seen), plus the
// account email the owner already holds for support; no locations, no message contents. Aggregates only
// on the Costs tab. The Android install-link card is gone (Jeff: "never used it… obsolete").

const OWNER_EMAIL = 'jwellsmorton@gmail.com';

type AdminUser = {
  id: string;
  email: string;
  handle: string;
  car_make?: string;
  car_model?: string;
  car_color?: string;
  car_scan_id?: string | null;
  tier?: string;
  push_platform?: string;
  device_model?: string;
  device_brand?: string;
  os_name?: string;
  os_version?: string;
  app_version?: string;
  build_number?: string;
  runtime_version?: string;
  update_id?: string;
  version_seen_at?: string | null;
  created_at?: string | null;
  last_seen?: string | null;
};

type ClubMember = {
  id: string; handle: string; tier: string; last_seen?: string | null; car: string;
  app_version?: string; build_number?: string; runtime_version?: string; scanned?: boolean;
};
type AdminClub = {
  id: string; name: string; is_public?: boolean; created_at?: string | null;
  admin: ClubMember | null; member_count: number; pending_count: number; invite_code?: string | null;
  members: ClubMember[];
};

type CostPlan = { key: string; label: string; monthly: number; note?: string };
type CostMetered = { key: string; label: string; count: number; units: number; est_usd: number; unit_note?: string };
type CostSeries = Record<string, { day: string; count: number }[]>;
type AdminCosts = {
  month: string; currency: string; plans: CostPlan[]; metered: CostMetered[]; series: CostSeries;
  active: { day: string; count: number }[]; total_plans: number; total_metered: number; total: number; note?: string;
};

type Tab = 'users' | 'clubs' | 'costs';
type Filter = 'all' | 'ios' | 'android' | 'orphaned' | 'inactive' | 'nocar' | 'scanned';

// ── helpers ─────────────────────────────────────────────────────────────────

function deviceLabel(u: AdminUser): string {
  const model = u.device_model || (u.device_brand ? u.device_brand : '');
  const os =
    u.os_name && u.os_version ? `${u.os_name} ${u.os_version}`
    : u.os_name || (u.push_platform ? u.push_platform.toUpperCase() : '');
  const parts = [model, os].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Unknown device';
}

function versionLabel(u: AdminUser): string {
  const parts = [
    u.build_number ? `v${u.build_number}` : '',
    u.app_version || '',
    u.runtime_version ? `rt ${u.runtime_version}` : '',
    u.update_id === 'embedded' ? 'emb' : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'version not reported yet';
}

// An OTA only reaches a build whose runtimeVersion matches EXACTLY: a tester on an older runtime is
// ORPHANED and needs a new BUILD, not a nudge to tap the pill. Read from the bundle, never hardcoded.
const CURRENT_RUNTIME =
  String((Constants as any)?.expoConfig?.runtimeVersion ?? '') || null;
function isOrphaned(u: AdminUser): boolean {
  if (!CURRENT_RUNTIME || !u.runtime_version) return false;
  return u.runtime_version !== CURRENT_RUNTIME;
}

// INACTIVE: nothing from this account in 30 days, or it has never been seen on the road (no last_seen)
// and is older than a day — seed accounts, e2e sign-ups, testers who never installed. Every real tester
// has a last_seen from their first drive, so nobody who has driven is caught by the second clause.
function isInactive(u: AdminUser): boolean {
  const stamps = [u.last_seen, u.version_seen_at, u.created_at]
    .map((s) => (s ? new Date(s).getTime() : NaN))
    .filter((t) => !isNaN(t));
  if (!stamps.length) return false;
  const ageDays = (Date.now() - Math.max(...stamps)) / 86400000;
  return ageDays > 30 || (!u.last_seen && ageDays > 1);
}

function isIOS(u: AdminUser): boolean {
  const p = (u.os_name || u.push_platform || '').toLowerCase();
  return p.includes('ios') || p.includes('apple');
}
function isAndroid(u: AdminUser): boolean {
  const p = (u.os_name || u.push_platform || '').toLowerCase();
  return p.includes('android') || p.includes('samsung');
}
function deviceIcon(u: AdminUser): any {
  if (isIOS(u)) return 'logo-apple';
  if (isAndroid(u)) return 'logo-android';
  return 'phone-portrait-outline';
}
function lastActivity(u: AdminUser): number {
  const stamps = [u.last_seen, u.version_seen_at, u.created_at]
    .map((s) => (s ? new Date(s).getTime() : NaN))
    .filter((t) => !isNaN(t));
  return stamps.length ? Math.max(...stamps) : 0;
}

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

function usd(n: number): string {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

function tierColor(tier?: string, scanned?: boolean): string {
  return skin(memberSkin(tier, !!scanned)).accent;
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'ios', label: 'iOS' },
  { key: 'android', label: 'Android' },
  { key: 'orphaned', label: 'Orphaned' },
  { key: 'inactive', label: 'Inactive' },
  { key: 'nocar', label: 'No car' },
  { key: 'scanned', label: 'Scanned' },
];

// ── screen ──────────────────────────────────────────────────────────────────

export default function AdminScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const accent = useAccent();
  const isOwner = (user?.email || '').trim().toLowerCase() === OWNER_EMAIL;

  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [clubs, setClubs] = useState<AdminClub[] | null>(null);
  const [costs, setCosts] = useState<AdminCosts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [codes, setCodes] = useState<Record<string, { code: string; expires_at: string }>>({});
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pruning, setPruning] = useState(false);
  const [openClub, setOpenClub] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data } = await api.get('/admin/users');
      const list: AdminUser[] = Array.isArray(data) ? data : [];
      setUsers(list);
      setSel(new Set(list.filter((u) => isInactive(u) && (u.email || '').trim().toLowerCase() !== OWNER_EMAIL).map((u) => u.id)));
      // Clubs and costs are best-effort: an older backend (no endpoint yet) leaves the tab empty, not the screen broken.
      try { const r = await api.get('/admin/clubs'); setClubs(Array.isArray(r.data) ? r.data : []); } catch { setClubs([]); }
      try { const r = await api.get('/admin/costs'); setCosts(r.data && r.data.plans ? r.data : null); } catch { setCosts(null); }
    } catch (e: any) {
      const status = e?.response?.status;
      setError(status === 403 ? 'Not authorized.' : formatErr(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (isOwner) load(); else setLoading(false); }, [isOwner, load]);

  // Users: search over handle / email / car / version / build / device, then the chip filter, newest activity first.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users
      .filter((u) => {
        if (q) {
          const hay = [u.handle, u.email, u.car_make, u.car_model, u.car_color, u.app_version, u.build_number ? `v${u.build_number}` : '', u.runtime_version, u.device_model, u.os_name, u.tier]
            .filter(Boolean).join(' ').toLowerCase();
          if (!hay.includes(q)) return false;
        }
        switch (filter) {
          case 'ios': return isIOS(u);
          case 'android': return isAndroid(u);
          case 'orphaned': return isOrphaned(u);
          case 'inactive': return isInactive(u);
          case 'nocar': return !u.car_make && !u.car_model;
          case 'scanned': return !!u.car_scan_id;
          default: return true;
        }
      })
      .sort((a, b) => lastActivity(b) - lastActivity(a));
  }, [users, query, filter]);

  const counts = useMemo(() => ({
    all: users.length,
    ios: users.filter(isIOS).length,
    android: users.filter(isAndroid).length,
    orphaned: users.filter(isOrphaned).length,
    inactive: users.filter(isInactive).length,
    nocar: users.filter((u) => !u.car_make && !u.car_model).length,
    scanned: users.filter((u) => !!u.car_scan_id).length,
  }), [users]);

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

  // Remove one account: confirm with the handle and dates; the server pulls the id from clubs, events, threads.
  const removeUser = useCallback((u: AdminUser) => {
    Alert.alert(
      `Remove ${u.handle || u.email}?`,
      `Deletes the account and takes it out of every club, event and thread. Last seen ${ago(u.last_seen)}, joined ${ago(u.created_at)}. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove', style: 'destructive',
          onPress: async () => {
            setBusyEmail(u.email);
            try {
              await api.delete(`/admin/users/${encodeURIComponent(u.id)}`);
              setUsers((list) => list.filter((x) => x.id !== u.id));
              setSel((s) => { const n = new Set(s); n.delete(u.id); return n; });
            } catch (e: any) {
              Alert.alert("Couldn't remove", formatErr(e));
            } finally {
              setBusyEmail(null);
            }
          },
        },
      ]
    );
  }, []);

  const toggleSel = useCallback((id: string) => {
    setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);

  // Bulk: every INACTIVE row starts ticked; untick to keep; one confirm prunes the rest.
  const pruneSelected = useCallback(() => {
    const picked = users.filter((u) => sel.has(u.id));
    if (!picked.length) return;
    const names = picked.map((u) => u.handle || u.email).join(', ');
    Alert.alert(
      `Remove ${picked.length} account${picked.length === 1 ? '' : 's'}?`,
      `${names}\n\nEach one is deleted and taken out of every club, event and thread. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: `Remove ${picked.length}`, style: 'destructive',
          onPress: async () => {
            setPruning(true);
            try {
              const { data } = await api.post('/admin/users/prune', { ids: picked.map((u) => u.id) });
              const gone = new Set<string>((data?.removed || []).map((r: any) => r.id));
              setUsers((list) => list.filter((u) => !gone.has(u.id)));
              setSel((s) => { const n = new Set(s); gone.forEach((id) => n.delete(id)); return n; });
              Alert.alert('Removed', `${gone.size} account${gone.size === 1 ? '' : 's'} removed.`);
            } catch (e: any) {
              Alert.alert("Couldn't remove", formatErr(e));
            } finally {
              setPruning(false);
            }
          },
        },
      ]
    );
  }, [users, sel]);

  // Swipe left on a row → red Remove (the same confirm as the button it replaces).
  const renderRemoveAction = useCallback((u: AdminUser) => function SwipeRemove() {
    return (
      <TouchableOpacity style={styles.swipeRemove} onPress={() => removeUser(u)} activeOpacity={0.85}>
        <Ionicons name="trash" size={20} color="#fff" />
        <Text style={styles.swipeRemoveText}>Remove</Text>
      </TouchableOpacity>
    );
  }, [removeUser]);

  const renderUser = useCallback(({ item }: { item: AdminUser }) => {
    const code = codes[item.email];
    const busy = busyEmail === item.email;
    const ownerRow = (item.email || '').trim().toLowerCase() === OWNER_EMAIL;
    const inactive = isInactive(item) && !ownerRow;
    const tc = tierColor(item.tier, !!item.car_scan_id);
    const row = (
      <View style={styles.row}>
        {inactive && (
          <TouchableOpacity onPress={() => toggleSel(item.id)} hitSlop={10} style={styles.checkBtn} accessibilityLabel={sel.has(item.id) ? 'Selected for removal' : 'Not selected'}>
            <Ionicons name={sel.has(item.id) ? 'checkbox' : 'square-outline'} size={22} color={sel.has(item.id) ? '#FF453A' : COLORS.textDim} />
          </TouchableOpacity>
        )}
        <View style={{ flex: 1, paddingRight: 10 }}>
          <View style={styles.handleRow}>
            <Text style={[styles.handle, { color: tc }]} numberOfLines={1}>{item.handle || '(no handle)'}</Text>
            {!!item.tier && item.tier !== 'free' && (
              <Text style={[styles.tierTag, { color: tc, borderColor: tc }]}>{item.tier.replace('_', ' ').toUpperCase()}</Text>
            )}
          </View>
          <Text style={styles.email} numberOfLines={1}>{item.email}</Text>
          <Text style={styles.meta} numberOfLines={1}>
            {[item.car_make, item.car_model].filter(Boolean).join(' ') || 'No car set'}{item.car_scan_id ? ' · scanned' : ''} · seen {ago(item.last_seen)}
          </Text>
          <View style={styles.deviceRow}>
            <Ionicons name={deviceIcon(item)} size={12} color="#7FA8FF" />
            <Text style={styles.deviceText} numberOfLines={1}>{deviceLabel(item)}</Text>
          </View>
          <View style={styles.deviceRow}>
            <Ionicons name={isOrphaned(item) ? 'alert-circle' : 'cube-outline'} size={13} color={isOrphaned(item) ? '#FF453A' : COLORS.textDim} />
            <Text style={[styles.deviceText, isOrphaned(item) && { color: '#FF453A', fontWeight: '700' }]} numberOfLines={1}>
              {versionLabel(item)}{isOrphaned(item) ? '  ·  ORPHANED (needs a build)' : ''}
            </Text>
          </View>
          {inactive && (
            <Text style={styles.inactiveTag}>INACTIVE · {!item.last_seen ? 'never seen on the road' : 'no activity in 30 days'}</Text>
          )}
          {code && (
            <Text selectable style={[styles.codePill, { color: accent }]}>Code {code.code} · relay now</Text>
          )}
        </View>
        <TouchableOpacity
          style={[styles.resetBtn, { backgroundColor: accent }, busy && { opacity: 0.6 }]}
          onPress={() => genCode(item)}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy ? <ActivityIndicator size="small" color="#1a1a1a" /> : <Text style={styles.resetBtnText}>Reset code</Text>}
        </TouchableOpacity>
      </View>
    );
    if (ownerRow) return row;
    return (
      <Swipeable renderRightActions={renderRemoveAction(item)} overshootRight={false}>
        {row}
      </Swipeable>
    );
  }, [codes, busyEmail, genCode, accent, sel, toggleSel, renderRemoveAction]);

  // ── Clubs tab ─────────────────────────────────────────────────────────────
  const clubsView = (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
      {clubs === null ? (
        <Text style={styles.centerText}>Loading clubs…</Text>
      ) : clubs.length === 0 ? (
        <Text style={styles.centerText}>No clubs yet (or the backend predates this tab).</Text>
      ) : (
        <>
          <View style={styles.totalsRow}>
            <Text style={styles.totalsText}>{clubs.length} club{clubs.length === 1 ? '' : 's'}</Text>
            <Text style={styles.totalsText}>{clubs.reduce((n, c) => n + c.member_count, 0)} memberships</Text>
            <Text style={styles.totalsText}>{clubs.reduce((n, c) => n + c.pending_count, 0)} pending</Text>
          </View>
          {clubs.map((c) => {
            const open = openClub === c.id;
            return (
              <View key={c.id} style={styles.clubCard}>
                <TouchableOpacity onPress={() => setOpenClub(open ? null : c.id)} activeOpacity={0.8} style={styles.clubHead}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.clubName} numberOfLines={1}>{c.name || '(unnamed club)'}</Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      admin {c.admin?.handle || '—'} · {c.is_public ? 'public' : 'private'}{c.invite_code ? ` · code ${c.invite_code}` : ''} · since {ago(c.created_at)}
                    </Text>
                  </View>
                  <View style={styles.clubCount}>
                    <Text style={styles.clubCountNum}>{c.member_count}</Text>
                    <Text style={styles.clubCountLbl}>members{c.pending_count ? ` · ${c.pending_count} pending` : ''}</Text>
                  </View>
                  <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={COLORS.textDim} />
                </TouchableOpacity>
                {open && c.members.map((m) => {
                  const mc = tierColor(m.tier, m.scanned);
                  return (
                    <View key={m.id} style={styles.memberRow}>
                      <View style={[styles.memberDot, { backgroundColor: mc }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.memberHandle, { color: mc }]} numberOfLines={1}>{m.handle || '(no handle)'}{c.admin?.id === m.id ? '  · admin' : ''}</Text>
                        <Text style={styles.meta} numberOfLines={1}>{m.car || 'No car set'}{m.scanned ? ' · scanned' : ''} · {m.build_number ? `v${m.build_number}` : 'no build yet'} · seen {ago(m.last_seen)}</Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            );
          })}
        </>
      )}
    </ScrollView>
  );

  // ── Costs tab ─────────────────────────────────────────────────────────────
  const Bars = ({ points, color }: { points: { day: string; count: number }[]; color: string }) => {
    const max = Math.max(1, ...points.map((p) => p.count));
    return (
      <View style={styles.bars}>
        {points.map((p) => (
          <View key={p.day} style={styles.barCol}>
            <View style={[styles.bar, { height: Math.max(2, Math.round((p.count / max) * 36)), backgroundColor: p.count ? color : 'rgba(255,255,255,0.10)' }]} />
          </View>
        ))}
      </View>
    );
  };
  const costsView = (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 120 }}>
      {!costs ? (
        <Text style={styles.centerText}>No cost data — the backend predates this tab, or it could not be reached.</Text>
      ) : (
        <>
          <View style={styles.costHero}>
            <Text style={styles.costMonth}>{costs.month} · running total</Text>
            <Text style={[styles.costTotal, { color: accent }]}>{usd(costs.total)}</Text>
            <Text style={styles.meta}>{usd(costs.total_plans)} plans + {usd(costs.total_metered)} metered so far this month</Text>
          </View>

          <Text style={styles.sectionLabel}>PLANS</Text>
          <View style={styles.tableCard}>
            {costs.plans.map((p) => (
              <View key={p.key} style={styles.tableRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.tableLabel}>{p.label}</Text>
                  {!!p.note && <Text style={styles.meta}>{p.note}</Text>}
                </View>
                <Text style={styles.tableAmt}>{usd(p.monthly)}<Text style={styles.meta}>/mo</Text></Text>
              </View>
            ))}
          </View>

          <Text style={styles.sectionLabel}>METERED THIS MONTH · LAST 30 DAYS</Text>
          <View style={styles.tableCard}>
            <View style={styles.tableRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.tableLabel}>Active users</Text>
                <Text style={styles.meta}>distinct accounts that opened the app, per day</Text>
                <Bars points={costs.active} color="#7FA8FF" />
              </View>
            </View>
            {costs.metered.map((m) => (
              <View key={m.key} style={styles.tableRow}>
                <View style={{ flex: 1 }}>
                  <View style={styles.handleRow}>
                    <Text style={styles.tableLabel}>{m.label}</Text>
                    <Text style={styles.tableAmt}>{usd(m.est_usd)}</Text>
                  </View>
                  <Text style={styles.meta}>{m.count} call{m.count === 1 ? '' : 's'}{m.units ? ` · ${Math.round(m.units).toLocaleString()} units` : ''}{m.unit_note ? ` · ${m.unit_note}` : ''}</Text>
                  <Bars points={costs.series[m.key] || []} color={accent} />
                </View>
              </View>
            ))}
          </View>
          {!!costs.note && <Text style={[styles.meta, { marginTop: 10, lineHeight: 17 }]}>{costs.note}</Text>}
        </>
      )}
    </ScrollView>
  );

  // ── Users tab ─────────────────────────────────────────────────────────────
  const usersView = (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color="#777" />
        <TextInput
          style={styles.search}
          placeholder="Name, email, car, version, device…"
          placeholderTextColor={COLORS.textDim}
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
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRail} style={{ flexGrow: 0 }}>
        {FILTERS.map((f) => {
          const on = filter === f.key;
          const n = (counts as any)[f.key] as number;
          return (
            <TouchableOpacity key={f.key} onPress={() => setFilter(f.key)} style={[styles.chip, on && { backgroundColor: accent, borderColor: accent }]} activeOpacity={0.85}>
              <Text style={[styles.chipText, on && { color: '#0B0B0C' }]}>{f.label}{typeof n === 'number' ? ` ${n}` : ''}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      {sel.size > 0 && (
        <View style={styles.pruneBar}>
          <Text style={styles.pruneHint} numberOfLines={2}>{sel.size} inactive ticked. Untick anyone to keep.</Text>
          <TouchableOpacity style={[styles.pruneBtn, pruning && { opacity: 0.6 }]} onPress={pruneSelected} disabled={pruning} activeOpacity={0.85}>
            {pruning ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.pruneBtnText}>Remove selected · {sel.size}</Text>}
          </TouchableOpacity>
        </View>
      )}
      <FlatList
        data={filtered}
        keyExtractor={(u) => u.id}
        renderItem={renderUser}
        contentContainerStyle={{ paddingBottom: 120, paddingHorizontal: 14 }}
        ListEmptyComponent={<Text style={styles.centerText}>No matching users.</Text>}
        ListFooterComponent={<Text style={[styles.meta, { textAlign: 'center', marginTop: 8 }]}>Swipe a row left to remove it.</Text>}
        keyboardShouldPersistTaps="handled"
      />
    </GestureHandlerRootView>
  );

  const subtitle = loading ? 'Loading…'
    : tab === 'users' ? `${filtered.length} of ${users.length} user${users.length === 1 ? '' : 's'}`
    : tab === 'clubs' ? `${clubs?.length ?? 0} club${(clubs?.length ?? 0) === 1 ? '' : 's'}`
    : costs ? `${usd(costs.total)} this month` : 'costs';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Admin</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
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
          <View style={styles.tabs}>
            {(['users', 'clubs', 'costs'] as Tab[]).map((t) => (
              <TouchableOpacity key={t} onPress={() => setTab(t)} style={[styles.tabBtn, tab === t && { backgroundColor: accent }]} activeOpacity={0.85}>
                <Text style={[styles.tabText, tab === t && { color: '#0B0B0C' }]}>{t === 'users' ? 'Users' : t === 'clubs' ? 'Clubs' : 'Costs'}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {tab === 'users' ? usersView : tab === 'clubs' ? clubsView : costsView}
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
  centerText: { color: COLORS.textDim, fontSize: 14, textAlign: 'center', marginTop: 12 },
  retryBtn: { paddingHorizontal: 18, paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)' },
  retryText: { color: COLORS.text, fontWeight: '600' },
  // segmented tabs — the Hairpin square (DESIGN.md § Shape)
  tabs: { flexDirection: 'row', gap: 6, marginHorizontal: 14, marginBottom: 10, padding: 3, backgroundColor: 'rgba(118,118,128,0.18)', borderRadius: 10 },
  tabBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  tabText: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 14, marginBottom: 8, paddingHorizontal: 12,
    backgroundColor: '#1a1a1a', borderRadius: 12, borderWidth: 1, borderColor: '#333',
  },
  search: { flex: 1, color: '#F4F4F4', fontSize: 15, paddingVertical: Platform.OS === 'ios' ? 11 : 7 },
  chipRail: { paddingHorizontal: 14, gap: 8, paddingBottom: 10 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', backgroundColor: 'rgba(255,255,255,0.06)' },
  chipText: { color: '#C7C7CC', fontSize: 12.5, fontWeight: '700' },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#161618', borderRadius: 14, borderWidth: 1, borderColor: '#262629',
    padding: 12, marginBottom: 8,
  },
  handleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  handle: { color: COLORS.text, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  tierTag: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8, borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  email: { color: COLORS.textDim, fontSize: 13, marginTop: 1 },
  meta: { color: COLORS.textDim, fontSize: 12, marginTop: 3 },
  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  deviceText: { color: '#7FA8FF', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  codePill: { color: '#2DEC86', fontSize: 14, fontWeight: '800', letterSpacing: 1, marginTop: 6 },
  resetBtn: { backgroundColor: '#2DEC86', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, minWidth: 96, alignItems: 'center' },
  resetBtnText: { color: '#1a1a1a', fontWeight: '700', fontSize: 13 },
  inactiveTag: { color: '#FF9F0A', fontSize: 11, fontWeight: '800', letterSpacing: 0.6, marginTop: 4 },
  checkBtn: { paddingRight: 10, alignSelf: 'center' },
  swipeRemove: { width: 96, marginBottom: 8, borderRadius: 14, backgroundColor: '#FF453A', alignItems: 'center', justifyContent: 'center', gap: 4, marginLeft: 8 },
  swipeRemoveText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  pruneBar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 14, marginBottom: 10, padding: 12,
    backgroundColor: 'rgba(255,69,58,0.10)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,69,58,0.35)',
  },
  pruneHint: { flex: 1, color: COLORS.textDim, fontSize: 12, lineHeight: 16 },
  pruneBtn: { backgroundColor: '#FF453A', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, minWidth: 96, alignItems: 'center' },
  pruneBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  // clubs
  totalsRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4, marginBottom: 10 },
  totalsText: { color: COLORS.textDim, fontSize: 12, fontWeight: '700', letterSpacing: 0.4 },
  clubCard: { backgroundColor: '#161618', borderRadius: 14, borderWidth: 1, borderColor: '#262629', marginBottom: 8, overflow: 'hidden' },
  clubHead: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  clubName: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  clubCount: { alignItems: 'flex-end' },
  clubCountNum: { color: COLORS.text, fontSize: 20, fontWeight: '800' },
  clubCountLbl: { color: COLORS.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.4 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#262629' },
  memberDot: { width: 8, height: 8, borderRadius: 2 },
  memberHandle: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  // costs
  costHero: { backgroundColor: '#161618', borderRadius: 14, borderWidth: 1, borderColor: '#262629', padding: 16, marginBottom: 14, alignItems: 'center' },
  costMonth: { color: COLORS.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  costTotal: { fontSize: 36, fontWeight: '800', marginTop: 4 },
  sectionLabel: { color: COLORS.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 6, marginLeft: 4 },
  tableCard: { backgroundColor: '#161618', borderRadius: 14, borderWidth: 1, borderColor: '#262629', marginBottom: 14, overflow: 'hidden' },
  tableRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#262629' },
  tableLabel: { color: COLORS.text, fontSize: 14, fontWeight: '700', flex: 1 },
  tableAmt: { color: COLORS.text, fontSize: 14, fontWeight: '800' },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 36, marginTop: 8 },
  barCol: { flex: 1, justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 1 },
});
