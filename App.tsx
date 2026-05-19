import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import * as Contacts from 'expo-contacts';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Speech from 'expo-speech';
import { StatusBar } from 'expo-status-bar';

// expo-file-system is native-only; web uses localStorage
let FileSystem: typeof import('expo-file-system/legacy') | null = null;
if (Platform.OS !== 'web') {
  FileSystem = require('expo-file-system/legacy');
}
const TRANSCRIPTS_DIR = () => FileSystem?.documentDirectory + 'transcripts/';
const WEB_STORAGE_KEY = 'voice_transcripts';

const OPENAI_API_KEY = process.env.EXPO_PUBLIC_OPENAI_API_KEY ?? '';
const ANTHROPIC_API_KEY = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY ?? '';

type RecordingState = 'idle' | 'recording' | 'transcribing' | 'analyzing' | 'calling';

interface CallInfo {
  name: string;
  phone: string;
}

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

// ── Claude + Contacts ────────────────────────────────────────────────────────

async function findContactFromTranscript(transcript: string): Promise<CallInfo | null> {
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === 'your_anthropic_api_key_here') return null;

  // Request contacts permission
  const { status } = await Contacts.requestPermissionsAsync();
  if (status !== 'granted') throw new Error('Contacts permission denied.');

  // Step 1: Ask Claude for just the name mentioned in the transcript
  const nameRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 64,
      messages: [
        {
          role: 'user',
          content: `From this voice transcript, extract the name of the person who needs to be called. Return ONLY the name, or null if no one needs to be called.\n\nTranscript: ${transcript}`,
        },
      ],
    }),
  });

  if (!nameRes.ok) throw new Error(`Claude API error: ${nameRes.status} ${await nameRes.text()}`);

  const nameJson = await nameRes.json();
  const extractedName = (nameJson.content?.[0]?.text ?? 'null').trim();
  if (extractedName === 'null' || !extractedName) return null;

  // Step 2: Search phone contacts by name
  const { data } = await Contacts.getContactsAsync({
    name: extractedName,
    fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
  });

  if (!data.length) return null;

  // Pick first contact with a phone number
  for (const contact of data) {
    const phone = contact.phoneNumbers?.[0]?.number;
    if (phone) {
      // Strip formatting only, preserve the number exactly as stored in contacts
      const cleaned = phone.replace(/[^\d+]/g, '');
      return { name: contact.name ?? extractedName, phone: cleaned };
    }
  }

  return null;
}

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [callingName, setCallingName] = useState<string | null>(null);
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
      setRecordingState('analyzing');
      const contact = await findContactFromTranscript(text);
      if (contact) {
        setCallingName(contact.name);
        setRecordingState('calling');
        // Small delay so UI renders the "Calling..." banner before dialer opens
        await new Promise((r) => setTimeout(r, 300));
        await new Promise<void>((resolve) => {
          Speech.speak(`Calling ${contact.name}`, { onDone: resolve, onStopped: resolve });
        });
        const dialUrl = `tel:${contact.phone}`;
        console.log('Dialing:', dialUrl);
        if (Platform.OS === 'android') {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.CALL_PHONE
          );
          if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
            throw new Error('Phone call permission denied.');
          }
          // Reset state before launching — intent never returns a result
          setCallingName(null);
          setRecordingState('idle');
          IntentLauncher.startActivityAsync('android.intent.action.CALL', { data: dialUrl });
        } else {
          setCallingName(null);
          setRecordingState('idle');
          await Linking.openURL(dialUrl);
        }
      } else {
        setError('Could not find a matching contact. Please try again.');
        setRecordingState('idle');
      }
    } catch (e: any) {
      setError(e.message);
      setCallingName(null);
      setRecordingState('idle');
    }
  }

  const isRecording = recordingState === 'recording';
  const isTranscribing = recordingState === 'transcribing';
  const isAnalyzing = recordingState === 'analyzing';
  const isCalling = recordingState === 'calling';
  const isBusy = isTranscribing || isAnalyzing || isCalling;

  return (
    <View style={styles.container}>
      <StatusBar style="dark" />
      <Text style={styles.title}>Voice Transcriber</Text>

      <Pressable
        style={[
          styles.button,
          isRecording && styles.buttonRecording,
          isBusy && styles.buttonDisabled,
        ]}
        onPressIn={isBusy ? undefined : startRecording}
        onPressOut={isRecording ? stopAndTranscribe : undefined}
        disabled={isBusy}
      >
        {isBusy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>
            {isRecording ? 'Release to Send' : 'Hold to Talk'}
          </Text>
        )}
      </Pressable>

      {isRecording && <Text style={styles.statusLabel}>🎙 Recording...</Text>}
      {isTranscribing && <Text style={styles.statusLabel}>⏳ Transcribing...</Text>}
      {isAnalyzing && <Text style={styles.statusLabel}>🔍 Finding contact...</Text>}
      {isCalling && (
        <View style={styles.callingBanner}>
          <Text style={styles.callingLabel}>📞 Calling {callingName}...</Text>
        </View>
      )}
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
  callingBanner: {
    backgroundColor: '#dbeafe',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 20,
    marginBottom: 12,
    alignItems: 'center',
  },
  callingLabel: { textAlign: 'center', color: '#1d4ed8', fontSize: 22, fontWeight: '800' },
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
