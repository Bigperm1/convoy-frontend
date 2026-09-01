#!/usr/bin/env python3
"""
Prove that a published OTA bundle actually contains EXPO_PUBLIC_OPENWEATHER_KEY.

WHY THIS EXISTS. `eas update` inlines process.env.EXPO_PUBLIC_* at export time from the
LOCAL .env only — it does NOT read the EAS server-side environments. The OpenWeather key
lives ONLY in the EAS preview/production environments (deliberately: this repo is PUBLIC,
so unlike PROD_MAPS_KEY it is not hardcoded in src/api.ts). PROD_OPENWEATHER_KEY is "",
so a bare `eas update` ships an empty key and weatherLayer returns null before any network
call. Completely silent: no error, the chip just never appears. That cost 13 OTAs over
20 hours on 2026-08-30/31 before anyone noticed.

So: publish through `eas env:exec`, then run THIS to prove it worked before telling
testers to tap the red pill.

  npx eas-cli env:exec preview 'printf "%s" "$EXPO_PUBLIC_OPENWEATHER_KEY" > ow.key'
  python3 tools/ota/verify-bundle-key.py <update-group-id> <runtimeVersion>

Expect on BOTH platforms:  KEY_PRESENT=1  openweathermap=2  neg_control=0
Run it against the PREVIOUS group as a control — that one should read KEY_PRESENT=0 if it
was published before the fix.

The key's VALUE is never printed: only presence counts. ow.key is read from the same
directory as this script by default; keep it out of git.

⚠ The manifest fetch uses curl, NOT Python urllib: u.expo.dev returns 403 to urllib's
default User-Agent, which looks exactly like an expired session and sends you debugging
the wrong thing.
"""
import json,subprocess,re,os,sys
SP=os.path.dirname(os.path.abspath(__file__))
KEY=open(os.path.join(SP,'ow.key'),'rb').read().strip()
assert len(KEY)==32, "key file wrong length"
gid, rtv = sys.argv[1], sys.argv[2]
j=json.loads(subprocess.run(['npx','eas-cli','update:view',gid,'--json'],capture_output=True,text=True).stdout)
for u in j:
    plat, uid = u['platform'], u['id']
    d=subprocess.run(['curl','-sS','-H','accept: multipart/mixed','-H','expo-platform: '+plat,
        '-H','expo-runtime-version: '+rtv,'-H','expo-protocol-version: 1',
        'https://u.expo.dev/update/'+uid],capture_output=True).stdout.decode('utf8','replace')
    m=re.search(r'"launchAsset":\{"hash":"[^"]*","key":"([^"]*)","contentType":"[^"]*","url":"([^"]*)"',d)
    if not m: print(f"  {plat}: no launchAsset"); continue
    k,url=m.group(1),m.group(2)
    hm=re.search(r'"'+k+r'":\{"authorization":"([^"]*)"',d)
    cmd=['curl','-sS','-o','-']
    if hm: cmd+=['-H','authorization: '+hm.group(1)]
    cmd.append(url)
    data=subprocess.run(cmd,capture_output=True).stdout
    # counts only — the key value itself is never printed
    print(f"  {plat:<8} size={len(data):<9} KEY_PRESENT={1 if KEY in data else 0}"
          f"  openweathermap={data.count(b'openweathermap')}"
          f"  neg_control={1 if b'deadbeefdeadbeefdeadbeefdeadbeef' in data else 0}")
