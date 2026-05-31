import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Onboarding from '../../src/components/Onboarding';

const ONBOARDING_KEY = 'convoy.onboarding.completed';

export default function AuthIndex() {
  const router = useRouter();

  useEffect(() => {
    checkOnboardingStatus();
  }, []);

  const checkOnboardingStatus = async () => {
    try {
      const completed = await AsyncStorage.getItem(ONBOARDING_KEY);
      if (completed === 'true') {
        router.replace('/(auth)/login');
      }
    } catch (e) {
      console.error('Error checking onboarding status:', e);
      router.replace('/(auth)/login');
    }
  };

  return <Onboarding />;
}