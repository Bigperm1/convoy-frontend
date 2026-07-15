// hubEvents.tsx — the Hub's EVENTS + CRUISES sections (Hub P2).
//
// One kind-parameterized section powers both tabs: kind="event" (meets) and
// kind="cruise" (P3 adds stops/gas/arrival-trigger polish; create/discover/RSVP
// already work through the same backend collection). Visuals follow hub.tsx's
// club patterns (glass cards, segmented control, slide-up create sheet) so the
// three Hub sections read as one design.
//
// Backend: src/eventsApi.ts → /api/events (see convoy-backend server.py "Events").
// RSVP model per Jeff's spec: Attend = "interested" (counts on the card, gets the
// 24h "you coming?" push) → Confirm = "yes I'm showing up" (gets the 2h route
// push). Live counts refresh on every action + pull-to-refresh.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  Modal, Alert, Switch, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import Glass, { GlassFill } from './Glass';
import { COLORS } from './theme';
import { api, formatErr } from './api';
import { autocompletePlaces, placeDetails, type Suggestion } from './places';
import WhenPicker, { fmtWhen } from './components/WhenPicker';
import { shareInbox } from './shareInbox';
import {
  type HubEvent, type EventPoint, createEvent, myEvents, discoverEvents,
  getEvent, attendEvent, confirmEvent, unattendEvent, deleteEvent,
} from './eventsApi';

type Kind = 'event' | 'cruise';

const KIND_COPY: Record<Kind, { one: string; title: string; icon: keyof typeof Ionicons.glyphMap; emptyMine: string; emptyDiscover: string }> = {
  event: {
    one: 'event', title: 'Event', icon: 'calendar',
    emptyMine: 'No events yet — create one or discover a meet nearby.',
    emptyDiscover: 'No upcoming events found. Create the first one!',
  },
  cruise: {
    one: 'cruise', title: 'Cruise', icon: 'car-sport',
    emptyMine: 'No cruises yet — plan one and rally the crew.',
    emptyDiscover: 'No upcoming cruises found. Plan the first one!',
  },
};

function whenText(iso: string): string {
  try { return fmtWhen(new Date(iso)); } catch { return iso; }
}

// ── Section (mine/discover lists + create + detail) ─────────────────────────
export function EventsSection({ kind, openEventId }: { kind: Kind; openEventId?: string | null }) {
  const copy = KIND_COPY[kind];
  const [tab, setTab] = useState<'discover' | 'mine'>('mine');
  const [mine, setMine] = useState<HubEvent[]>([]);
  const [found, setFound] = useState<HubEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [detail, setDetail] = useState<HubEvent | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, d] = await Promise.all([myEvents(), discoverEvents('', kind)]);
      setMine(m.filter((e) => e.kind === kind));
      setFound(d);
    } catch {}
    setLoading(false);
  }, [kind]);

  useEffect(() => { load(); }, [load]);

  // Deep-open from a push notification (hub?event=<id> → Hub passes it down).
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!openEventId || openedRef.current === openEventId) return;
    openedRef.current = openEventId;
    getEvent(openEventId).then((e) => { if (e.kind === kind) setDetail(e); }).catch(() => {});
  }, [openEventId, kind]);

  const list = tab === 'mine' ? mine : found;

  return (
    <View>
      {/* Create + Discover/Mine controls (mirrors the hub's segmented control) */}
      <View style={styles.segment}>
        <TouchableOpacity onPress={() => setTab('discover')} style={[styles.segmentBtn, tab === 'discover' && styles.segmentBtnOn]}>
          <Text style={[styles.segmentText, tab === 'discover' && styles.segmentTextOn]}>Discover</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setTab('mine')} style={[styles.segmentBtn, tab === 'mine' && styles.segmentBtnOn]}>
          <Text style={[styles.segmentText, tab === 'mine' && styles.segmentTextOn]}>{kind === 'event' ? 'My Events' : 'My Cruises'}</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity onPress={() => setShowCreate(true)} activeOpacity={0.85} style={{ marginBottom: 14 }}>
        <Glass radius={16}>
          <View style={styles.createRow}>
            <LinearGradient colors={[COLORS.primary, '#18B368']} style={styles.createIcon}>
              <Ionicons name="add" size={22} color="#0A1A10" />
            </LinearGradient>
            <Text style={styles.createText}>{`Create ${copy.one}`}</Text>
          </View>
        </Glass>
      </TouchableOpacity>

      {loading && list.length === 0 ? (
        <ActivityIndicator color={COLORS.primary} style={{ marginVertical: 28 }} />
      ) : list.length === 0 ? (
        <Glass radius={20}>
          <View style={styles.emptyBox}>
            <Ionicons name={copy.icon} size={30} color={COLORS.textMute} />
            <Text style={styles.emptyText}>{tab === 'mine' ? copy.emptyMine : copy.emptyDiscover}</Text>
          </View>
        </Glass>
      ) : (
        list.map((e) => <EventCard key={e.id} event={e} onPress={async () => {
          try { setDetail(await getEvent(e.id)); } catch (err) { Alert.alert('Could not open', formatErr(err)); }
        }} />)
      )}

      <CreateEventModal
        kind={kind}
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(e) => { setShowCreate(false); load(); setDetail(e); }}
      />
      <EventDetailModal
        event={detail}
        onClose={() => setDetail(null)}
        onChanged={(e) => { setDetail(e); load(); }}
        onDeleted={() => { setDetail(null); load(); }}
      />
    </View>
  );
}

