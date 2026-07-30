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
import { cruisePlot } from './cruisePlot';
import CruisePlanMap, { type PlanStyle, type PlanRoutes } from './components/CruisePlanMap';
import { optimizeStopOrder, isSameOrder, ROUTABLE_MAX_STOPS } from './routeOptimizer';
import { scoutScenicStops } from './scoutScenic';
import {
  type HubEvent, type EventPoint, createEvent, myEvents, discoverEvents,
  getEvent, attendEvent, confirmEvent, unattendEvent, deleteEvent,
} from './eventsApi';
import { updateWidgetFeed } from './widgetFeed';

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
      updateWidgetFeed(m); // keep the home-screen widget's "Next up" fresh (build 65+)
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
  const [stops, setStops] = useState<EventPoint[]>([]);              // cruise only (waypoints)
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

  // ── PLAN ON THE MAP + SCOUT'S BEST ORDER (2026-07-29) ───────────────────────
  // Jeff asked for the map planner and for Scout's re-ordering to work here too.
  //
  // ONE DELIBERATE DIFFERENCE FROM THE DRIVE MAP: on a live route Scout re-orders
  // automatically, because there the only goal is to get there fastest. A CRUISE is
  // often the opposite — a deliberately scenic loop where the "inefficient" order IS
  // the plan. Auto-optimising would quietly destroy a hand-built Sea-to-Sky run. So
  // here it is a BUTTON: same exact solver, driver's choice when to apply it.
  const [ordering, setOrdering] = useState(false);
  // ── ROUTE STYLE (2026-07-29) ────────────────────────────────────────────────
  // Jeff: "could we have a selection tool like Best route and Scenic route, kind
  // like the maps one, which takes into consideration the stops."
  // Both variants are routed through the SAME pinned stops — the choice is how they
  // get between them. Scenic EXCLUDES MOTORWAYS, which is what makes the word mean
  // something: note the drive map's own "Scenic" is only a label on Mapbox's first
  // alternate (ConvoyMapbox routeKindFor), usually just another freeway.
  const [routeStyle, setRouteStyle] = useState<PlanStyle>('fastest');
  const [planRoutes, setPlanRoutes] = useState<PlanRoutes>({ fastest: null, scenic: null });
  const fmtLeg = (r: { distanceM: number; durationS: number } | null) => {
    if (!r) return 'unavailable';
    const km = r.distanceM / 1000;
    const mins = Math.round(r.durationS / 60);
    const h = Math.floor(mins / 60), m = mins % 60;
    const t = h > 0 ? `${h}h ${m}m` : `${m} min`;
    return `${t} · ${km < 100 ? km.toFixed(1) : Math.round(km)} km`;
  };
  // Which of the two is actually quicker. Caught in the simulator: the no-exclusion
  // route was labelled "Fastest 9 min" right next to "Scenic 4 min", because avoiding
  // the motorway around an interchange can genuinely be shorter. A chip the screen
  // disproves is worse than no chip, so the titles now describe what each route IS
  // (Direct / Scenic) and the quicker one is MARKED from the data instead of asserted.
  const quicker: PlanStyle | null = (() => {
    const f = planRoutes.fastest?.durationS, sc = planRoutes.scenic?.durationS;
    if (typeof f !== 'number' || typeof sc !== 'number') return null;
    if (Math.abs(f - sc) < 60) return null;         // a wash — don't crown either
    return f < sc ? 'fastest' : 'scenic';
  })();
  const bestOrder = async () => {
    if (!venue || !end || stops.length < 2 || ordering) return;
    setOrdering(true);
    try {
      const res = await optimizeStopOrder(venue, stops, end);
      if (!res) { Alert.alert('Could not reorder', 'Scout could not work out a better order for these stops.'); return; }
      if (isSameOrder(res.order)) { Alert.alert('Already optimal', 'These stops are already in the fastest order.'); return; }
      setStops(res.order.map((i) => stops[i]));
      const savedMin = res.savedSec ? Math.round(res.savedSec / 60) : 0;
      Alert.alert(
        'Reordered',
        savedMin >= 1
          ? `Scout put your ${stops.length} stops in the fastest order — about ${savedMin} ${savedMin === 1 ? 'minute' : 'minutes'} quicker.`
          : `Scout put your ${stops.length} stops in the fastest order.`,
      );
    } finally {
      setOrdering(false);
    }
  };

  // ── ASK SCOUT FOR GOOD ROADS ────────────────────────────────────────────────
  // The one place a model belongs in route planning: which roads are worth driving.
  // It returns NAMES; scoutScenic geocodes them, so a hallucinated suggestion fails to
  // resolve rather than becoming a pin (see the note in scoutScenic.ts).
  const [asking, setAsking] = useState(false);
  const askScoutForRoads = async () => {
    if (!venue || asking) return;
    setAsking(true);
    try {
      const room = ROUTABLE_MAX_STOPS - stops.length;
      if (room <= 0) { Alert.alert('Full', `${ROUTABLE_MAX_STOPS} stops is the most one route can hold.`); return; }
      const { stops: found, unavailable } = await scoutScenicStops({
        origin: venue,
        dest: end,
        note: desc.trim() || undefined,   // the description is a free hint ("coastal run")
        maxStops: Math.min(3, room),
      });
      if (unavailable) {
        Alert.alert('Scout is offline', "Scout's road suggestions need the latest backend — nothing was changed.");
        return;
      }
      if (!found.length) {
        Alert.alert('Nothing to add', "Scout couldn't find roads it was confident about for this route.");
        return;
      }
      setStops((cur) => [...cur, ...found.slice(0, ROUTABLE_MAX_STOPS - cur.length).map((f) => ({ lat: f.lat, lng: f.lng, label: f.label }))]);
      Alert.alert(
        'Scout added stops',
        found.map((f) => `${f.label}${f.why ? ` — ${f.why}` : ''}`).join('\n\n'),
      );
    } finally {
      setAsking(false);
    }
  };

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
        ...(kind === 'cruise' ? { departure_at: when.toISOString(), stops } : {}),
        // Store the line the creator actually chose. The backend has always accepted
        // `polyline` ("precomputed cruise route") on both create and update, so what the
        // crew drives is the route that was planned — Fastest or Scenic — rather than
        // something re-derived later from the waypoints alone.
        ...(kind === 'cruise' && (routeStyle === 'scenic' ? planRoutes.scenic : planRoutes.fastest)
          ? { polyline: (routeStyle === 'scenic' ? planRoutes.scenic! : planRoutes.fastest!).polyline }
          : {}),
        // The STYLE has to survive too, or plotting the cruise later would rebuild a
        // fastest route through the same stops and quietly discard the scenic choice.
        // `tags` is already accepted on create and update, so this needs no backend
        // change; the plot path reads it back below.
        ...(kind === 'cruise' && routeStyle === 'scenic' ? { tags: ['scenic'] } : {}),
      });
      onCreated(e);
      // reset for next time
      setTitle(''); setDesc(''); setVenue(null); setEnd(null); setStops([]); setWhen(defaultStart()); setIsPublic(true); setNotify(true); setClubId(null);
      setRouteStyle('fastest'); setPlanRoutes({ fastest: null, scenic: null });
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
            {kind === 'cruise' && (
              <>
                {/* Stops along the way (P3) — venue → stops → end becomes the
                    pre-designed route pushed to attendees on arrival. */}
                {/* PLAN IT ON THE MAP — the route drawn through meeting point → stops →
                    end, pinch to zoom, tap to drop a stop wherever you are looking.
                    Shown as soon as there is a meeting point to anchor it. */}
                {venue && (
                  <>
                    <Text style={[styles.label, { marginTop: 14 }]}>Plan on the map</Text>
                    <CruisePlanMap
                      start={venue}
                      stops={stops}
                      end={end}
                      style={routeStyle}
                      onRoutes={setPlanRoutes}
                      onAddStop={(p) => setStops((cur) => (
                        cur.length >= ROUTABLE_MAX_STOPS
                          ? cur
                          : [...cur, { ...p, label: `Stop ${cur.length + 1}` }]
                      ))}
                    />
                    {/* Both options with their real numbers — tap to choose. The
                        unselected line stays drawn (dimmed) so the trade-off is visible
                        on the map, not just in the chip. Only meaningful once there are
                        two ends to route between. */}
                    {(end || stops.length > 0) && (
                      <View style={styles.styleRow}>
                        {(['fastest', 'scenic'] as PlanStyle[]).map((k) => {
                          const r = k === 'scenic' ? planRoutes.scenic : planRoutes.fastest;
                          const on = routeStyle === k;
                          return (
                            <TouchableOpacity
                              key={k}
                              onPress={() => setRouteStyle(k)}
                              disabled={!r}
                              style={[styles.styleChip, on && styles.styleChipOn, !r && styles.styleChipOff]}
                              activeOpacity={0.85}
                            >
                              <Ionicons
                                name={k === 'scenic' ? 'leaf' : 'flash'}
                                size={13}
                                color={on ? '#0B0B0C' : COLORS.textMute}
                              />
                              <View style={{ minWidth: 0 }}>
                                <Text style={[styles.styleChipTitle, on && styles.styleChipTitleOn]}>
                                  {k === 'scenic' ? 'Scenic' : 'Direct'}
                                  {quicker === k ? ' · quickest' : ''}
                                </Text>
                                <Text style={[styles.styleChipSub, on && styles.styleChipSubOn]} numberOfLines={1}>
                                  {fmtLeg(r)}
                                </Text>
                              </View>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    )}
                    {routeStyle === 'scenic' && !planRoutes.scenic && (
                      <Text style={styles.helpText}>No motorway-free route exists between these points — showing the fastest one.</Text>
                    )}
                    {/* Scout's road knowledge — names good driving roads between the
                        ends and drops them in as stops. Distinct from the Scenic chip,
                        which only changes HOW the line travels between what you pinned. */}
                    <TouchableOpacity onPress={askScoutForRoads} disabled={asking} style={styles.bestOrderBtn} activeOpacity={0.85}>
                      <Ionicons name={asking ? 'hourglass-outline' : 'sparkles'} size={15} color={COLORS.primary} />
                      <Text style={styles.bestOrderText}>
                        {asking ? 'Scout is thinking…' : 'Ask Scout for good roads'}
                      </Text>
                    </TouchableOpacity>
                  </>
                )}

                {stops.length > 0 && (
                  <View style={{ marginTop: 14 }}>
                    <Text style={styles.label}>{`Stops along the way (${stops.length})`}</Text>
                    {stops.map((s, i) => (
                      <View key={`${s.lat},${s.lng},${i}`} style={styles.stopRow}>
                        <Text style={styles.stopNum}>{i + 1}</Text>
                        {/* NAMEABLE (Jeff: "add a label to the stops when creating a
                            cruise"). Edited in place — attendees see these names in the
                            detail sheet and when the route is plotted. */}
                        <TextInput
                          style={styles.stopInput}
                          value={s.label ?? ''}
                          onChangeText={(t) => setStops((cur) => cur.map((st, j) => (j === i ? { ...st, label: t } : st)))}
                          placeholder={`${s.lat.toFixed(4)}, ${s.lng.toFixed(4)}`}
                          placeholderTextColor={COLORS.textMute}
                        />
                        <TouchableOpacity onPress={() => setStops((cur) => cur.filter((_, j) => j !== i))} hitSlop={8}>
                          <Ionicons name="close-circle" size={18} color={COLORS.textMute} />
                        </TouchableOpacity>
                      </View>
                    ))}
                    {/* Scout's solver, on demand — see bestOrder for why this is a button
                        here and automatic on a live route. */}
                    {stops.length >= 2 && !!end && (
                      <TouchableOpacity onPress={bestOrder} disabled={ordering} style={styles.bestOrderBtn} activeOpacity={0.85}>
                        <Ionicons name={ordering ? 'hourglass-outline' : 'swap-vertical'} size={15} color={COLORS.primary} />
                        <Text style={styles.bestOrderText}>
                          {ordering ? 'Working out the best order…' : 'Let Scout pick the best order'}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}
                {stops.length < ROUTABLE_MAX_STOPS ? (
                  <VenueField label={stops.length ? 'Add another stop' : 'Add a stop (optional)'} value={null} onPick={(p) => { if (p) setStops((cur) => [...cur, p]); }} />
                ) : (
                  <Text style={styles.helpText}>{`${ROUTABLE_MAX_STOPS} stops is the most one route can hold.`}</Text>
                )}
                <VenueField label="End location" value={end} onPick={setEnd} />
              </>
            )}

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

  const plotCruise = () => {
    // The PRE-DESIGNED route: meeting point → stops → end, same hand-off the
    // arrival push uses (cruisePlot one-shot; map builds the multi-stop line).
    cruisePlot.set({
      title: e.title, venue: e.venue, stops: e.stops || [], end: e.end || null,
      scenic: (e.tags || []).includes('scenic'),
    });
    onClose();
    router.push('/(app)/map' as any);
    cruisePlot.ping();
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
            {e.kind === 'cruise' && (e.stops || []).map((s, i) => (
              <View key={`st${i}`} style={styles.detailRow}>
                <Ionicons name="ellipse-outline" size={13} color={COLORS.textMute} />
                <Text style={styles.detailRowText} numberOfLines={1}>{`Stop ${i + 1}: ${s.label || `${s.lat.toFixed(3)}, ${s.lng.toFixed(3)}`}`}</Text>
              </View>
            ))}
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
                {e.kind === 'cruise' && (e.end || (e.stops || []).length > 0) && (
                  <TouchableOpacity onPress={plotCruise} activeOpacity={0.85} style={styles.secondaryBtn}>
                    <Ionicons name="git-branch" size={16} color={COLORS.primary} />
                    <Text style={styles.secondaryBtnText}>Plot the cruise route</Text>
                  </TouchableOpacity>
                )}
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
  stopRow: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 10, paddingHorizontal: 11, paddingVertical: 9, marginBottom: 6 },
  stopNum: { color: '#0A1A10', backgroundColor: COLORS.primary, width: 20, height: 20, borderRadius: 10, textAlign: 'center', fontWeight: '900', fontSize: 12, lineHeight: 20, overflow: 'hidden' },
  stopLabel: { color: COLORS.text, fontSize: 13.5, flex: 1 },
  // Editable stop name (cruise planner). Borderless so the row still reads as a list
  // rather than a form, but it IS a text field.
  stopInput: {
    color: COLORS.text, fontSize: 13.5, flex: 1, paddingVertical: 4, paddingHorizontal: 0,
  },
  bestOrderBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 8,
    paddingVertical: 9, paddingHorizontal: 12, borderRadius: 10,
    borderWidth: 1, borderColor: COLORS.primary + '55', backgroundColor: COLORS.primary + '14',
  },
  bestOrderText: { color: COLORS.primary, fontSize: 13, fontWeight: '700' },
  styleRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  styleChip: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingVertical: 8, paddingHorizontal: 10, borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', backgroundColor: 'rgba(255,255,255,0.04)',
  },
  styleChipOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  styleChipOff: { opacity: 0.45 },
  styleChipTitle: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  styleChipTitleOn: { color: '#0B0B0C' },
  styleChipSub: { color: COLORS.textMute, fontSize: 11, fontWeight: '600' },
  styleChipSubOn: { color: '#0B0B0C', opacity: 0.75 },
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
