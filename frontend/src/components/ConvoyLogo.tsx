import React from 'react';
import { Image, ImageStyle, StyleProp } from 'react-native';

interface Props {
  size?: number;
  style?: StyleProp<ImageStyle>;
}

export default function ConvoyLogo({ size = 120, style }: Props) {
  return (
    <Image
      source={require('../../assets/icon.png')}
      style={[{ width: size, height: size }, style]}
      resizeMode="contain"
    />
  );
}
