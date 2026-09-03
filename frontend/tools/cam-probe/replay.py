#!/usr/bin/env python3
"""Replay a cam-probe target trace through the camera low-pass, with and without the slew.

Input: one line, rows separated by ';', each `epoch,z,zt,p,pt,spd` — the string_agg from:
  select string_agg(round(extract(epoch from created_at)::numeric,1)::text||','||
    (regexp_match(message,' z=([0-9.]+)'))[1]||','||(regexp_match(message,' zt=([0-9.]+)'))[1]||','||
    (regexp_match(message,' p=([0-9.]+)'))[1]||','||(regexp_match(message,' pt=([0-9.]+)'))[1]||','||
    (regexp_match(message,' spd=([0-9]+)'))[1], ';' order by created_at)
  from crash_reports where handle='<h>' and message like 'cam-probe surf=car%' and created_at > now()-interval '12 hours';
The target is held constant between rows (the probe only logs when the applied zoom moved),
so this is a faithful replay of every cliff and a lower bound on small creep.
Usage: replay.py trace.txt [slew_levels_per_s] [deadband] [tau_s]
"""
import sys, math
def main():
    rows=[tuple(map(float,r.split(','))) for r in open(sys.argv[1]).read().strip().split(';') if r.strip()]
    slew=float(sys.argv[2]) if len(sys.argv)>2 else 0.5; dead=float(sys.argv[3]) if len(sys.argv)>3 else 0.25; tau=float(sys.argv[4]) if len(sys.argv)>4 else 1.4
    t0=rows[0][0]; T=[r[0]-t0 for r in rows]; ZT=[r[2] for r in rows]
    def sim(use_slew):
        dt=1/60; z=goal=ZT[0]; i=0; t=0.0; per={}
        while t<=T[-1]:
            while i+1<len(T) and T[i+1]<=t: i+=1
            zt=ZT[i]
            if not use_slew: goal=zt
            elif abs(zt-goal)>=dead:
                step=slew*dt; goal+=max(-step,min(step,zt-goal))
            z+=(goal-z)*(1-math.exp(-dt/tau)); per.setdefault(int(t),[]).append(z); t+=dt
        ks=sorted(per); rates=[abs(per[k][-1]-per[k][0]) for k in ks]
        r2=[abs(per[ks[j+1]][-1]-per[ks[j]][0]) for j in range(len(ks)-1)]
        return max(rates), max(r2), sum(r>=0.9 for r in rates), sum(r>=0.5 for r in rates), sum(r>=0.3 for r in rates), sum(r>=0.05 for r in rates)/len(rates)
    print(f"rows {len(rows)} span {T[-1]/60:.1f} min")
    print(f"{'filter':<26}{'max lvl/s':>10}{'max/2s':>8}{'s>=0.9':>7}{'s>=0.5':>7}{'s>=0.3':>7}{'moving':>8}")
    for name,u in (("current (tau only)",False),(f"slew {slew}/s dead {dead}",True)):
        m=sim(u); print(f"{name:<26}{m[0]:>10.2f}{m[1]:>8.2f}{m[2]:>7d}{m[3]:>7d}{m[4]:>7d}{100*m[5]:>7.0f}%")
if __name__=="__main__": main()
