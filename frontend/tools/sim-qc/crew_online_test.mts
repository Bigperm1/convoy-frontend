// crew_online_test.mts — the Crew pill turns green while another member is online (Jeff, 2026-09-23: "make the 1 crew
// pill turn green when members are online"). Runs the REAL src/presenceHub.ts against a fake Supabase realtime client
// (crew/stubs/supabase.mjs) whose presence state the test sets:
//   O1 nobody else connected → 0 (neutral pill)
//   O2 another member connected (live or parked) → 1 (green); self never counts; a peer with no position does not count
//   O3 the same member on two devices counts once
//   O4 the member leaves (sync without them) → back to 0, and subscribers are told
//   O5 ghost mode / no community → no topic → 0
//   O6 the count reads the CURRENT community's topic, not a club you just left
// Run: node --experimental-strip-types tools/sim-qc/crew_online_test.mts

import { register } from "node:module";
register("./crew/loader.mjs", import.meta.url);

const settings: any = await import(new URL("./crew/stubs/settings.mjs", import.meta.url).href);
const sb: any = await import(new URL("./crew/stubs/supabase.mjs", import.meta.url).href);
const hub: any = await import("../../src/presenceHub.ts");

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
};

const TOPIC_A = "convoy:community:A";
const TOPIC_B = "convoy:community:B";
settings.__reset({ activeCommunityId: "A" });
ok("O0 the crew topic is the active community's", hub.crewPresenceTopic() === TOPIC_A);

let told = 0;
const off = hub.subscribeOnlineCrew(() => { told++; });
const a = hub.joinPresence({ topic: TOPIC_A, selfId: "me", priority: 2, getPayload: () => null, onPeers: () => {} });

sb.__sync(TOPIC_A, { me: [{ lat: 49.2, lng: -123.1, status: "live" }] });
ok("O1 only me connected → 0 online (neutral)", hub.onlineCrewCount(hub.crewPresenceTopic()) === 0);

sb.__sync(TOPIC_A, {
  me: [{ lat: 49.2, lng: -123.1 }],
  olaf: [{ lat: 49.3, lng: -123.0, status: "live" }],
  noPos: [{ status: "live" }],
});
ok("O2 another member with a position → 1 online (green); self and position-less peers do not count",
  hub.onlineCrewCount(TOPIC_A) === 1);
sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }], olaf: [{ lat: 49.3, lng: -123.0, status: "parked" }] });
ok("O2b a PARKED member is online too (app connected)", hub.onlineCrewCount(TOPIC_A) === 1);

sb.__sync(TOPIC_A, { olaf: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], rodrigo: [{ lat: 3, lng: 3 }] });
ok("O3 one member on two devices counts once", hub.onlineCrewCount(TOPIC_A) === 2);

const before = told;
sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }] });
ok("O4 they leave → 0, and subscribers were told", hub.onlineCrewCount(TOPIC_A) === 0 && told > before, `told ${told - before}×`);

settings.__reset({ activeCommunityId: "A", avatarMode: "ghost" });
ok("O5 ghost mode → no topic → 0", hub.crewPresenceTopic() === null && hub.onlineCrewCount(hub.crewPresenceTopic()) === 0);
settings.__reset({});
ok("O5b no community → 0", hub.onlineCrewCount(hub.crewPresenceTopic()) === 0);

// The car service can briefly stay joined to the club you just left: that club's members must not turn the pill green.
sb.__sync(TOPIC_A, { olaf: [{ lat: 1, lng: 1 }] });
const b = hub.joinPresence({ topic: TOPIC_B, selfId: "me", priority: 1, getPayload: () => null, onPeers: () => {} });
sb.__sync(TOPIC_B, { me: [{ lat: 1, lng: 1 }] });
settings.__reset({ activeCommunityId: "B" });
ok("O6 switched to club B: A's online member does not count", hub.onlineCrewCount(hub.crewPresenceTopic()) === 0);

// Codex review of 970fbf32: supabase keeps the last presence state through CHANNEL_ERROR / TIMED_OUT, so a member who
// leaves during the outage stayed green. Offline → nobody; back → only after the next sync says who is there.
settings.__reset({ activeCommunityId: "A" });
sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }], olaf: [{ lat: 1, lng: 1 }] });
ok("O8 pre: olaf online on A", hub.onlineCrewCount(TOPIC_A) === 1);
const beforeErr = told;
sb.__status(TOPIC_A, "CHANNEL_ERROR");
ok("O8 channel error → 0 at once, and subscribers were told", hub.onlineCrewCount(TOPIC_A) === 0 && told > beforeErr);
sb.__status(TOPIC_A, "TIMED_OUT");
ok("O8b still down → 0", hub.onlineCrewCount(TOPIC_A) === 0);
sb.__status(TOPIC_A, "SUBSCRIBED");
ok("O9 rejoined but not synced → still 0 (the old list is not trusted)", hub.onlineCrewCount(TOPIC_A) === 0);
sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }] });
ok("O9b first sync: olaf left during the outage → 0", hub.onlineCrewCount(TOPIC_A) === 0);
sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }], olaf: [{ lat: 1, lng: 1 }] });
ok("O9c olaf back → 1", hub.onlineCrewCount(TOPIC_A) === 1);

const beforeLeave = told;
a.leave();
ok("O7 leaving a topic tells subscribers (the pill re-reads)", told > beforeLeave);
b.leave();
off();

console.log(failed ? `\nFAIL crew_online (${failed})` : "\nPASS crew_online");
process.exit(failed ? 1 : 0);
