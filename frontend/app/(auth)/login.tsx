import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Image,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../src/auth';
import { api } from '../../src/api';
import Constants from 'expo-constants';

const CREDS_KEY = 'convoy.saved.credentials';
const SAVE_CREDS_KEY = 'convoy.save.credentials';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saveCredentials, setSaveCredentials] = useState(false);
  const [loading, setLoading] = useState(false);
  const [waking, setWaking] = useState(false);
  const router = useRouter();
  const { login } = useAuth();

  const appVersion = Constants.expoConfig?.version ?? '?';
  const buildNumber =
    Platform.OS === 'ios'
      ? Constants.expoConfig?.ios?.buildNumber ?? '?'
      : String(Constants.expoConfig?.android?.versionCode ?? '?');

  useEffect(() => {

    // Wake the backend early (Render free tier cold-starts after idle).

    api.get('/health').catch(() => {});

  }, []);

  

  useEffect(() => {
    loadSavedCredentials();
  }, []);

  const loadSavedCredentials = async () => {
    try {
      const saved = await AsyncStorage.getItem(SAVE_CREDS_KEY);
      if (saved === 'true') {
        const creds = await AsyncStorage.getItem(CREDS_KEY);
        if (creds) {
          const parsed = JSON.parse(creds);
          setEmail(parsed.email || '');
          setPassword(parsed.password || '');
          setSaveCredentials(true);
        }
      }
    } catch (e) {
      console.error('Error loading credentials:', e);
    }
  };

  const handleSignIn = useCallback(async () => {
    if (!email.trim() || !password) {
      Alert.alert('Error', 'Please enter email and password');
      return;
    }
    setLoading(true);
      const wakeTimer = setTimeout(() => setWaking(true), 4000);
    try {
      await login(email.trim(), password);
      if (saveCredentials) {
        await AsyncStorage.setItem(CREDS_KEY, JSON.stringify({ email: email.trim(), password }));
        await AsyncStorage.setItem(SAVE_CREDS_KEY, 'true');
      } else {
        await AsyncStorage.removeItem(CREDS_KEY);
        await AsyncStorage.setItem(SAVE_CREDS_KEY, 'false');
      }
      router.replace('/(app)/map');
    } catch (e: any) {
      const status = e && e.response ? e.response.status : 0;
      let title = 'Sign in failed';
      let msg = 'Something went wrong. Please try again.';
      if (status === 401) {
        msg = 'Incorrect email or password. Please double-check and try again.';
      } else if (status === 422) {
        msg = 'Please enter a valid email and password.';
      } else if (status === 0) {
        title = 'Connection problem';
        msg = 'Can\'t reach the server. Check your internet connection and try again.';
      }
      Alert.alert(title, msg);
    } finally {
      clearTimeout(wakeTimer);
      setWaking(false);
      setLoading(false);
    }
  }, [email, password, saveCredentials, login, router]);

  const handleForgotPassword = useCallback(() => {
    router.push('/(auth)/forgot-password' as any);
  }, [router]);

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.logoSection}>
            {/* Branded hero (wordmark + logo + tagline are baked into the image). */}
            <Image
              source={require('../../assets/log_in_screen.png')}
              style={styles.hero}
              resizeMode="contain"
            />
          </View>

          <View style={styles.formCard}>
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                placeholder="you@example.com"
                placeholderTextColor="#808080"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!loading}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.inputFlex}
                  placeholder="Enter your password"
                  placeholderTextColor="#808080"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  editable={!loading}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="password"
                />
                <TouchableOpacity
                  onPress={() => setShowPassword((s) => !s)}
                  style={styles.eyeBtn}
                  hitSlop={10}
                  disabled={loading}
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                >
                  <Ionicons name={showPassword ? 'eye-off' : 'eye'} size={20} color="#888" />
                </TouchableOpacity>
              </View>
            </View>

            <TouchableOpacity
              style={styles.checkboxRow}
              onPress={() => setSaveCredentials(!saveCredentials)}
              disabled={loading}
              activeOpacity={0.7}
            >
              <View style={[styles.checkbox, saveCredentials && styles.checkboxChecked]}>
                {saveCredentials && <Text style={styles.checkmark}>✓</Text>}
              </View>
              <Text style={styles.checkboxLabel}>Save credentials</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.signInButton}
              onPress={handleSignIn}
              disabled={loading}
              activeOpacity={0.85}
            >
              <LinearGradient
                colors={['#7DF0B0', '#2DEC86', '#00C46A']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.buttonGradient}
              >
                {loading ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}>
                    <ActivityIndicator color="#1a1a1a" size="small" />
                    {waking && (
                      <Text style={styles.wakingText}>Waking up server…</Text>
                    )}
                  </View>
                ) : (
                  <Text style={styles.signInButtonText}>Sign in</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>

            <View style={styles.linksSection}>
              <Text style={styles.linkText}>
                New here?{' '}
                <Text
                  style={styles.linkHighlight}
                  onPress={() => router.push('/(auth)/signup')}
                >
                  Create account
                </Text>
              </Text>
              <TouchableOpacity onPress={handleForgotPassword} disabled={loading}>
                <Text style={styles.forgotLink}>Forgot password?</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>
        <Text style={styles.versionText}>v{appVersion} ({buildNumber})</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },
  container: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingVertical: 40, paddingHorizontal: 20, justifyContent: 'center' },
  logoSection: { alignItems: 'center', marginBottom: 32 },
  hero: { width: 300, height: 300, borderRadius: 24 },
  formCard: { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 20, gap: 18, borderWidth: 1, borderColor: '#333' },
  inputGroup: { gap: 8 },
  label: { color: '#808080', fontSize: 13, fontWeight: '500' },
  input: { backgroundColor: '#0A0A0A', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, color: '#F4F4F4', fontSize: 16, borderWidth: 1, borderColor: '#333' },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0A0A0A', borderRadius: 10, borderWidth: 1, borderColor: '#333', paddingRight: 8 },
  inputFlex: { flex: 1, paddingVertical: 12, paddingHorizontal: 14, color: '#F4F4F4', fontSize: 16 },
  eyeBtn: { padding: 8 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkbox: { width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: '#666', alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: '#2DEC86', borderColor: '#2DEC86' },
  checkmark: { color: '#000', fontWeight: '700', fontSize: 12 },
  checkboxLabel: { color: '#808080', fontSize: 13 },
  signInButton: { borderRadius: 10, overflow: 'hidden', marginTop: 4 },
  buttonGradient: { paddingVertical: 14, alignItems: 'center' },
  signInButtonText: { color: '#1a1a1a', fontWeight: '700', fontSize: 15 },
  wakingText: { color: '#1a1a1a', fontSize: 13, fontWeight: '700', marginLeft: 8 },
  linksSection: { gap: 12, alignItems: 'center', marginTop: 8 },
  linkText: { color: '#808080', fontSize: 13 },
  linkHighlight: { color: '#2DEC86', fontWeight: '600' },
  forgotLink: { color: '#2DEC86', fontSize: 13, fontWeight: '500', paddingVertical: 6 },
  versionText: { color: '#808080', fontSize: 12, textAlign: 'center', paddingVertical: 10 },
});