// ── Card ─────────────────────────────────────────────────────────────────────
function EventCard({ event: e, onPress }: { event: HubEvent; onPress: () => void }) {
  const copy = KIND_COPY[e.kind] || KIND_COPY.event;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} style={{ marginBottom: 12 }}>
      <Glass radius={20}>
        <View style={styles.card}>
          <View style={styles.cardIcon}>
            <Ionicons name={copy.icon} size={20} color={COLORS.primary} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={styles.cardTitle} numberOfLines={1}>{e.title}</Text>
              {!e.is_public && <Text style={styles.clubPill}>CLUB</Text>}
            </View>
            <Text style={styles.cardWhen}>{whenText(e.start_at)}</Text>
            {!!e.venue?.label && <Text style={styles.cardVenue} numberOfLines={1}>{e.venue.label}</Text>}
          </View>
          <View style={styles.countPill}>
            <Ionicons name="people" size={13} color="#0A1A10" />
            <Text style={styles.countText}>{e.attendee_count}</Text>
          </View>
        </View>
      </Glass>
    </TouchableOpacity>
  );
}

// ── Venue search field (inline autocomplete — Places v1) ────────────────────
function VenueField({ label, value, onPick }: { label: string; value: EventPoint | null; onPick: (p: EventPoint) => void }) {
  const [q, setQ] = useState('');
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onType = (text: string) => {
    setQ(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim().length < 2) { setSugs([]); return; }
    debounceRef.current = setTimeout(async () => {
      try { setSugs(await autocompletePlaces(text.trim())); } catch { setSugs([]); }
    }, 250);
  };

  const pick = async (s: Suggestion) => {
    setSugs([]);
    try {
      const p = await placeDetails(s.place_id);
      if (p) { onPick({ lat: p.lat, lng: p.lng, label: p.label || s.description }); setQ(''); }
    } catch {}
  };

  return (
    <View style={{ marginTop: 14 }}>
      <Text style={styles.label}>{label}</Text>
      {value ? (
        <View style={styles.venuePicked}>
          <Ionicons name="location" size={16} color={COLORS.primary} />
          <Text style={styles.venuePickedText} numberOfLines={1}>{value.label || `${value.lat.toFixed(4)}, ${value.lng.toFixed(4)}`}</Text>
          <TouchableOpacity onPress={() => onPick(null as any)} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={COLORS.textMute} />
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <TextInput
            style={styles.input}
            placeholder="Search a place…"
            placeholderTextColor={COLORS.textMute}
            value={q}
            onChangeText={onType}
          />
          {sugs.map((s) => (
            <TouchableOpacity key={s.place_id} onPress={() => pick(s)} style={styles.sugRow}>
              <Ionicons name="location-outline" size={15} color={COLORS.textMute} />
              <Text style={styles.sugText} numberOfLines={1}>{s.description}</Text>
            </TouchableOpacity>
          ))}
        </>
      )}
    </View>
  );
}

