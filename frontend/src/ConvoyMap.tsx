import React, { forwardRef, useEffect, useRef, useState } from "react";
import { View, StyleSheet } from "react-native";
import { NavigationView } from "@googlemaps/react-native-navigation-sdk";
import { getVehiclePngDataUriOrDefault } from "./vehicleAssets";

export interface Peer {
  user_id: string;
  handle?: string;
  lat: number;
  lng: number;
  heading?: number;
  speed?: number;
  carType?: string;
  carBody?: string;
  carColor?: string;
  topSpeed?: number;
  online_at?: string;
  onRoute?: React.Dispatch<any>;
}

export interface Hazard {
  id: string;
  kind: string;
  lat: number;
  lng: number;
  subtype?: string;
  confirms?: number;
  disputes?: number;
  reporter_handle?: string;
  reportedAt?: string;
}

export interface UserLocation {
  heading?: number;
  carBody?: string;
  carColor?: string;
  lat?: number;
  lng?: number;
  speed?: number;
}

// Accept the full prop surface map.tsx passes (route/hazard/etc.) without
// breaking types; Phase 1 implements the car markers (self + peers). The
// remaining props are accepted and passed through for later phases.
interface ConvoyMapProps {
  center?: { lat: number; lng: number; heading?: number } | null;
  user?: UserLocation | null;
  hideSelfMarker?: boolean;
  peers?: Record<string, Peer> | Peer[] | null;
  [key: string]: any;
}

const SELF_ID = "self";

type CarPoint = { id: string; lat: number; lng: number; color?: string; heading?: number };

const ConvoyMap = forwardRef<any, ConvoyMapProps>((props, ref) => {
  const { user, peers, hideSelfMarker, onMapReady } = props;
  const [mapCtrl, setMapCtrl] = useState<any>(null);
  const drawnIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!mapCtrl) return;
    let cancelled = false;

    const desired: CarPoint[] = [];

    // "You" marker — your own car, in your profile color, rotated to heading.
    // Suppressed when Avatar Live is OFF (hideSelfMarker).
    if (
      !hideSelfMarker &&
      user &&
      typeof user.lat === "number" &&
      typeof user.lng === "number"
    ) {
      desired.push({
        id: SELF_ID,
        lat: user.lat,
        lng: user.lng,
        color: user.carColor,
        heading: user.heading,
      });
    }

    // Every other member in the community.
    const peerList: Peer[] = Array.isArray(peers)
      ? peers
      : peers
      ? Object.values(peers)
      : [];
    peerList.forEach((p) => {
      if (p && typeof p.lat === "number" && typeof p.lng === "number") {
        desired.push({
          id: "peer_" + p.user_id,
          lat: p.lat,
          lng: p.lng,
          color: p.carColor,
          heading: p.heading,
        });
      }
    });

    const nextIds = new Set(desired.map((d) => d.id));

    // Remove markers that are no longer present.
    drawnIds.current.forEach((id) => {
      if (!nextIds.has(id)) {
        try {
          mapCtrl.removeMarker(id);
        } catch (e) {}
      }
    });

    // Add or update markers (addMarker updates in place when id matches).
    (async () => {
      for (const d of desired) {
        try {
          await mapCtrl.addMarker({
            id: d.id,
            position: { lat: d.lat, lng: d.lng },
            imgPath: getVehiclePngDataUriOrDefault(d.color),
            rotation: d.heading || 0,
            flat: true,
          });
        } catch (e) {}
      }
      if (!cancelled) drawnIds.current = nextIds;
    })();

    return () => {
      cancelled = true;
    };
  }, [mapCtrl, user, peers, hideSelfMarker]);

  return (
    <View style={styles.container} ref={ref as any}>
      <NavigationView
        style={styles.map}
        onMapViewControllerCreated={setMapCtrl}
        onMapReady={() => {
          if (typeof onMapReady === "function") onMapReady();
        }}
      />
    </View>
  );
});

ConvoyMap.displayName = "ConvoyMap";
export default ConvoyMap;

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
});
