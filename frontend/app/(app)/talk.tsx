import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  SafeAreaView,
  FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export default function TalkScreen() {
  const [isListening, setIsListening] = useState(false);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Text style={styles.title}>Comms</Text>
      </View>

      <View style={styles.content}>
        <TouchableOpacity
          style={[styles.pttButton, isListening && styles.pttButtonActive]}
          onPressIn={() => setIsListening(true)}
          onPressOut={() => setIsListening(false)}
        >
          <Ionicons
            name={isListening ? 'mic' : 'mic-outline'}
            size={32}
            color="#FFD60A"
          />
          <Text style={styles.pttText}>
            {isListening ? 'Listening...' : 'Press to Talk'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0A0A' },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  title: { fontSize: 24, fontWeight: '700', color: '#fff' },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  pttButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#1a1a1a',
    borderWidth: 2,
    borderColor: '#333',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  pttButtonActive: {
    borderColor: '#FFD60A',
    backgroundColor: '#2a2a1a',
  },
  pttText: {
    color: '#FFD60A',
    fontSize: 12,
    fontWeight: '600',
  },
});