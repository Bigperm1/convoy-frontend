import React from 'react';
import { Image, ImageStyle, StyleProp } from 'react-native';

interface Props {
  size?: number;
  style?: StyleProp<ImageStyle>;
}

export default function ConvoyLogo({ size = 120, style }: Props) {
  return (
    <Image
      source={require('../../assets/HAIRPIN.png')}
      style={[{ width: size, height: size, borderRadius: size * 0.28 }, style]}
      resizeMode="cover"
    />
  );
}
