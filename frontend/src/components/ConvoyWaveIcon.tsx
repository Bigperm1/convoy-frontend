import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

/**
 * Comms tab icon — the classic wireless "broadcast" symbol: a solid center dot
 * with concentric arcs radiating left and right (transmitting both ways), per
 * the reference the user picked. The `color` prop drives both the dot fill and
 * the arc stroke so it tints with the tab's active/inactive state.
 */
export default function ConvoyWaveIcon({
  size = 24,
  color = '#2DEC86',
}: {
  size?: number;
  color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* solid center dot */}
      <Circle cx={12} cy={12} r={2.2} fill={color} />
      {/* right radiating arcs */}
      <Path d="M15.2 8.8 A 4 4 0 0 1 15.2 15.2" stroke={color} strokeWidth={1.9} strokeLinecap="round" />
      <Path d="M18 6.8 A 6.4 6.4 0 0 1 18 17.2" stroke={color} strokeWidth={1.9} strokeLinecap="round" />
      {/* left radiating arcs */}
      <Path d="M8.8 8.8 A 4 4 0 0 0 8.8 15.2" stroke={color} strokeWidth={1.9} strokeLinecap="round" />
      <Path d="M6 6.8 A 6.4 6.4 0 0 0 6 17.2" stroke={color} strokeWidth={1.9} strokeLinecap="round" />
    </Svg>
  );
}
