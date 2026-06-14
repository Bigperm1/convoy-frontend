import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Dimensions,
  TouchableOpacity,
  StyleSheet,
  ImageBackground,
  SafeAreaView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Router gate (app/index.tsx) imports this key to decide first-launch routing.
export const ONBOARDING_KEY = 'convoy:onboarded:v1';

const { width: SCREEN_W } = Dimensions.get('window');

const screens = [
  {
    id: 'drive-together',
    title: 'Drive Together',
    description: 'See your convoy in real time. Every car, every hazard, every turn.',
    image: require('../assets/onboarding/drive_together.jpg'),
    btnText: 'Continue',
  },
  {
    id: 'talk-hands-free',
    title: 'Talk Hands-Free',
    description: 'Push-to-talk walkie-talkie built for the road. HD audio when your crew is close.',
    image: require('../assets/onboarding/talk_hands-free.jpg'),
    btnText: 'Continue',
  },
  {
    id: 'own-the-road',
    title: 'Own the Road',
    description: 'Report hazards, share music, and convoy as one.',
    image: require('../assets/onboarding/own_the_road.jpg'),
    btnText: 'Lets Roll →',
  },
];

export default function Onboarding() {
  const [currentIdx, setCurrentIdx] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const router = useRouter();

  const finish = async () => {
    try {
      await AsyncStorage.setItem(ONBOARDING_KEY, '1');
    } catch (e) {
      console.error('Failed to set onboarding key:', e);
    }
    router.replace('/(auth)/login');
  };

  const goNext = () => {
    if (currentIdx < screens.length - 1) {
      const next = currentIdx + 1;
      scrollRef.current?.scrollTo({ x: next * SCREEN_W, animated: true });
      setCurrentIdx(next);
    } else {
      finish();
    }
  };

  const current = screens[currentIdx];

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.logo}>CONVOY</Text>
        <TouchableOpacity onPress={finish}>
          <Text style={styles.skip}>Skip</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        style={styles.scroller}
      >
        {screens.map((screen) => (
          <View key={screen.id} style={[styles.slide, { width: SCREEN_W }]}>
            <ImageBackground source={screen.image} style={styles.image} resizeMode="cover">
              <LinearGradient
                colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.3)', 'rgba(0,0,0,0.85)']}
                style={styles.gradient}
              />
            </ImageBackground>
            <View style={styles.content}>
              <Text style={styles.title}>{screen.title}</Text>
              <Text style={styles.description}>{screen.description}</Text>
            </View>
          </View>
        ))}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.dots}>
          {screens.map((_, idx) => (
            <View key={idx} style={[styles.dot, idx === currentIdx && styles.dotActive]} />
          ))}
        </View>
        <TouchableOpacity onPress={goNext} style={styles.btn} activeOpacity={0.85}>
          <LinearGradient
            colors={['#7DF0B0', '#2DEC86', '#00C46A']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.btnGradient}
          >
            <Text style={styles.btnText}>{current.btnText}</Text>
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#000' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, position: 'absolute', top: 50, left: 0, right: 0, zIndex: 10 },
  logo: { color: '#2DEC86', fontSize: 16, fontWeight: '700', letterSpacing: 2 },
  skip: { color: '#808080', fontSize: 14, fontWeight: '500' },
  scroller: { flex: 1 },
  slide: { flex: 1, justifyContent: 'flex-end' },
  image: { ...StyleSheet.absoluteFillObject },
  gradient: { ...StyleSheet.absoluteFillObject },
  content: { paddingHorizontal: 24, paddingBottom: 180 },
  title: { color: '#F4F4F4', fontSize: 34, fontWeight: '800', marginBottom: 12, lineHeight: 40 },
  description: { color: '#808080', fontSize: 16, lineHeight: 24 },
  footer: { paddingHorizontal: 24, paddingBottom: 40, gap: 20, position: 'absolute', bottom: 0, left: 0, right: 0 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.3)' },
  dotActive: { backgroundColor: '#2DEC86', width: 24 },
  btn: { borderRadius: 14, overflow: 'hidden' },
  btnGradient: { paddingVertical: 16, alignItems: 'center' },
  btnText: { color: '#1a1a1a', fontWeight: '700', fontSize: 16 },
});