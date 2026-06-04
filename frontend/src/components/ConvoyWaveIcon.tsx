import React from 'react';
import Svg, { Line, Path } from 'react-native-svg';

/**
 * Comms "sound wave" tab icon — three center bars (like a voice level meter)
 * with concentric arcs radiating left and right (broadcasting). Stroke color
 * is driven by the `color` prop so it tints with the tab's active/inactive
 * state. Mirrors the reference art the user provided for the Comms tab.
 */
export default function ConvoyWaveIcon({
  size = 24,
  color = '#FFD60A',
}: {
  size?: number;
  color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* center voice-level bars */}
      <Line x1={12} y1={6.5} x2={12} y2={17.5} stroke={color} strokeWidth={1.9} strokeLinecap="round" />
      <Line x1={9} y1={9} x2={9} y2={15} stroke={color} strokeWidth={1.9} strokeLinecap="round" />
      <Line x1={15} y1={9} x2={15} y2={15} stroke={color} strokeWidth={1.9} strokeLinecap="round" />
      {/* right radiating arcs */}
      <Path d="M17 9 A 3.5 3.5 0 0 1 17 15" stroke={color} strokeWidth={1.7} strokeLinecap="round" />
      <Path d="M19.6 7.2 A 5.7 5.7 0 0 1 19.6 16.8" stroke={color} strokeWidth={1.7} strokeLinecap="round" />
      {/* left radiating arcs */}
      <Path d="M7 9 A 3.5 3.5 0 0 0 7 15" stroke={color} strokeWidth={1.7} strokeLinecap="round" />
      <Path d="M4.4 7.2 A 5.7 5.7 0 0 0 4.4 16.8" stroke={color} strokeWidth={1.7} strokeLinecap="round" />
    </Svg>
  );
}