// ── Create sheet ─────────────────────────────────────────────────────────────
type ClubLite = { id: string; name: string };

function CreateEventModal({ kind, visible, onClose, onCreated }: {
  kind: Kind; visible: boolean; onClose: () => void; onCreated: (e: HubEvent) => void;
}) {
  const copy = KIND_COPY[kind];
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [venue, setVenue] = useState<EventPoint | null>(null);
  const [end, setEnd] = useState<EventPoint | null>(null);           // cruise only
  const defaultStart = () => { const d = new Date(Date.now() + 26 * 3600_000); d.setMinutes(0, 0, 0); return d; };
  const [when, setWhen] = useState<Date>(defaultStart);
  const [isPublic, setIsPublic] = useState(true);
  const [notify, setNotify] = useState(true);
  const [clubs, setClubs] = useState<ClubLite[]>([]);
  const [clubId, setClubId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    api.get('/communities/mine')
      .then(({ data }) => setClubs((data || []).map((c: any) => ({ id: c.id, name: c.name }))))
      .catch(() => setClubs([]));
  }, [visible]);

  const create = async () => {
    if (!title.trim()) return Alert.alert('Name it', `Give your ${copy.one} a title.`);
    if (!venue) return Alert.alert('Where?', kind === 'cruise' ? 'Pick the meeting point (first stop).' : 'Pick a meeting destination.');
    if (when.getTime() < Date.now()) return Alert.alert('Time travel', 'Pick a time in the future.');
    if (!isPublic && !clubId) return Alert.alert('Pick a club', 'Club-only events need a club.');
    setBusy(true);
    try {
      const e = await createEvent({
        kind,
        title: title.trim(),
        description: desc.trim(),
        is_public: isPublic,
        club_id: isPublic ? clubId : clubId, // club optional for public, required for club-only
        venue_lat: venue.lat, venue_lng: venue.lng, venue_label: venue.label || '',
        start_at: when.toISOString(),
        notify_enabled: notify,
        ...(kind === 'cruise' && end ? { end_lat: end.lat, end_lng: end.lng, end_label: end.label || '' } : {}),
        ...(kind === 'cruise' ? { departure_at: when.toISOString() } : {}),
      });
      onCreated(e);
      // reset for next time
      setTitle(''); setDesc(''); setVenue(null); setEnd(null); setWhen(defaultStart()); setIsPublic(true); setNotify(true); setClubId(null);
    } catch (err) {
      Alert.alert('Could not create', formatErr(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalRoot}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{`Create ${copy.one}`}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}><Ionicons name="close" size={24} color={COLORS.text} /></TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Title</Text>
            <TextInput style={styles.input} placeholder={kind === 'cruise' ? 'Sea-to-Sky Sunday run' : 'Cars & Coffee'} placeholderTextColor={COLORS.textMute} value={title} onChangeText={setTitle} />

            <Text style={[styles.label, { marginTop: 14 }]}>Description</Text>
            <TextInput style={[styles.input, { minHeight: 64 }]} placeholder={`What's this ${copy.one} about?`} placeholderTextColor={COLORS.textMute} value={desc} onChangeText={setDesc} multiline />

            <VenueField label={kind === 'cruise' ? 'Meeting point (first stop)' : 'Meeting destination'} value={venue} onPick={setVenue} />
            {kind === 'cruise' && <VenueField label="End location" value={end} onPick={setEnd} />}

            <Text style={[styles.label, { marginTop: 16 }]}>{kind === 'cruise' ? 'Departure time' : 'When'}</Text>
            <WhenPicker value={when} onChange={setWhen} />

            {/* Visibility — creator picks (Jeff's call): Public or Club-only */}
            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleTitle}>Public</Text>
                <Text style={styles.toggleSub}>{isPublic ? `Anyone can discover this ${copy.one}` : 'Only members of the club below can see it'}</Text>
              </View>
              <Switch value={isPublic} onValueChange={setIsPublic} trackColor={{ false: '#3A3A3C', true: COLORS.primary + '88' }} thumbColor={isPublic ? COLORS.primary : '#f4f3f4'} />
            </View>
            {!isPublic && (
              clubs.length === 0 ? (
                <Text style={styles.helpText}>{`You're not in any clubs yet — join or create one in the Clubs tab.`}</Text>
              ) : (
                <View style={styles.clubChips}>
                  {clubs.map((c) => (
                    <TouchableOpacity key={c.id} onPress={() => setClubId(c.id)} style={[styles.clubChip, clubId === c.id && styles.clubChipOn]}>
                      <Text style={[styles.clubChipText, clubId === c.id && styles.clubChipTextOn]} numberOfLines={1}>{c.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )
            )}

            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleTitle}>Attendee notifications</Text>
                <Text style={styles.toggleSub}>{`24h "are you coming?" check-in + a route to the meet 2h before`}</Text>
              </View>
              <Switch value={notify} onValueChange={setNotify} trackColor={{ false: '#3A3A3C', true: COLORS.primary + '88' }} thumbColor={notify ? COLORS.primary : '#f4f3f4'} />
            </View>

            <TouchableOpacity onPress={create} disabled={busy} activeOpacity={0.85} style={{ marginTop: 18, marginBottom: 26 }}>
              <LinearGradient colors={[COLORS.primary, '#18B368']} style={styles.createBtn}>
                <Text style={styles.createBtnText}>{busy ? 'Creating…' : `Create ${copy.one}`}</Text>
              </LinearGradient>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Detail sheet ─────────────────────────────────────────────────────────────
function EventDetailModal({ event: e, onClose, onChanged, onDeleted }: {
  event: HubEvent | null; onClose: () => void; onChanged: (e: HubEvent) => void; onDeleted: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!e) return null;
  const copy = KIND_COPY[e.kind] || KIND_COPY.event;

  const act = async (fn: () => Promise<HubEvent>) => {
    if (busy) return;
    setBusy(true);
    try { onChanged(await fn()); } catch (err) { Alert.alert('Failed', formatErr(err)); }
    setBusy(false);
  };

  const routeThere = () => {
    // Same one-shot hand-off the 2h push uses — map plots a route to the venue.
    shareInbox.setRoute({ lat: e.venue.lat, lng: e.venue.lng, label: e.venue.label || e.title });
    onClose();
    router.push('/(app)/map' as any);
    shareInbox.ping();
  };

  const remove = () => {
    Alert.alert(`Delete ${copy.one}?`, 'Attendees will no longer see it.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { try { await deleteEvent(e.id); onDeleted(); } catch (err) { Alert.alert('Failed', formatErr(err)); } } },
    ]);
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
              <Ionicons name={copy.icon} size={18} color={COLORS.primary} />
              <Text style={styles.sheetTitle} numberOfLines={1}>{e.title}</Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}><Ionicons name="close" size={24} color={COLORS.text} /></TouchableOpacity>
          </View>
          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={styles.detailWhen}>{whenText(e.start_at)}</Text>
            {!!e.venue?.label && (
              <View style={styles.detailRow}>
                <Ionicons name="location" size={15} color={COLORS.textMute} />
                <Text style={styles.detailRowText} numberOfLines={2}>{e.venue.label}</Text>
              </View>
            )}
            {e.kind === 'cruise' && e.end?.label ? (
              <View style={styles.detailRow}>
                <Ionicons name="flag" size={15} color={COLORS.textMute} />
                <Text style={styles.detailRowText} numberOfLines={2}>{`Ends at ${e.end.label}`}</Text>
              </View>
            ) : null}
            <View style={styles.detailRow}>
              <Ionicons name="person-circle" size={15} color={COLORS.textMute} />
              <Text style={styles.detailRowText}>{`Hosted by ${e.creator_handle || 'a driver'}${e.is_public ? '' : ' · Club-only'}`}</Text>
            </View>
            {!!e.description && <Text style={styles.detailDesc}>{e.description}</Text>}

            {/* Live counts */}
            <View style={styles.countsRow}>
              <View style={styles.countBox}>
                <Text style={styles.countNum}>{e.attendee_count}</Text>
                <Text style={styles.countLabel}>attending</Text>
              </View>
              <View style={styles.countBox}>
                <Text style={[styles.countNum, { color: COLORS.primary }]}>{e.confirmed_count}</Text>
                <Text style={styles.countLabel}>confirmed</Text>
              </View>
            </View>

            {/* RSVP actions */}
            {!e.is_attending ? (
              <TouchableOpacity onPress={() => act(() => attendEvent(e.id))} activeOpacity={0.85}>
                <LinearGradient colors={[COLORS.primary, '#18B368']} style={styles.createBtn}>
                  <Text style={styles.createBtnText}>{busy ? '…' : "I'm interested — attend"}</Text>
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <>
                {!e.is_confirmed && (
                  <TouchableOpacity onPress={() => act(() => confirmEvent(e.id))} activeOpacity={0.85}>
                    <LinearGradient colors={[COLORS.primary, '#18B368']} style={styles.createBtn}>
                      <Text style={styles.createBtnText}>{busy ? '…' : "✓ I'm showing up"}</Text>
                    </LinearGradient>
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={routeThere} activeOpacity={0.85} style={styles.secondaryBtn}>
                  <Ionicons name="navigate" size={16} color={COLORS.primary} />
                  <Text style={styles.secondaryBtnText}>Route to the meet</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => act(() => unattendEvent(e.id))} style={styles.linkBtn}>
                  <Text style={styles.linkBtnText}>{`Can't make it`}</Text>
                </TouchableOpacity>
              </>
            )}

            {/* Roster */}
            {!!e.attendees_users?.length && (
              <>
                <Text style={[styles.label, { marginTop: 18 }]}>{`Who's in`}</Text>
                {e.attendees_users.map((u) => (
                  <View key={u.id} style={styles.rosterRow}>
                    <Ionicons name="person-circle-outline" size={20} color={COLORS.textMute} />
                    <Text style={styles.rosterHandle} numberOfLines={1}>{u.handle || 'driver'}</Text>
                    {!!(u.car_make || u.car_model) && <Text style={styles.rosterCar} numberOfLines={1}>{[u.car_make, u.car_model].filter(Boolean).join(' ')}</Text>}
                    {u.confirmed && <Text style={styles.confirmedPill}>GOING</Text>}
                  </View>
                ))}
              </>
            )}

            {e.is_creator && (
              <TouchableOpacity onPress={remove} style={[styles.linkBtn, { marginTop: 16, marginBottom: 24 }]}>
                <Text style={[styles.linkBtnText, { color: '#FF5A5A' }]}>{`Delete ${copy.one}`}</Text>
              </TouchableOpacity>
            )}
            <View style={{ height: 20 }} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ── styles (visual language copied from hub.tsx's club patterns) ─────────────
const styles = StyleSheet.create({
  segment: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 12, padding: 3, marginBottom: 12 },
  segmentBtn: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: 'center' },
  segmentBtnOn: { backgroundColor: 'rgba(255,255,255,0.12)' },
  segmentText: { color: COLORS.textMute, fontWeight: '700', fontSize: 13.5 },
  segmentTextOn: { color: COLORS.text },

  createRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  createIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  createText: { color: COLORS.text, fontWeight: '800', fontSize: 15.5 },

  emptyBox: { alignItems: 'center', gap: 10, padding: 26 },
  emptyText: { color: COLORS.textMute, textAlign: 'center', fontSize: 13.5, lineHeight: 19 },

  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  cardIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(45,236,134,0.12)', alignItems: 'center', justifyContent: 'center' },
  cardTitle: { color: COLORS.text, fontWeight: '800', fontSize: 15.5, flexShrink: 1 },
  clubPill: { color: '#0A1A10', backgroundColor: '#FFD60A', fontSize: 9.5, fontWeight: '900', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, overflow: 'hidden' },
  cardWhen: { color: COLORS.primary, fontWeight: '700', fontSize: 12.5, marginTop: 2 },
  cardVenue: { color: COLORS.textMute, fontSize: 12.5, marginTop: 2 },
  countPill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: COLORS.primary, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4 },
  countText: { color: '#0A1A10', fontWeight: '900', fontSize: 12.5 },

  modalRoot: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#101114', borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 18, maxHeight: '88%' },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 10 },
  sheetTitle: { color: COLORS.text, fontSize: 18, fontWeight: '800', flexShrink: 1 },

  label: { color: COLORS.textMute, fontSize: 12, fontWeight: '800', letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 6 },
  input: { backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11, color: COLORS.text, fontSize: 15 },

  venuePicked: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(45,236,134,0.10)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(45,236,134,0.35)', paddingHorizontal: 12, paddingVertical: 11 },
  venuePickedText: { color: COLORS.text, fontSize: 14.5, fontWeight: '600', flex: 1 },
  sugRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.08)' },
  sugText: { color: COLORS.text, fontSize: 14, flex: 1 },

  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18 },
  toggleTitle: { color: COLORS.text, fontWeight: '700', fontSize: 15 },
  toggleSub: { color: COLORS.textMute, fontSize: 12.5, marginTop: 2, lineHeight: 17 },
  helpText: { color: COLORS.textMute, fontSize: 12.5, marginTop: 8, lineHeight: 18 },
  clubChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  clubChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)', maxWidth: '100%' },
  clubChipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  clubChipText: { color: '#D9D9DE', fontSize: 13, fontWeight: '700' },
  clubChipTextOn: { color: '#0A1A10' },

  createBtn: { borderRadius: 14, paddingVertical: 13, alignItems: 'center', marginTop: 10 },
  createBtnText: { color: '#0A1A10', fontWeight: '900', fontSize: 15.5 },
  secondaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 14, paddingVertical: 12, marginTop: 10, borderWidth: 1.5, borderColor: 'rgba(45,236,134,0.5)' },
  secondaryBtnText: { color: COLORS.primary, fontWeight: '800', fontSize: 14.5 },
  linkBtn: { alignItems: 'center', paddingVertical: 10 },
  linkBtnText: { color: COLORS.textMute, fontWeight: '700', fontSize: 13.5 },

  detailWhen: { color: COLORS.primary, fontWeight: '800', fontSize: 15, marginBottom: 8 },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  detailRowText: { color: COLORS.text, fontSize: 13.5, flex: 1 },
  detailDesc: { color: COLORS.textMute, fontSize: 13.5, lineHeight: 19, marginTop: 8 },
  countsRow: { flexDirection: 'row', gap: 12, marginVertical: 14 },
  countBox: { flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 14, alignItems: 'center', paddingVertical: 12 },
  countNum: { color: COLORS.text, fontWeight: '900', fontSize: 22 },
  countLabel: { color: COLORS.textMute, fontSize: 11.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 2 },

  rosterRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.07)' },
  rosterHandle: { color: COLORS.text, fontWeight: '700', fontSize: 14, flexShrink: 1 },
  rosterCar: { color: COLORS.textMute, fontSize: 12.5, flex: 1 },
  confirmedPill: { color: '#0A1A10', backgroundColor: COLORS.primary, fontSize: 9.5, fontWeight: '900', paddingHorizontal: 7, paddingVertical: 2.5, borderRadius: 7, overflow: 'hidden' },
});
