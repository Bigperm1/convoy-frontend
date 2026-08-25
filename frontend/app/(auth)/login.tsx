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
import * as AppleAuthentication from 'expo-apple-authentication';
import { api } from '../../src/api';
import Constants from 'expo-constants';
import GlassBackdrop from '../../src/components/GlassBackdrop';
import { GlassFill } from '../../src/Glass';
import { useAccent } from '../../src/appSkin';

const CREDS_KEY = 'convoy.saved.credentials';
const SAVE_CREDS_KEY = 'convoy.save.credentials';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saveCredentials, setSaveCredentials] = useState(false);
  const [loading, setLoading] = useState(false);
  const [waking, setWaking] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const router = useRouter();
  const { login, loginWithApple, loginWithGoogle } = useAuth();
  const accent = useAccent();

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

  // Sign in with Apple is iOS-26/native only — show the button just when the OS
  // reports it available, so Android / older iOS never render a dead control.
  useEffect(() => {
    if (Platform.OS === 'ios') {
      AppleAuthentication.isAvailableAsync().then(setAppleAvailable).catch(() => setAppleAvailable(false));
    }
  }, []);

  const handleApple = useCallback(async () => {
    setLoading(true);
    try {
      await loginWithApple();
      router.replace('/(app)/map');
    } catch (e: any) {
      // The user tapping "Cancel" on the Apple sheet is not an error.
      if (e?.code !== 'ERR_REQUEST_CANCELED') {
        Alert.alert('Apple sign in failed', 'Please try again, or use email and password.');
      }
    } finally {
      setLoading(false);
    }
  }, [loginWithApple, router]);

  const handleGoogle = useCallback(async () => {
    setLoading(true);
    try {
      const ok = await loginWithGoogle();
      if (ok) router.replace('/(app)/map');
    } catch {
      Alert.alert('Google sign in failed', 'Please try again, or use email and password.');
    } finally {
      setLoading(false);
    }
  }, [loginWithGoogle, router]);

  const handleForgotPassword = useCallback(() => {
    router.push('/(auth)/forgot-password' as any);
  }, [router]);

  return (
    <SafeAreaView style={styles.safe}>
      <GlassBackdrop source={require('../../assets/images/glass-bgt.png')} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.brandSection}>
            <Image
              source={require('../../assets/images/hairpin-word.png')}
              style={styles.wordmarkImg}
              resizeMode="cover"
            />
            <Text style={styles.tagline}>Drive Together</Text>
          </View>

          <View style={styles.formCard}>
            <GlassFill tintColor="rgba(14,14,18,0.34)" style={StyleSheet.absoluteFill} />
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
              <View style={[styles.checkbox, saveCredentials && styles.checkboxChecked, saveCredentials && { backgroundColor: accent, borderColor: accent }]}>
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
                colors={['#7DF0B0', accent, '#00C46A']}
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

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or continue with</Text>
              <View style={styles.dividerLine} />
            </View>
            {appleAvailable && (
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                cornerRadius={12}
                style={styles.appleBtn}
                onPress={handleApple}
              />
            )}
            <TouchableOpacity style={styles.googleBtn} onPress={handleGoogle} disabled={loading} activeOpacity={0.85}>
              <GlassFill tintColor="rgba(14,14,18,0.34)" style={StyleSheet.absoluteFill} />
              <Ionicons name="logo-google" size={19} color="#F4F4F4" />
              <Text style={styles.googleBtnText}>Continue with Google</Text>
            </TouchableOpacity>

            <View style={styles.linksSection}>
              <Text style={styles.linkText}>
                New here?{' '}
                <Text
                  style={[styles.linkHighlight, { color: accent }]}
                  onPress={() => router.push('/(auth)/signup')}
                >
                  Create account
                </Text>
              </Text>
              <TouchableOpacity onPress={handleForgotPassword} disabled={loading}>
                <Text style={[styles.forgotLink, { color: accent }]}>Forgot password?</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.termsText}>
              By continuing, you agree to our{' '}
              <Text style={[styles.termsLink, { color: accent }]} onPress={() => router.push('/(auth)/terms' as any)}>Terms of Service</Text>
              {' '}and{' '}
              <Text style={[styles.termsLink, { color: accent }]} onPress={() => router.push('/(auth)/privacy-policy' as any)}>Privacy Policy</Text>.
            </Text>
          </View>
        </ScrollView>
        <Text style={styles.versionText}>v{appVersion} ({buildNumber})</Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0B0B0C' },
  container: { flex: 1 },
  scrollContent: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 20, paddingVertical: 14 },
  // Brand stack: green "Convoy" wordmark, the C-mark app icon, then the tagline —
  // real text around the logo so it stays crisp and on-brand (#2DEC86 on #0B0B0C).
  brandSection: { alignItems: 'center', marginBottom: 16 },
  // Transparent Hairpin wordmark (black keyed out); cover-crops the top/bottom bands.
  wordmarkImg: { width: 300, height: 104, marginBottom: 2 },
  wordmark: { color: '#2DEC86', fontSize: 42, fontWeight: '800', fontStyle: 'italic', letterSpacing: 1, marginBottom: 18, textShadowColor: 'rgba(45,236,134,0.45)', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 14 },
  logoMark: { width: 140, height: 140, borderRadius: 32 },
  tagline: { color: '#2DEC86', fontSize: 15, fontWeight: '600', fontStyle: 'italic', letterSpacing: 0.5, opacity: 0.92, marginTop: 8 },
  formCard: { backgroundColor: 'transparent', overflow: 'hidden', borderRadius: 18, padding: 16, gap: 12, borderWidth: 1, borderColor: '#26262B' },
  inputGroup: { gap: 8 },
  label: { color: '#9A9A9A', fontSize: 13, fontWeight: '500' },
  input: { backgroundColor: 'rgba(6,8,12,0.4)', borderRadius: 12, paddingVertical: 11, paddingHorizontal: 14, color: '#F4F4F4', fontSize: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(6,8,12,0.4)', borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', paddingRight: 8 },
  inputFlex: { flex: 1, paddingVertical: 13, paddingHorizontal: 14, color: '#F4F4F4', fontSize: 16 },
  eyeBtn: { padding: 8 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkbox: { width: 20, height: 20, borderRadius: 4, borderWidth: 2, borderColor: '#666', alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: '#2DEC86', borderColor: '#2DEC86' },
  checkmark: { color: '#000', fontWeight: '700', fontSize: 12 },
  checkboxLabel: { color: '#9A9A9A', fontSize: 13 },
  signInButton: { borderRadius: 12, overflow: 'hidden', marginTop: 4 },
  buttonGradient: { paddingVertical: 15, alignItems: 'center' },
  signInButtonText: { color: '#06281A', fontWeight: '800', fontSize: 16, letterSpacing: 0.3 },
  wakingText: { color: '#06281A', fontSize: 13, fontWeight: '700', marginLeft: 8 },
  linksSection: { gap: 12, alignItems: 'center', marginTop: 8 },
  linkText: { color: '#9A9A9A', fontSize: 13 },
  linkHighlight: { color: '#2DEC86', fontWeight: '600' },
  forgotLink: { color: '#2DEC86', fontSize: 13, fontWeight: '500', paddingVertical: 6 },
  versionText: { color: '#6A6A6A', fontSize: 12, textAlign: 'center', paddingVertical: 10 },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12, marginBottom: 4 },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.18)' },
  dividerText: { color: '#9A9A9A', fontSize: 12, fontWeight: '500' },
  appleBtn: { height: 46, width: '100%', marginTop: 10 },
  // Google: dark frosted-glass button to match the Apple BLACK button + the glass
  // form card — the two social buttons now read as one cohesive dark set under the
  // green primary "Sign in", instead of two stark white slabs.
  googleBtn: { height: 46, marginTop: 10, borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', backgroundColor: 'rgba(20,20,24,0.55)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  googleBtnText: { color: '#F4F4F4', fontSize: 16, fontWeight: '600' },
  termsText: { color: '#7A7A7A', fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 12, paddingHorizontal: 8 },
  termsLink: { color: '#2DEC86', fontWeight: '600' },
});