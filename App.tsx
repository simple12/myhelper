import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import { StatusBar } from 'expo-status-bar';

// expo-file-system is native-only; web uses localStorage
let FileSystem: typeof import('expo-file-system/legacy') | null = null;
if (Platform.OS !== 'web') {
  FileSystem = require('expo-file-system/legacy');
}
const TRANSCRIPTS_DIR = () => FileSystem?.documentDirectory + 'transcripts/';
const WEB_STORAGE_KEY = 'voice_transcripts';

const OPENAI_API_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? '';

type RecordingState = 'idle' | 'recording' | 'transcribing';

interface Transcript {
  id: string;
  text: string;
  timestamp: string;
  filename: string;
}

// ── Storage helpers (platform-split) ────────────────────────────────────────

async function storageSave(text: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `transcript_${ts}.txt`;

  if (Platform.OS === 'web') {
    const existing = JSON.parse(localStorage.getItem(WEB_STORAGE_KEY) ?? '[]') as Transcript[];
    existing.unshift({ id: filename, text, timestamp: new Date().toLocaleString(), filename });
    localStorage.setItem(WEB_STORAGE_KEY, JSON.stringify(existing));
    // also trigger a browser download of the .txt file
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } else {
    const dir = TRANSCRIPTS_DIR();
    const info = await FileSystem!.getInfoAsync(dir);
    if (!info.exists) await FileSystem!.makeDirectoryAsync(dir, { intermediates: true });
    await FileSystem!.writeAsStringAsync(dir + filename, text);
  }
  return filename;
}

async function storageLoad(): Promise<Transcript[]> {
  if (Platform.OS === 'web') {
    return JSON.parse(localStorage.getItem(WEB_STORAGE_KEY) ?? '[]') as Transcript[];
  }
  try {
    const dir = TRANSCRIPTS_DIR();
    const info = await FileSystem!.getInfoAsync(dir);
    if (!info.exists) return [];
    const files = await FileSystem!.readDirectoryAsync(dir);
    const loaded: Transcript[] = [];
    for (const file of files.sort().reverse()) {
      if (!file.endsWith('.txt')) continue;
      const text = await FileSystem!.readAsStringAsync(dir + file);
      const ts = file.replace('transcript_', '').replace('.txt', '');
      loaded.push({ id: file, text, timestamp: formatTimestamp(ts), filename: file });
    }
    return loaded;
  } catch {
    return [];
  }
}

function formatTimestamp(raw: string): string {
  try {
    return new Date(
      raw.replace(/-/g, (m, i) => (i > 9 ? (i === 13 || i === 16 ? ':' : '.') : m))
    ).toLocaleString();
  } catch {
    return raw;
  }
}

// ── Whisper ──────────────────────────────────────────────────────────────────

async function transcribeWithWhisper(audioUri: string): Promise<string> {
  if (!OPENAI_API_KEY) throw new Error('EXPO_PUBLIC_OPENAI_API_KEY is not set in .env');

  const form = new FormData();
  if (Platform.OS === 'web') {
    const res = await fetch(audioUri);
    const blob = await res.blob();
    form.append('file', blob, 'recording.webm');
  } else {
    form.append('file', { uri: audioUri, name: 'recording.m4a', type: 'audio/m4a' } as any);
  }
  form.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper API error: ${res.status} ${await res.text()}`);
  return (await res.json()).text as string;
}

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [error, setError] = useState<string | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);

  useEffect(() => {
    storageLoad().then(setTranscripts);
  }, []);

  async function startRecording() {
    setError(null);
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) { setError('Microphone permission denied.'); return; }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      recordingRef.current = recording;
      setRecordingState('recording');
    } catch (e: any) {
      setError('Failed to start recording: ' + e.message);
    }
  }

  async function stopAndTranscribe() {
    if (!recordingRef.current) return;
    setRecordingState('transcribing');
    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      if (!uri) throw new Error('No audio file found after recording.');
      const text = await transcribeWithWhisper(uri);
      await storageSave(text);
      setTranscripts(await storageLoad());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRecordingState('idle');
    }
  }

  const isRecording = recordingState === 'recording';
  const isTranscribing = recordingState === 'transcribing';

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <Text style={styles.title}>Voice Transcriber</Text>

      <Pressable
        style={[
          styles.button,
          isRecording && styles.buttonRecording,
          isTranscribing && styles.buttonDisabled,
        ]}
        onPress={isRecording ? stopAndTranscribe : startRecording}
        disabled={isTranscribing}
      >
        {isTranscribing ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>
            {isRecording ? 'Stop & Transcribe' : 'Start Recording'}
          </Text>
        )}
      </Pressable>

      {isRecording && <Text style={styles.statusLabel}>Recording...</Text>}
      {isTranscribing && <Text style={styles.statusLabel}>Transcribing...</Text>}
      {error && <Text style={styles.error}>{error}</Text>}

      {Platform.OS === 'web' && (
        <Text style={styles.webNote}>On web, each transcript is also downloaded as a .txt file.</Text>
      )}

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {transcripts.length === 0 && !isRecording && (
          <Text style={styles.empty}>No transcripts yet. Record something!</Text>
        )}
        {transcripts.map((t) => (
          <View key={t.id} style={styles.card}>
            <Text style={styles.cardMeta}>{t.timestamp}</Text>
            <Text style={styles.cardText}>{t.text}</Text>
            <Text style={styles.cardFile}>{t.filename}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5', paddingTop: 60, paddingHorizontal: 20 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 24, textAlign: 'center', color: '#111' },
  button: {
    backgroundColor: '#2563eb',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonRecording: { backgroundColor: '#dc2626' },
  buttonDisabled: { backgroundColor: '#9ca3af' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  statusLabel: { textAlign: 'center', color: '#6b7280', marginBottom: 8 },
  error: { color: '#dc2626', textAlign: 'center', marginBottom: 8 },
  webNote: { textAlign: 'center', color: '#9ca3af', fontSize: 12, marginBottom: 8 },
  list: { flex: 1, marginTop: 16 },
  listContent: { paddingBottom: 40 },
  empty: { textAlign: 'center', color: '#9ca3af', marginTop: 40 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardMeta: { fontSize: 11, color: '#9ca3af', marginBottom: 6 },
  cardText: { fontSize: 15, color: '#111', lineHeight: 22 },
  cardFile: { fontSize: 10, color: '#d1d5db', marginTop: 8 },
});
