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
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';

const CREDS_KEY = 'convoy.saved.credentials';
const SAVE_CREDS_KEY = 'convoy.save.credentials';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saveCredentials, setSaveCredentials] = useState(false);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // Load saved credentials on mount
  useEffect(() => {
    loadSavedCredentials();
  }, []);

  const loadSavedCredentials = async () => {
    try {
      const saved = await AsyncStorage.getItem(SAVE_CREDS_KEY);
      if (saved === 'true') {
        const creds = await AsyncStorage.getItem(CREDS_KEY);
        if (creds) {
          const { email: savedEmail, password: savedPassword } = JSON.parse(creds);
          setEmail(savedEmail || '');
          setPassword(savedPassword || '');
          setSaveCredentials(true);
        }
      }
    } catch (e) {
      console.error('Error loading saved credentials:', e);
    }
  };

  const handleSignIn = useCallback(async () => {
    if (!email || !password) {
      Alert.alert('Error', 'Please enter email and password');
      return;
    }

    setLoading(true);
    try {
      if (success) {
        // Save credentials if checkbox is checked
        if (saveCredentials) {
          await AsyncStorage.setItem(CREDS_KEY, JSON.stringify({ email, password }));
          await AsyncStorage.setItem(SAVE_CREDS_KEY, 'true');
        } else {
          await AsyncStorage.removeItem(CREDS_KEY);
          await AsyncStorage.setItem(SAVE_CREDS_KEY, 'false');
        }
        router.replace('/(app)/map');
      } else {
        Alert.alert('Error', 'Invalid email or password');
      }
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Sign in failed');
    } finally {
      setLoading(false);
    }
  }, [email, password, saveCredentials, router]);

  const handleForgotPassword = () => {
    Alert.alert(
      'Password Reset',
      'Please contact support at support@convoy.app or visit convoy.app/reset',
      [{ text: 'OK' }]
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Logo */}
          <View style={styles.logoSection}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoBadgeText}>C</Text>
            </View>
            <Text style={styles.appName}>Convoy</Text>
            <Text style={styles.tagline}>Drive together. See everything.</Text>
          </View>

          {/* Sign In Form */}
          <View style={styles.formSection}>
            <View style={styles.formCard}>
              {/* Email */}
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Enter your email"
                  placeholderTextColor="#666"
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  editable={!loading}
                />
              </View>

              {/* Password */}
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Password</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Enter your password"
                  placeholderTextColor="#666"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  editable={!loading}
                />
              </View>

              {/* Save Credentials Checkbox */}
              <TouchableOpacity
                style={styles.checkboxRow}
                onPress={() => setSaveCredentials(!saveCredentials)}
                disabled={loading}
              >
                <View style={[styles.checkbox, saveCredentials && styles.checkboxChecked]}>
                  {saveCredentials && <Text style={styles.checkmark}>ÃÂ¢ÃÂÃÂ</Text>}
                </View>
                <Text style={styles.checkboxLabel}>Save credentials on this device</Text>
              </TouchableOpacity>

              {/* Sign In Button */}
              <TouchableOpacity
                style={styles.signInButton}
                onPress={handleSignIn}
                disabled={loading}
                activeOpacity={0.85}
              >
                <LinearGradient
                  colors={['#FFE45C', '#FFC700', '#FF9F0A']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.buttonGradient}
                >
                  {loading ? (
                    <ActivityIndicator color="#1a1a1a" size="small" />
                  ) : (
                    <Text style={styles.signInButtonText}>Sign in</Text>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </View>

            {/* Links */}
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
              <TouchableOpacity
                onPress={handleForgotPassword}
                disabled={loading}
              >
                <Text style={styles.forgotLink}>Forgot password?</Text>
              </TouchableOpacity>
            </View>

            {/* Demo Info */}
            <View style={styles.demoInfo}>
              <Text style={styles.demoText}>
                Demo: demo@revradar.app ÃÂÃÂ· demo1234
              </Text>
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },
  container: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    paddingVertical: 40,
    paddingHorizontal: 20,
    justifyContent: 'space-between',
  },
  logoSection: {
    alignItems: 'center',
    marginBottom: 40,
  },
  logoBadge: {
    width: 80,
    height: 80,
    borderRadius: 16,
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 2,
    borderColor: '#FFD60A',
  },
  logoBadgeText: {
    fontSize: 40,
    fontWeight: '700',
    color: '#FFD60A',
  },
  appName: {
    fontSize: 32,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 8,
  },
  tagline: {
    fontSize: 16,
    color: '#999',
  },
  formSection: {
    gap: 24,
  },
  formCard: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 20,
    gap: 20,
    borderWidth: 1,
    borderColor: '#333',
  },
  inputGroup: {
    gap: 8,
  },
  label: {
    color: '#ccc',
    fontSize: 14,
    fontWeight: '500',
  },
  input: {
    backgroundColor: '#0A0A0A',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    color: '#fff',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: '#666',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#FFD60A',
    borderColor: '#FFD60A',
  },
  checkmark: {
    color: '#000',
    fontWeight: '700',
    fontSize: 12,
  },
  checkboxLabel: {
    color: '#999',
    fontSize: 14,
  },
  signInButton: {
    borderRadius: 12,
    overflow: 'hidden',
    marginTop: 8,
  },
  buttonGradient: {
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  signInButtonText: {
    color: '#1a1a1a',
    fontWeight: '700',
    fontSize: 16,
  },
  linksSection: {
    gap: 16,
    alignItems: 'center',
  },
  linkText: {
    color: '#999',
    fontSize: 14,
  },
  linkHighlight: {
    color: '#FFD60A',
    fontWeight: '600',
  },
  forgotLink: {
    color: '#FFD60A',
    fontSize: 14,
    fontWeight: '500',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  demoInfo: {
    backgroundColor: 'rgba(255, 214, 10, 0.1)',
    borderRadius: 12,
    padding: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#FFD60A',
  },
  demoText: {
    color: '#FFD60A',
    fontSize: 12,
    fontWeight: '500',
  },
});