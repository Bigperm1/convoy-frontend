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

const { width: SCREEN_W } = Dimensions.get('window');

const screens = [
  {
    id: 'drive-together',
    title: 'Drive Together',
    description: 'See your convoy in real time.',
    image: require('../../assets/onboarding/drive_together.png'),
    btnText: 'Continue',
  },
  {
    id: 'talk-hands-free',
    title: 'Talk Hands-Free',
    description: 'Push-to-talk walkie-talkie built for the road.',
    image: require('../../assets/onboarding/talk_hands-free.png'),
    btnText: 'Continue',
  },
  {
    id: 'own-the-road',
    title: 'Own the Road',
    description: 'Report hazards, share music, and convoy as one.',
    image: require('../../assets/onboarding/own_the_road.png'),
    btnText: 'Lets Roll →',
  },
];

export default function Onboarding() {
  const [currentIdx, setCurrentIdx] = useState(0);
  const scrollRef = useRef(null);
  const router = useRouter();

  const goNext = () => {
    if (currentIdx < screens.length - 1) {
      scrollRef.current?.scrollTo({
        x: (currentIdx + 1) * SCREEN_W,
        animated: true,
      });
      setCurrentIdx(currentIdx + 1);
    } else {
      router.replace('/(auth)/login');
    }
  };

  const goSkip = () => {
    router.replace('/(auth)/login');
  };

  const current = screens[currentIdx];

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.logo}>CONVOY</Text>
        <TouchableOpacity onPress={goSkip}>
          <Text style={styles.skip}>Skip</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        scrollEventThrottle={16}
        showsHorizontalScrollIndicator={false}
        scrollEnabled={false}
        style={styles.scroller}
      >
        {screens.map((screen) => (
          <View key={screen.id} style={[styles.slide, { width: SCREEN_W }]}>
            <ImageBackground
              source={screen.image}
              style={styles.image}
              resizeMode="cover"
            >
              <LinearGradient
                colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.3)', 'rgba(0,0,0,0.8)']}
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
            <View
              key={idx}
              style={[styles.dot, idx === currentIdx && styles.dotActive]}
            />
          ))}
        </View>

        <TouchableOpacity
          onPress={goNext}
          style={styles.btnContinue}
          activeOpacity={0.85}
        >
          <LinearGradient
            colors={['#FFE45C', '#FFC700', '#FF9F0A']}
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
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  logo: { color: '#FFD60A', fontSize: 16, fontWeight: '700', letterSpacing: 2 },
  skip: { color: '#888', fontSize: 14, fontWeight: '500' },
  scroller: { flex: 1 },
  slide: { flex: 1, justifyContent: 'flex-end' },
  image: { ...StyleSheet.absoluteFillObject },
  gradient: { ...StyleSheet.absoluteFillObject },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 160,
  },
  title: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '700',
    marginBottom: 12,
    lineHeight: 40,
  },
  description: {
    color: '#ccc',
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400',
  },
  footer: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    gap: 16,
  },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  dotActive: {
    backgroundColor: '#FFD60A',
    width: 24,
  },
  btnContinue: {
    borderRadius: 14,
    overflow: 'hidden',
  },
  btnGradient: {
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: {
    color: '#1a1a1a',
    fontWeight: '700',
    fontSize: 16,
  },
});