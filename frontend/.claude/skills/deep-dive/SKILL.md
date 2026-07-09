---
name: deep-dive
description: Run a "no guessing" audit of a subsystem (battery, CarPlay reliability, performance, audio) by fanning out parallel read-only agents, verifying every claim against the code, and returning ranked fixes split into OTA-able vs build-bound. Use for "deep dive", "audit this", "find what's causing X — no guessing".
---

# Deep-dive audit (no guessing)

Jeff's rule for these: **"be surgical, no guessing."** Findings must be verified against the actual code before they become recommendations — a plausible-sounding fix that breaks something is worse than no fix.

## 1. Decompose the problem into subsystems
Pick 3–5 orthogonal lenses for the symptom. Examples used before:
- **Battery/heat**: GPS/location watchers · timers/network polling · map rendering/animation loops · sockets/audio/background tasks
- **CarPlay reliability**: connection lifecycle · location/background feeds · keep-awake/screen-sleep · scene/window management

## 2. Fan out parallel READ-ONLY agents (Workflow or Agent tool)
One agent per lens. Each agent must return: findings with `file:line` evidence, estimated impact, and a proposed fix. Agents read; they never edit.

## 3. Verify before recommending (the critical step)
For every finding, re-read the cited code in the main loop and check for documented traps before accepting it:
- Search for comments explaining WHY the "wasteful" code exists.
- Check memory files for known landmines.
- Canonical example: the battery audit recommended removing the "redundant" CarPlay foreground GPS feed — but `navNotification.ts:305` documents it as the sole main-context carStore writer; removing it re-breaks CarPlay. VERIFIED = rejected.
Anything that can't be verified gets labeled a hypothesis, not a finding.

## 4. Report: ranked fixes in two buckets
| Bucket | Meaning |
|---|---|
| **OTA-able** | JS-only, shippable now via `/ship-ota` |
| **Build-bound** | Needs native change — queue into the current build backlog memory file, do NOT cut a build for it |

Rank by impact. For each: what it fixes, the risk, and whether it touches the premium feel (Jeff's constraint: never trade premium feel for optimization without asking).

## 5. Let Jeff pick
Present the ranked list and let him choose what ships. Quick wins → OTA now; native ones → batch. Never ship the whole list unprompted.
