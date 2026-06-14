import { useCallback, useState } from 'react';
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
import { useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { api, formatErr } from '../../src/api';

// Two-step password reset:
//   1. "request" — enter email -> POST /auth/forgot-password emails a 6-digit code.
//   2. "reset"   — enter the code + a new password -> POST /auth/reset-password.
// The backend always returns ok on step 1 (even for unknown emails) so we never
// reveal which addresses are registered; we advance to step 2 either way.
export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);

  const requestCode = useCallback(async () => {
    if (!email.trim()) {
      Alert.alert('Email required', 'Enter the email for your account.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/forgot-password', { email: email.trim().toLowerCase() });
      setStep('reset');
    } catch (e: any) {
      Alert.alert('Something went wrong', formatErr(e));
    } finally {
      setLoading(false);
    }
  }, [email]);

  const resetPassword = useCallback(async () => {
    if (code.trim().length < 6) {
      Alert.alert('Check your code', 'Enter the 6-digit code from your email.');
      return;
    }
    if (newPassword.length < 6) {
      Alert.alert('Weak password', 'Use at least 6 characters.');
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/reset-password', {
        email: email.trim().toLowerCase(),
        code: code.trim(),
        new_password: newPassword,
      });
      Alert.alert('Password updated', 'You can now sign in with your new password.', [
        { text: 'Sign in', onPress: () => router.replace('/(auth)/login') },
      ]);
    } catch (e: any) {
      Alert.alert("Couldn't reset password", formatErr(e));
    } finally {
      setLoading(false);
    }
  }, [email, code, newPassword, router]);

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
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={12}>
            <Ionicons name="chevron-back" size={24} color="#2DEC86" />
            <Text style={styles.backText}>Back</Text>
          </TouchableOpacity>

          <View style={styles.head}>
            <Text style={styles.title}>Reset password</Text>
            <Text style={styles.subtitle}>
              {step === 'request'
                ? "Enter your account email and we'll send you a 6-digit reset code."
                : `Enter the code we sent to ${email.trim().toLowerCase()} and choose a new password.`}
            </Text>
          </View>

          <View style={styles.formCard}>
            {step === 'request' ? (
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
            ) : (
              <>
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>Reset code</Text>
                  <TextInput
                    style={[styles.input, styles.codeInput]}
                    placeholder="123456"
                    placeholderTextColor="#808080"
                    value={code}
                    onChangeText={(t) => setCode(t.replace(/[^0-9]/g, '').slice(0, 6))}
                    keyboardType="number-pad"
                    maxLength={6}
                    editable={!loading}
                  />
                </View>
                <View style={styles.inputGroup}>
                  <Text style={styles.label}>New password</Text>
                  <View style={styles.inputRow}>
                    <TextInput
                      style={styles.inputFlex}
                      placeholder="At least 6 characters"
                      placeholderTextColor="#808080"
                      value={newPassword}
                      onChangeText={setNewPassword}
                      secureTextEntry={!showPw}
                      editable={!loading}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <TouchableOpacity
                      onPress={() => setShowPw((s) => !s)}
                      style={styles.eyeBtn}
                      hitSlop={10}
                      disabled={loading}
                      accessibilityLabel={showPw ? 'Hide password' : 'Show password'}
                    >
                      <Ionicons name={showPw ? 'eye-off' : 'eye'} size={20} color="#888" />
                    </TouchableOpacity>
                  </View>
                </View>
              </>
            )}

            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={step === 'request' ? requestCode : resetPassword}
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
                  <ActivityIndicator color="#1a1a1a" size="small" />
                ) : (
                  <Text style={styles.primaryBtnText}>
                    {step === 'request' ? 'Send reset code' : 'Reset password'}
                  </Text>
                )}
              </LinearGradient>
            </TouchableOpacity>

            {step === 'reset' && (
              <TouchableOpacity onPress={requestCode} disabled={loading} style={{ alignItems: 'center' }}>
                <Text style={styles.resendLink}>Didn't get it? Resend code</Text>
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },
  container: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingVertical: 40, paddingHorizontal: 20, justifyContent: 'center' },
  backBtn: { flexDirection: 'row', alignItems: 'center', gap: 2, marginBottom: 24 },
  backText: { color: '#2DEC86', fontSize: 15, fontWeight: '600' },
  head: { marginBottom: 24 },
  title: { color: '#F4F4F4', fontSize: 28, fontWeight: '800', marginBottom: 8 },
  subtitle: { color: '#808080', fontSize: 15, lineHeight: 21 },
  formCard: { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 20, gap: 18, borderWidth: 1, borderColor: '#333' },
  inputGroup: { gap: 8 },
  label: { color: '#808080', fontSize: 13, fontWeight: '500' },
  input: { backgroundColor: '#0A0A0A', borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, color: '#F4F4F4', fontSize: 16, borderWidth: 1, borderColor: '#333' },
  inputRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0A0A0A', borderRadius: 10, borderWidth: 1, borderColor: '#333', paddingRight: 8 },
  inputFlex: { flex: 1, paddingVertical: 12, paddingHorizontal: 14, color: '#F4F4F4', fontSize: 16 },
  eyeBtn: { padding: 8 },
  codeInput: { fontSize: 22, letterSpacing: 8, fontWeight: '700', textAlign: 'center' },
  primaryBtn: { borderRadius: 10, overflow: 'hidden', marginTop: 4 },
  buttonGradient: { paddingVertical: 14, alignItems: 'center' },
  primaryBtnText: { color: '#1a1a1a', fontWeight: '700', fontSize: 15 },
  resendLink: { color: '#2DEC86', fontSize: 13, fontWeight: '500', paddingVertical: 4 },
});
