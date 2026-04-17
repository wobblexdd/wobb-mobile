import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  DeviceEventEmitter,
  NativeModules,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as storage from './storage';
import {
  bootstrapDraftToProfile,
  buildTunnelConfig,
  createEmptyBootstrapDraft,
  createEmptyProfile,
  createProfileSummary,
  createShareLink,
  duplicateProfile,
  generateUuid,
  normalizeBootstrapAuthMethod,
  normalizeProfile,
  parseProfileImport,
  profileEndpoint,
  sortProfiles,
  touchProfileUsage,
  type BootstrapAuthMethod,
  type BootstrapDraft,
  type LocalProfile,
  type ProfileMode,
  type ValidationResult,
  validateProfile,
} from './profileUtils';

type ConnectionState = 'idle' | 'permission_required' | 'connecting' | 'connected' | 'disconnecting' | 'error';
type ViewMode = 'home' | 'form' | 'import' | 'bootstrap' | 'settings';

type DiagnosticLogEntry = {
  id: string;
  level: 'info' | 'warn' | 'error';
  source: 'app' | 'native' | 'helper';
  message: string;
  timestamp: string;
};

type OnboardingSlide = {
  eyebrow: string;
  title: string;
  body: string;
};

type BootstrapPlan = {
  draftProfile?: Partial<BootstrapDraft>;
  profileReady?: boolean;
  profile?: Partial<LocalProfile>;
  missingFields?: string[];
  manualSteps?: string[];
  panelTemplate?: Record<string, unknown>;
  shareLink?: string | null;
  summary?: string | null;
  commandSnippets?: string[];
};

const PROFILES_KEY = 'wobb.mobile.selfhosted.profiles.v2';
const ACTIVE_PROFILE_KEY = 'wobb.mobile.selfhosted.active-profile.v2';
const ONBOARDING_COMPLETE_KEY = 'wobb.mobile.selfhosted.onboarding.v2';
const HELPER_API_BASE_CANDIDATES = ['http://127.0.0.1:3000', 'http://10.0.2.2:3000'];

const ONBOARDING_SLIDES: OnboardingSlide[] = [
  {
    eyebrow: 'Self-hosted first',
    title: 'Bring your own VLESS server',
    body: 'Wobb stores your REALITY profiles locally so you can connect without a hosted account layer.',
  },
  {
    eyebrow: 'Import or create',
    title: 'Keep one clean source of truth',
    body: 'Paste a VLESS URI, import supported JSON, or enter the profile fields manually and validate them before connect.',
  },
  {
    eyebrow: 'Real runtime state',
    title: 'See exactly what happened',
    body: 'Connection status, endpoint, and recent logs stay visible so runtime issues are easy to inspect.',
  },
  {
    eyebrow: 'Bootstrap when needed',
    title: 'Plan a new VPS setup',
    body: 'Use the helper service to generate a setup plan, then save the final profile locally on the device.',
  },
];

const COLORS = {
  background: '#08111f',
  panel: '#111c32',
  panelMuted: '#0d1728',
  border: '#1f2d46',
  text: '#e5e7eb',
  muted: '#94a3b8',
  accent: '#3b82f6',
  success: '#bfdbfe',
  successSoft: '#172554',
  warning: '#fef08a',
  warningSoft: '#3f3b0b',
  danger: '#fca5a5',
  dangerSoft: '#3f1d2e',
};

type WobbVpnBridge = {
  prepareVpn?: () => Promise<{ granted?: boolean }>;
  startVpn?: (configJson: string) => Promise<void>;
  stopVpn?: () => Promise<void>;
  setClipboardText?: (text: string) => Promise<boolean>;
  getClipboardText?: () => Promise<string | null>;
};

const { WobbVpnModule } = NativeModules as {
  WobbVpnModule?: WobbVpnBridge;
};

const VpnInterface = {
  async prepare(): Promise<void> {
    if (!WobbVpnModule?.prepareVpn) {
      throw new Error('VPN bridge is unavailable in this Android build.');
    }

    const result = await WobbVpnModule.prepareVpn();
    if (result?.granted === false) {
      throw new Error('VPN permission was not granted.');
    }
  },
  start(config: Record<string, unknown>) {
    if (!WobbVpnModule?.startVpn) {
      return Promise.reject(new Error('VpnInterface.start is unavailable in this build.'));
    }

    return WobbVpnModule.startVpn(JSON.stringify(config));
  },
  stop() {
    if (!WobbVpnModule?.stopVpn) {
      return Promise.reject(new Error('VpnInterface.stop is unavailable in this build.'));
    }

    return WobbVpnModule.stopVpn();
  },
};

function createLogEntry(
  source: DiagnosticLogEntry['source'],
  message: string,
  level: DiagnosticLogEntry['level'] = 'info'
): DiagnosticLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    source,
    message,
    level,
    timestamp: new Date().toISOString(),
  };
}

function stateLabel(state: ConnectionState): string {
  switch (state) {
    case 'permission_required':
      return 'Permission required';
    case 'connecting':
      return 'Connecting';
    case 'connected':
      return 'Connected';
    case 'disconnecting':
      return 'Disconnecting';
    case 'error':
      return 'Connection error';
    default:
      return 'Disconnected';
  }
}

function stateTone(state: ConnectionState) {
  if (state === 'connected') {
    return { text: COLORS.success, background: COLORS.successSoft };
  }
  if (state === 'error') {
    return { text: COLORS.danger, background: COLORS.dangerSoft };
  }
  if (state === 'connecting' || state === 'disconnecting' || state === 'permission_required') {
    return { text: COLORS.warning, background: COLORS.warningSoft };
  }
  return { text: COLORS.text, background: COLORS.panelMuted };
}

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) {
    return 'Never used';
  }

  const delta = Date.now() - Date.parse(timestamp);
  if (Number.isNaN(delta) || delta < 0) {
    return 'Updated';
  }

  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) {
    return 'Used just now';
  }
  if (minutes < 60) {
    return `Used ${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `Used ${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `Used ${days}d ago`;
}

async function readProfiles(): Promise<LocalProfile[]> {
  const raw = await storage.getItem(PROFILES_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Array<Partial<LocalProfile>>;
    return Array.isArray(parsed) ? sortProfiles(parsed.map((entry) => createEmptyProfile(entry))) : [];
  } catch {
    return [];
  }
}

async function writeProfiles(profiles: LocalProfile[]): Promise<void> {
  await storage.setItem(PROFILES_KEY, JSON.stringify(sortProfiles(profiles)));
}

async function readActiveProfileId(): Promise<string | null> {
  return storage.getItem(ACTIVE_PROFILE_KEY);
}

async function writeActiveProfileId(profileId: string | null): Promise<void> {
  if (profileId) {
    await storage.setItem(ACTIVE_PROFILE_KEY, profileId);
    return;
  }

  await storage.removeItem(ACTIVE_PROFILE_KEY);
}

async function readOnboardingComplete(): Promise<boolean> {
  return (await storage.getItem(ONBOARDING_COMPLETE_KEY)) === '1';
}

async function writeOnboardingComplete(value: boolean): Promise<void> {
  if (value) {
    await storage.setItem(ONBOARDING_COMPLETE_KEY, '1');
    return;
  }

  await storage.removeItem(ONBOARDING_COMPLETE_KEY);
}

async function helperRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: unknown;

  for (const baseUrl of HELPER_API_BASE_CANDIDATES) {
    try {
      const response = await fetch(`${baseUrl}${path}`, init);
      const rawBody = await response.text();
      const payload = rawBody ? (JSON.parse(rawBody) as T & { message?: string }) : ({} as T & { message?: string });

      if (!response.ok) {
        throw new Error(payload.message || `Helper request failed with status ${response.status}`);
      }

      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError instanceof Error ? lastError.message : 'Helper service is unavailable.');
}

function validationText(validation: ValidationResult): string | null {
  return validation.valid ? null : validation.errors[0] || 'Profile is incomplete.';
}

async function copyText(text: string): Promise<boolean> {
  if (!WobbVpnModule?.setClipboardText) {
    return false;
  }

  await WobbVpnModule.setClipboardText(text);
  return true;
}

async function readClipboardText(): Promise<string | null> {
  if (!WobbVpnModule?.getClipboardText) {
    return null;
  }

  return WobbVpnModule.getClipboardText();
}

function FormField({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric';
  multiline?: boolean;
}) {
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={COLORS.muted}
        keyboardType={keyboardType}
        multiline={multiline}
        style={[styles.input, multiline && styles.inputMultiline]}
      />
    </View>
  );
}

function SegmentedToggle({
  options,
  value,
  onChange,
}: {
  options: Array<{ label: string; value: string }>;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <View style={styles.segmentedToggle}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.segmentButton, selected && styles.segmentButtonActive]}
          >
            <Text style={[styles.segmentButtonText, selected && styles.segmentButtonTextActive]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function EmptyState({
  title,
  body,
  actionLabel,
  onPress,
}: {
  title: string;
  body: string;
  actionLabel: string;
  onPress: () => void;
}) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyStateTitle}>{title}</Text>
      <Text style={styles.emptyStateBody}>{body}</Text>
      <Pressable style={styles.secondaryButton} onPress={onPress}>
        <Text style={styles.secondaryButtonText}>{actionLabel}</Text>
      </Pressable>
    </View>
  );
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>('home');
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [profiles, setProfiles] = useState<LocalProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [formDraft, setFormDraft] = useState<LocalProfile>(createEmptyProfile());
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [bootstrapDraft, setBootstrapDraft] = useState<BootstrapDraft>(createEmptyBootstrapDraft());
  const [bootstrapPlan, setBootstrapPlan] = useState<BootstrapPlan | null>(null);
  const [bootstrapBusy, setBootstrapBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [logs, setLogs] = useState<DiagnosticLogEntry[]>([]);
  const activeProfileIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeProfileIdRef.current = activeProfileId;
  }, [activeProfileId]);

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) || null,
    [profiles, activeProfileId]
  );
  const activeValidation = useMemo(
    () => (activeProfile ? validateProfile(activeProfile) : { valid: false, errors: ['Add a profile to connect.'], fieldErrors: {} }),
    [activeProfile]
  );
  const tone = stateTone(connectionState);
  const filteredProfiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return sortProfiles(profiles);
    }

    return sortProfiles(profiles).filter((profile) => {
      const haystack = [profile.name, profile.host, profile.serverName, profile.remarks].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [profiles, searchQuery]);

  function appendLog(source: DiagnosticLogEntry['source'], message: string, level: DiagnosticLogEntry['level'] = 'info') {
    setLogs((current) => [...current, createLogEntry(source, message, level)].slice(-200));
  }

  async function persistProfiles(nextProfiles: LocalProfile[], nextActiveProfileId: string | null) {
    const sorted = sortProfiles(nextProfiles.map((profile) => createEmptyProfile(profile)));
    setProfiles(sorted);
    setActiveProfileId(nextActiveProfileId);
    await writeProfiles(sorted);
    await writeActiveProfileId(nextActiveProfileId);
  }

  function updateProfileMetadata(result: string) {
    const targetId = activeProfileIdRef.current;
    if (!targetId) {
      return;
    }

    setProfiles((current) => {
      const next = sortProfiles(
        current.map((profile) => (profile.id === targetId ? touchProfileUsage(profile, result) : profile))
      );
      void writeProfiles(next);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;

    const statusListener = DeviceEventEmitter.addListener('WobbVpnStatus', (payload) => {
      const status = String(payload?.status || '').toLowerCase();
      if (status === 'connecting') {
        setConnectionState('connecting');
        appendLog('native', 'VPN service is starting.');
      } else if (status === 'connected') {
        setConnectionState('connected');
        setErrorText(null);
        updateProfileMetadata('connected');
        appendLog('native', 'VPN tunnel connected.');
      } else if (status === 'disconnecting') {
        setConnectionState('disconnecting');
        appendLog('native', 'VPN service is stopping.');
      } else if (status === 'error') {
        setConnectionState('error');
        updateProfileMetadata('error');
        appendLog('native', 'VPN service reported an error.', 'error');
      } else if (status === 'stopped' || status === 'idle') {
        setConnectionState('idle');
      }
    });

    const logListener = DeviceEventEmitter.addListener('WobbVpnLog', (payload) => {
      const stream = String(payload?.stream || 'native');
      const message = String(payload?.message || '').trim();
      if (message) {
        appendLog('native', `${stream}: ${message}`);
      }
    });

    const permissionListener = DeviceEventEmitter.addListener('WobbVpnPermission', (payload) => {
      const status = String(payload?.status || '').toLowerCase();
      if (status === 'requested') {
        setConnectionState('permission_required');
      }
      if (status === 'denied') {
        setConnectionState('error');
        setErrorText('VPN permission was denied.');
        updateProfileMetadata('permission_denied');
        appendLog('native', 'VPN permission was denied.', 'error');
      }
    });

    async function boot() {
      try {
        const [storedProfiles, storedActiveProfileId, storedOnboarding] = await Promise.all([
          readProfiles(),
          readActiveProfileId(),
          readOnboardingComplete(),
        ]);

        if (cancelled) {
          return;
        }

        const nextProfiles = sortProfiles(storedProfiles);
        const nextActiveId = nextProfiles.some((profile) => profile.id === storedActiveProfileId)
          ? storedActiveProfileId
          : nextProfiles[0]?.id || null;

        setProfiles(nextProfiles);
        setActiveProfileId(nextActiveId);
        setOnboardingComplete(storedOnboarding);
      } finally {
        if (!cancelled) {
          setBooting(false);
        }
      }
    }

    boot();

    return () => {
      cancelled = true;
      statusListener.remove();
      logListener.remove();
      permissionListener.remove();
    };
  }, []);

  async function handleCompleteOnboarding() {
    await writeOnboardingComplete(true);
    setOnboardingComplete(true);
  }

  function handleOpenCreateProfile() {
    setEditingProfileId(null);
    setFormDraft(createEmptyProfile());
    setErrorText(null);
    setViewMode('form');
  }

  function handleOpenEditProfile(profile: LocalProfile) {
    setEditingProfileId(profile.id);
    setFormDraft(createEmptyProfile(profile));
    setErrorText(null);
    setViewMode('form');
  }

  async function handleSaveProfile() {
    try {
      const savedProfile = normalizeProfile(formDraft);
      const nextProfiles = editingProfileId
        ? profiles.map((profile) => (profile.id === editingProfileId ? savedProfile : profile))
        : [savedProfile, ...profiles];
      const nextActiveId = editingProfileId === activeProfileId ? savedProfile.id : activeProfileId || savedProfile.id;

      await persistProfiles(nextProfiles, nextActiveId);
      setViewMode('home');
      setEditingProfileId(null);
      setErrorText(null);
      appendLog('app', `Saved profile ${savedProfile.name}.`);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Failed to save profile.');
    }
  }

  function handleDeleteProfile(profile: LocalProfile) {
    Alert.alert('Delete profile', `Remove ${profile.name}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          const nextProfiles = profiles.filter((entry) => entry.id !== profile.id);
          const nextActiveId = activeProfileId === profile.id ? nextProfiles[0]?.id || null : activeProfileId;
          persistProfiles(nextProfiles, nextActiveId).catch(() => undefined);
          appendLog('app', `Deleted profile ${profile.name}.`, 'warn');
          if (editingProfileId === profile.id) {
            setViewMode('home');
            setEditingProfileId(null);
          }
        },
      },
    ]);
  }

  async function handleDuplicateProfile(profile: LocalProfile) {
    const duplicate = duplicateProfile(profile);
    await persistProfiles([duplicate, ...profiles], duplicate.id);
    setViewMode('home');
    appendLog('app', `Duplicated profile ${profile.name}.`);
  }

  async function handleToggleFavorite(profile: LocalProfile) {
    const nextProfiles = profiles.map((entry) =>
      entry.id === profile.id ? createEmptyProfile({ ...entry, isFavorite: !entry.isFavorite, updatedAt: new Date().toISOString() }) : entry
    );
    await persistProfiles(nextProfiles, activeProfileId);
  }

  async function handleSelectProfile(profile: LocalProfile) {
    setActiveProfileId(profile.id);
    activeProfileIdRef.current = profile.id;
    await writeActiveProfileId(profile.id);
    appendLog('app', `Selected profile ${profile.name}.`);
  }

  async function handleShareProfile() {
    if (!activeProfile) {
      setErrorText('Select a profile first.');
      return;
    }

    try {
      const message = `${createProfileSummary(activeProfile)}\n\n${createShareLink(activeProfile)}`;
      await Share.share({ message });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Failed to share profile.');
    }
  }

  async function handleCopyProfileUri() {
    if (!activeProfile) {
      setErrorText('Select a profile first.');
      return;
    }

    try {
      const shareLink = createShareLink(activeProfile);
      const copied = await copyText(shareLink);
      if (copied) {
        setErrorText(null);
        appendLog('app', 'Profile URI copied to clipboard.');
        return;
      }

      await Share.share({ message: shareLink });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Failed to copy profile URI.');
    }
  }

  async function handleCopyLogs() {
    if (logs.length === 0) {
      setErrorText('No logs to copy.');
      return;
    }

    const payload = logs
      .map((entry) => `[${entry.timestamp}] ${entry.source.toUpperCase()} ${entry.level.toUpperCase()} ${entry.message}`)
      .join('\n');

    try {
      const copied = await copyText(payload);
      if (copied) {
        appendLog('app', 'Logs copied to clipboard.');
        return;
      }

      await Share.share({ message: payload });
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Failed to export logs.');
    }
  }

  function handleClearLogs() {
    setLogs([]);
    setErrorText(null);
  }

  async function handleImportClipboard() {
    try {
      const clipboard = await readClipboardText();
      if (!clipboard) {
        throw new Error('Clipboard is empty.');
      }

      setImportText(clipboard);
      appendLog('app', 'Pasted profile input from clipboard.');
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Failed to read clipboard.');
    }
  }

  function handleImportText() {
    try {
      const imported = parseProfileImport(importText);
      setEditingProfileId(null);
      setFormDraft(imported);
      setViewMode('form');
      setErrorText(null);
      appendLog('app', `Imported draft for ${imported.name}.`);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Failed to import profile.');
    }
  }

  async function handleRequestBootstrapPlan() {
    setBootstrapBusy(true);
    setErrorText(null);
    setBootstrapPlan(null);

    try {
      const response = await helperRequest<{ success: boolean; data: BootstrapPlan }>('/api/v1/bootstrap/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profileName: bootstrapDraft.profileName,
          publicHost: bootstrapDraft.publicHost,
          publicPort: bootstrapDraft.publicPort,
          serverName: bootstrapDraft.serverName,
          realityDest: bootstrapDraft.realityDest,
          fingerprint: bootstrapDraft.fingerprint,
          spiderX: bootstrapDraft.spiderX,
          flow: bootstrapDraft.flow,
          mode: bootstrapDraft.mode,
          sshHost: bootstrapDraft.sshHost,
          sshPort: bootstrapDraft.sshPort,
          sshUser: bootstrapDraft.sshUser,
          authMethod: bootstrapDraft.authMethod,
          uuid: bootstrapDraft.uuid || undefined,
          publicKey: bootstrapDraft.publicKey || undefined,
          shortId: bootstrapDraft.shortId || undefined,
          remarks: bootstrapDraft.remarks || undefined,
        }),
      });

      setBootstrapPlan(response.data);
      appendLog('helper', 'Generated VPS bootstrap plan.');
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Failed to generate setup plan.');
      appendLog('helper', error instanceof Error ? error.message : 'Failed to generate setup plan.', 'error');
    } finally {
      setBootstrapBusy(false);
    }
  }

  function handleUseBootstrapDraft() {
    if (!bootstrapPlan) {
      return;
    }

    const source = bootstrapPlan.profileReady && bootstrapPlan.profile ? bootstrapPlan.profile : bootstrapPlan.draftProfile;
    const nextProfile = bootstrapDraftToProfile({
      ...bootstrapDraft,
      ...(source || {}),
      profileName: String((source as Partial<LocalProfile> | undefined)?.name || bootstrapDraft.profileName),
      publicHost: String((source as Partial<LocalProfile> | undefined)?.host || bootstrapDraft.publicHost),
      publicPort: String((source as Partial<LocalProfile> | undefined)?.port || bootstrapDraft.publicPort),
    });

    setEditingProfileId(null);
    setFormDraft(nextProfile);
    setViewMode('form');
  }

  async function handleToggleConnection() {
    setErrorText(null);

    try {
      if (connectionState === 'connected' || connectionState === 'connecting') {
        setConnectionState('disconnecting');
        appendLog('app', 'Stopping VPN tunnel.');
        await VpnInterface.stop();
        appendLog('app', 'Disconnect requested by user.');
        setConnectionState('idle');
        return;
      }

      if (!activeProfile) {
        throw new Error('Add and select a profile before connecting.');
      }

      appendLog('app', `Selected profile ${activeProfile.name} (${profileEndpoint(activeProfile)}).`);
      const validation = validateProfile(activeProfile);
      if (!validation.valid) {
        appendLog('app', `Validation failed: ${validation.errors[0]}.`, 'error');
        throw new Error(validation.errors[0]);
      }

      const config = buildTunnelConfig(activeProfile, activeProfile.mode === 'proxy');
      setConnectionState('connecting');
      appendLog('app', `Starting tunnel to ${profileEndpoint(activeProfile)}.`);
      await VpnInterface.prepare();
      appendLog('app', 'VPN permission granted.');
      await VpnInterface.start(config);
      appendLog('app', 'Native start request accepted; waiting for tunnel status.');
    } catch (error) {
      setConnectionState('error');
      setErrorText(error instanceof Error ? error.message : 'Connection failed.');
      updateProfileMetadata('error');
      appendLog('app', error instanceof Error ? error.message : 'Connection failed.', 'error');
    }
  }

  const connectLabel =
    connectionState === 'connected'
      ? 'Disconnect'
      : connectionState === 'connecting'
        ? 'Connecting'
        : connectionState === 'disconnecting'
          ? 'Disconnecting'
          : 'Connect';

  if (booting) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
        <View style={styles.center}>
          <View style={styles.logoBadge}>
            <Text style={styles.logoBadgeText}>W</Text>
          </View>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.screenTitle}>Wobb</Text>
          <Text style={styles.mutedText}>Loading local profiles.</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!onboardingComplete) {
    const currentSlide = ONBOARDING_SLIDES[Math.min(onboardingStep, ONBOARDING_SLIDES.length - 1)];
    const finalStep = onboardingStep >= ONBOARDING_SLIDES.length - 1;

    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
        <View style={styles.onboardingRoot}>
          <View style={styles.onboardingHero}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoBadgeText}>W</Text>
            </View>
            <Text style={styles.onboardingEyebrow}>{currentSlide.eyebrow}</Text>
            <Text style={styles.onboardingTitle}>{currentSlide.title}</Text>
            <Text style={styles.onboardingBody}>{currentSlide.body}</Text>
          </View>

          <View style={styles.onboardingFooter}>
            <View style={styles.onboardingDots}>
              {ONBOARDING_SLIDES.map((slide, index) => (
                <View
                  key={slide.title}
                  style={[styles.onboardingDot, index === onboardingStep && styles.onboardingDotActive]}
                />
              ))}
            </View>
            <View style={styles.onboardingActions}>
              <Pressable style={[styles.secondaryButton, styles.flexButton]} onPress={() => handleCompleteOnboarding().catch(() => undefined)}>
                <Text style={styles.secondaryButtonText}>Skip</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryButton, styles.flexButton]}
                onPress={() => {
                  if (finalStep) {
                    handleCompleteOnboarding().catch(() => undefined);
                  } else {
                    setOnboardingStep((current) => current + 1);
                  }
                }}
              >
                <Text style={styles.primaryButtonText}>{finalStep ? 'Start' : 'Continue'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (viewMode === 'form') {
    const draftValidation = validateProfile(formDraft);

    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.headerRow}>
            <Text style={styles.screenTitle}>{editingProfileId ? 'Edit profile' : 'New profile'}</Text>
            <Pressable style={styles.secondaryButtonCompact} onPress={() => setViewMode('home')}>
              <Text style={styles.secondaryButtonText}>Back</Text>
            </Pressable>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Manual profile</Text>
            <Text style={styles.panelText}>Enter the VLESS and REALITY details exactly as your server expects them.</Text>
            <FormField label="Profile name" value={formDraft.name} onChangeText={(value) => setFormDraft((current) => ({ ...current, name: value }))} placeholder="My VPS" />
            <FormField label="Server host" value={formDraft.host} onChangeText={(value) => setFormDraft((current) => ({ ...current, host: value }))} placeholder="157.90.116.123" />
            <FormField label="Port" value={formDraft.port} onChangeText={(value) => setFormDraft((current) => ({ ...current, port: value }))} keyboardType="numeric" />
            <FormField label="UUID" value={formDraft.uuid} onChangeText={(value) => setFormDraft((current) => ({ ...current, uuid: value }))} />
            <Pressable style={styles.inlineAction} onPress={() => setFormDraft((current) => ({ ...current, uuid: generateUuid() }))}>
              <Text style={styles.inlineActionText}>Generate UUID</Text>
            </Pressable>
            <FormField label="Server name / SNI" value={formDraft.serverName} onChangeText={(value) => setFormDraft((current) => ({ ...current, serverName: value }))} />
            <FormField label="REALITY public key" value={formDraft.publicKey} onChangeText={(value) => setFormDraft((current) => ({ ...current, publicKey: value }))} />
            <FormField label="REALITY short ID" value={formDraft.shortId} onChangeText={(value) => setFormDraft((current) => ({ ...current, shortId: value }))} />
            <FormField label="Fingerprint" value={formDraft.fingerprint} onChangeText={(value) => setFormDraft((current) => ({ ...current, fingerprint: value }))} />
            <FormField label="Spider X" value={formDraft.spiderX} onChangeText={(value) => setFormDraft((current) => ({ ...current, spiderX: value }))} />
            <FormField label="Flow" value={formDraft.flow} onChangeText={(value) => setFormDraft((current) => ({ ...current, flow: value }))} />
            <FormField label="Remarks" value={formDraft.remarks} onChangeText={(value) => setFormDraft((current) => ({ ...current, remarks: value }))} multiline />
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Mode</Text>
              <SegmentedToggle
                value={formDraft.mode}
                onChange={(next) => setFormDraft((current) => ({ ...current, mode: next as ProfileMode }))}
                options={[
                  { label: 'VPN', value: 'vpn' },
                  { label: 'Proxy', value: 'proxy' },
                ]}
              />
            </View>
            {draftValidation.valid ? null : <Text style={styles.warningText}>{validationText(draftValidation)}</Text>}
            <View style={styles.buttonRow}>
              <Pressable style={[styles.primaryButton, styles.flexButton]} onPress={handleSaveProfile}>
                <Text style={styles.primaryButtonText}>{editingProfileId ? 'Save changes' : 'Save profile'}</Text>
              </Pressable>
              <Pressable
                style={[styles.secondaryButton, styles.flexButton]}
                onPress={() => {
                  setEditingProfileId(null);
                  setFormDraft(createEmptyProfile());
                  setErrorText(null);
                }}
              >
                <Text style={styles.secondaryButtonText}>Reset</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (viewMode === 'import') {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.headerRow}>
            <Text style={styles.screenTitle}>Import profile</Text>
            <Pressable style={styles.secondaryButtonCompact} onPress={() => setViewMode('home')}>
              <Text style={styles.secondaryButtonText}>Back</Text>
            </Pressable>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Paste VLESS URI or JSON</Text>
            <Text style={styles.panelText}>Import a VLESS REALITY share link, a profile JSON object, or a config with a VLESS outbound.</Text>
            <TextInput
              value={importText}
              onChangeText={setImportText}
              placeholder="vless://..."
              placeholderTextColor={COLORS.muted}
              multiline
              style={[styles.input, styles.importInput]}
            />
            <View style={styles.buttonRow}>
              <Pressable style={[styles.secondaryButton, styles.flexButton]} onPress={handleImportClipboard}>
                <Text style={styles.secondaryButtonText}>Paste clipboard</Text>
              </Pressable>
              <Pressable
                style={[styles.secondaryButton, styles.flexButton]}
                onPress={() => {
                  setErrorText(null);
                  appendLog('app', 'QR import is reserved for the camera pass.');
                }}
              >
                <Text style={styles.secondaryButtonText}>QR import</Text>
              </Pressable>
              <Pressable style={[styles.primaryButton, styles.flexButton]} onPress={handleImportText}>
                <Text style={styles.primaryButtonText}>Import draft</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Quick notes</Text>
            <Text style={styles.stepText}>1. QR import can be added later without changing the profile model.</Text>
            <Text style={styles.stepText}>2. Imported profiles are opened as editable drafts before they are saved.</Text>
            <Text style={styles.stepText}>3. Placeholder or incomplete values are rejected before connect.</Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (viewMode === 'bootstrap') {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.headerRow}>
            <Text style={styles.screenTitle}>Bootstrap VPS</Text>
            <Pressable style={styles.secondaryButtonCompact} onPress={() => setViewMode('home')}>
              <Text style={styles.secondaryButtonText}>Back</Text>
            </Pressable>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Setup plan</Text>
            <Text style={styles.panelText}>Generate a manual setup plan. If UUID, public key, and short ID are already known, Wobb can turn the result into a ready profile.</Text>
            <FormField label="Profile name" value={bootstrapDraft.profileName} onChangeText={(value) => setBootstrapDraft((current) => ({ ...current, profileName: value }))} />
            <FormField label="Public host" value={bootstrapDraft.publicHost} onChangeText={(value) => setBootstrapDraft((current) => ({ ...current, publicHost: value }))} placeholder="157.90.116.123" />
            <FormField label="Public port" value={bootstrapDraft.publicPort} onChangeText={(value) => setBootstrapDraft((current) => ({ ...current, publicPort: value }))} keyboardType="numeric" />
            <FormField label="Server name" value={bootstrapDraft.serverName} onChangeText={(value) => setBootstrapDraft((current) => ({ ...current, serverName: value }))} />
            <FormField label="REALITY destination" value={bootstrapDraft.realityDest} onChangeText={(value) => setBootstrapDraft((current) => ({ ...current, realityDest: value }))} />
            <FormField label="SSH host" value={bootstrapDraft.sshHost} onChangeText={(value) => setBootstrapDraft((current) => ({ ...current, sshHost: value }))} />
            <FormField label="SSH port" value={bootstrapDraft.sshPort} onChangeText={(value) => setBootstrapDraft((current) => ({ ...current, sshPort: value }))} keyboardType="numeric" />
            <FormField label="SSH user" value={bootstrapDraft.sshUser} onChangeText={(value) => setBootstrapDraft((current) => ({ ...current, sshUser: value }))} />
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>SSH auth</Text>
              <SegmentedToggle
                value={bootstrapDraft.authMethod}
                onChange={(next) => setBootstrapDraft((current) => ({ ...current, authMethod: normalizeBootstrapAuthMethod(next) as BootstrapAuthMethod }))}
                options={[
                  { label: 'Private key', value: 'private_key' },
                  { label: 'Password', value: 'password' },
                ]}
              />
            </View>
            <FormField label="UUID (optional)" value={bootstrapDraft.uuid} onChangeText={(value) => setBootstrapDraft((current) => ({ ...current, uuid: value }))} />
            <FormField label="Public key (optional)" value={bootstrapDraft.publicKey} onChangeText={(value) => setBootstrapDraft((current) => ({ ...current, publicKey: value }))} />
            <FormField label="Short ID (optional)" value={bootstrapDraft.shortId} onChangeText={(value) => setBootstrapDraft((current) => ({ ...current, shortId: value }))} />
            <FormField label="Remarks" value={bootstrapDraft.remarks} onChangeText={(value) => setBootstrapDraft((current) => ({ ...current, remarks: value }))} multiline />
            <Pressable style={styles.primaryButton} onPress={handleRequestBootstrapPlan}>
              <Text style={styles.primaryButtonText}>{bootstrapBusy ? 'Working' : 'Generate setup plan'}</Text>
            </Pressable>
          </View>

          {bootstrapPlan ? (
            <View style={styles.panel}>
              <Text style={styles.panelTitle}>Plan result</Text>
              <Text style={styles.detailValue}>Profile ready: {bootstrapPlan.profileReady ? 'Yes' : 'Not yet'}</Text>
              {bootstrapPlan.missingFields && bootstrapPlan.missingFields.length > 0 ? (
                <Text style={styles.warningText}>Missing fields: {bootstrapPlan.missingFields.join(', ')}</Text>
              ) : null}
              {bootstrapPlan.manualSteps?.map((step, index) => (
                <Text key={`${step}-${index}`} style={styles.stepText}>{index + 1}. {step}</Text>
              ))}
              {bootstrapPlan.commandSnippets?.length ? (
                <Text style={styles.panelText}>Generated commands: {bootstrapPlan.commandSnippets.length}</Text>
              ) : null}
              <Pressable style={styles.secondaryButton} onPress={handleUseBootstrapDraft}>
                <Text style={styles.secondaryButtonText}>
                  {bootstrapPlan.profileReady ? 'Import ready profile' : 'Open draft profile'}
                </Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (viewMode === 'settings') {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.headerRow}>
            <Text style={styles.screenTitle}>Settings</Text>
            <Pressable style={styles.secondaryButtonCompact} onPress={() => setViewMode('home')}>
              <Text style={styles.secondaryButtonText}>Back</Text>
            </Pressable>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>App state</Text>
            <Text style={styles.detailValue}>Profiles saved: {profiles.length}</Text>
            <Text style={styles.detailValue}>Selected profile: {activeProfile?.name || 'None'}</Text>
            <Text style={styles.detailValue}>Helper API: {HELPER_API_BASE_CANDIDATES.join(' | ')}</Text>
            <Text style={styles.panelText}>The helper service is optional and is only used for bootstrap planning.</Text>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Developer actions</Text>
            <View style={styles.buttonRow}>
              <Pressable
                style={[styles.secondaryButton, styles.flexButton]}
                onPress={() => {
                  writeOnboardingComplete(false).catch(() => undefined);
                  setOnboardingComplete(false);
                  setOnboardingStep(0);
                }}
              >
                <Text style={styles.secondaryButtonText}>Replay onboarding</Text>
              </Pressable>
              <Pressable style={[styles.secondaryButton, styles.flexButton]} onPress={handleClearLogs}>
                <Text style={styles.secondaryButtonText}>Clear logs</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.screenTitle}>Wobb</Text>
            <Text style={styles.screenSubtitle}>Self-hosted VLESS and REALITY client</Text>
          </View>
          <View style={[styles.stateBadge, { backgroundColor: tone.background }]}> 
            <Text style={[styles.stateBadgeText, { color: tone.text }]}>{stateLabel(connectionState)}</Text>
          </View>
        </View>

        <View style={styles.connectionCard}>
          <View style={styles.connectionCopy}>
            <Text style={styles.sectionLabel}>Active profile</Text>
            <Text style={styles.connectionTitle}>{activeProfile ? activeProfile.name : 'No profile selected'}</Text>
            <Text style={styles.connectionSubtitle}>
              {activeProfile ? `${profileEndpoint(activeProfile)} | ${activeProfile.serverName}` : 'Create or import a local profile to start.'}
            </Text>
          </View>

          <Pressable
            disabled={!activeProfile || (connectionState !== 'connected' && !activeValidation.valid)}
            onPress={handleToggleConnection}
            style={[
              styles.connectButton,
              (!activeProfile || (connectionState !== 'connected' && !activeValidation.valid)) && styles.connectButtonDisabled,
            ]}
          >
            <Text style={styles.connectButtonLabel}>{connectLabel}</Text>
          </Pressable>
        </View>

        <View style={styles.summaryRow}>
          <View style={styles.summaryChip}>
            <Text style={styles.summaryLabel}>Mode</Text>
            <Text style={styles.summaryValue}>{activeProfile ? (activeProfile.mode === 'vpn' ? 'VPN' : 'Proxy') : '--'}</Text>
          </View>
          <View style={styles.summaryChip}>
            <Text style={styles.summaryLabel}>Endpoint</Text>
            <Text style={styles.summaryValue}>{activeProfile ? profileEndpoint(activeProfile) : '--'}</Text>
          </View>
          <View style={styles.summaryChip}>
            <Text style={styles.summaryLabel}>Recent</Text>
            <Text style={styles.summaryValue}>{activeProfile?.lastConnectionResult || '--'}</Text>
          </View>
        </View>

        {!activeValidation.valid && activeProfile ? <Text style={styles.warningText}>{validationText(activeValidation)}</Text> : null}

        <View style={styles.quickActionsWrap}>
          <Pressable style={styles.quickActionButton} onPress={handleOpenCreateProfile}>
            <Text style={styles.quickActionLabel}>Add</Text>
          </Pressable>
          <Pressable style={styles.quickActionButton} onPress={() => setViewMode('import')}>
            <Text style={styles.quickActionLabel}>Import</Text>
          </Pressable>
          <Pressable style={styles.quickActionButton} onPress={() => setViewMode('bootstrap')}>
            <Text style={styles.quickActionLabel}>Bootstrap</Text>
          </Pressable>
          <Pressable style={styles.quickActionButton} onPress={handleCopyProfileUri}>
            <Text style={styles.quickActionLabel}>Copy URI</Text>
          </Pressable>
        </View>

        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>Profiles</Text>
            <Pressable style={styles.secondaryButtonCompact} onPress={() => setViewMode('settings')}>
              <Text style={styles.secondaryButtonText}>Settings</Text>
            </Pressable>
          </View>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search profiles"
            placeholderTextColor={COLORS.muted}
            style={styles.input}
          />
          {filteredProfiles.length === 0 ? (
            <EmptyState
              title="No saved profiles"
              body="Create a profile manually or import a VLESS URI to start connecting from this device."
              actionLabel="Open import"
              onPress={() => setViewMode('import')}
            />
          ) : (
            filteredProfiles.map((profile, index) => {
              const selected = profile.id === activeProfileId;
              return (
                <View key={profile.id}>
                  {index > 0 ? <View style={styles.locationSeparator} /> : null}
                  <View style={[styles.locationRow, selected && styles.locationRowSelected]}>
                    <View style={styles.locationHeader}>
                      <View style={styles.locationTitleWrap}>
                        <Text style={styles.locationTitle}>{profile.name}</Text>
                        <Text style={styles.locationSubtitle}>{profile.host}:{profile.port} | {profile.serverName}</Text>
                      </View>
                      <Pressable style={styles.favoriteButton} onPress={() => handleToggleFavorite(profile)}>
                        <Text style={[styles.favoriteButtonText, profile.isFavorite && styles.favoriteButtonTextActive]}>
                          {profile.isFavorite ? 'Fav' : 'Star'}
                        </Text>
                      </Pressable>
                    </View>
                    <View style={styles.metaRow}>
                      <Text style={styles.metaChip}>{profile.mode === 'vpn' ? 'VPN' : 'Proxy'}</Text>
                      <Text style={styles.metaChip}>{profile.lastConnectionResult || 'Not connected yet'}</Text>
                      <Text style={styles.metaChip}>{formatRelativeTime(profile.lastUsedAt)}</Text>
                    </View>
                    <View style={styles.rowActionsWrap}>
                      <Pressable style={styles.rowAction} onPress={() => handleSelectProfile(profile)}>
                        <Text style={styles.rowActionText}>{selected ? 'Active' : 'Use'}</Text>
                      </Pressable>
                      <Pressable style={styles.rowAction} onPress={() => handleOpenEditProfile(profile)}>
                        <Text style={styles.rowActionText}>Edit</Text>
                      </Pressable>
                      <Pressable style={styles.rowAction} onPress={() => handleDuplicateProfile(profile)}>
                        <Text style={styles.rowActionText}>Duplicate</Text>
                      </Pressable>
                      <Pressable style={styles.rowActionDanger} onPress={() => handleDeleteProfile(profile)}>
                        <Text style={styles.rowActionDangerText}>Delete</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </View>

        <View style={styles.panel}>
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>Logs</Text>
            <View style={styles.inlineButtonRow}>
              <Pressable style={styles.secondaryButtonCompact} onPress={handleCopyLogs}>
                <Text style={styles.secondaryButtonText}>Copy</Text>
              </Pressable>
              <Pressable style={styles.secondaryButtonCompact} onPress={handleClearLogs}>
                <Text style={styles.secondaryButtonText}>Clear</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.logContainer}>
            {logs.length === 0 ? (
              <Text style={styles.logEmpty}>No logs yet.</Text>
            ) : (
              logs.map((entry) => (
                <View key={entry.id} style={styles.logRow}>
                  <Text style={styles.logMeta}>{entry.timestamp.slice(11, 19)} {entry.source.toUpperCase()}</Text>
                  <Text style={[styles.logMessage, entry.level === 'error' ? styles.logError : entry.level === 'warn' ? styles.logWarn : null]}>{entry.message}</Text>
                </View>
              ))
            )}
          </View>
        </View>

        <View style={styles.buttonRow}>
          <Pressable style={[styles.secondaryButton, styles.flexButton]} onPress={handleShareProfile}>
            <Text style={styles.secondaryButtonText}>Share active profile</Text>
          </Pressable>
          <Pressable style={[styles.secondaryButton, styles.flexButton]} onPress={() => setViewMode('settings')}>
            <Text style={styles.secondaryButtonText}>App settings</Text>
          </Pressable>
        </View>

        {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  scrollContent: {
    padding: 16,
    gap: 12,
  },
  logoBadge: {
    width: 52,
    height: 52,
    borderRadius: 8,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  logoBadgeText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700',
  },
  mutedText: {
    color: COLORS.muted,
    fontSize: 13,
  },
  onboardingRoot: {
    flex: 1,
    justifyContent: 'space-between',
    padding: 20,
  },
  onboardingHero: {
    paddingTop: 40,
  },
  onboardingEyebrow: {
    color: COLORS.accent,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 14,
  },
  onboardingTitle: {
    color: COLORS.text,
    fontSize: 34,
    fontWeight: '700',
    lineHeight: 40,
    maxWidth: 280,
  },
  onboardingBody: {
    color: COLORS.muted,
    fontSize: 16,
    lineHeight: 24,
    marginTop: 16,
    maxWidth: 320,
  },
  onboardingFooter: {
    gap: 18,
  },
  onboardingDots: {
    flexDirection: 'row',
    gap: 8,
  },
  onboardingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.border,
  },
  onboardingDotActive: {
    width: 22,
    backgroundColor: COLORS.accent,
  },
  onboardingActions: {
    flexDirection: 'row',
    gap: 10,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  headerCopy: {
    flex: 1,
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  screenTitle: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '700',
  },
  screenSubtitle: {
    color: COLORS.muted,
    fontSize: 14,
    marginTop: 4,
  },
  panel: {
    backgroundColor: COLORS.panel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    gap: 12,
  },
  panelTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
  },
  panelText: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  stateBadge: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  stateBadgeText: {
    fontSize: 12,
    fontWeight: '700',
  },
  connectionCard: {
    backgroundColor: COLORS.panel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    gap: 16,
  },
  connectionCopy: {
    gap: 6,
  },
  sectionLabel: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  connectionTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '700',
  },
  connectionSubtitle: {
    color: COLORS.muted,
    fontSize: 13,
  },
  connectButton: {
    width: '100%',
    borderRadius: 8,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
  },
  connectButtonDisabled: {
    opacity: 0.45,
  },
  connectButtonLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 10,
  },
  summaryChip: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelMuted,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  summaryLabel: {
    color: COLORS.muted,
    fontSize: 12,
  },
  summaryValue: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  quickActionsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  quickActionButton: {
    flexGrow: 1,
    minWidth: '22%',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelMuted,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    paddingHorizontal: 10,
  },
  quickActionLabel: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
  primaryButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
  secondaryButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelMuted,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonCompact: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelMuted,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  secondaryButtonText: {
    color: COLORS.text,
    fontWeight: '600',
  },
  flexButton: {
    flex: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 10,
  },
  inlineButtonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  fieldGroup: {
    gap: 8,
  },
  fieldLabel: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    backgroundColor: COLORS.panelMuted,
    color: COLORS.text,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  inputMultiline: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  importInput: {
    minHeight: 180,
    textAlignVertical: 'top',
  },
  segmentedToggle: {
    flexDirection: 'row',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelMuted,
    overflow: 'hidden',
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentButtonActive: {
    backgroundColor: COLORS.accent,
  },
  segmentButtonText: {
    color: COLORS.muted,
    fontWeight: '600',
    fontSize: 13,
  },
  segmentButtonTextActive: {
    color: '#FFFFFF',
  },
  inlineAction: {
    alignSelf: 'flex-start',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelMuted,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inlineActionText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
  },
  emptyState: {
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: COLORS.border,
    padding: 16,
    gap: 10,
    alignItems: 'flex-start',
  },
  emptyStateTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
  },
  emptyStateBody: {
    color: COLORS.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  locationSeparator: {
    height: 10,
  },
  locationRow: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    padding: 12,
    gap: 12,
    backgroundColor: COLORS.panelMuted,
  },
  locationRowSelected: {
    borderColor: COLORS.accent,
    backgroundColor: '#11213f',
  },
  locationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  locationTitleWrap: {
    flex: 1,
  },
  locationTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  locationSubtitle: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 4,
  },
  favoriteButton: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  favoriteButtonText: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  favoriteButtonTextActive: {
    color: COLORS.success,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  metaChip: {
    color: COLORS.muted,
    fontSize: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
    paddingHorizontal: 10,
    paddingVertical: 6,
    overflow: 'hidden',
  },
  rowActionsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  rowAction: {
    flexGrow: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.panel,
  },
  rowActionText: {
    color: COLORS.text,
    fontSize: 12,
    fontWeight: '600',
  },
  rowActionDanger: {
    flexGrow: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#5f2438',
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.dangerSoft,
  },
  rowActionDangerText: {
    color: COLORS.danger,
    fontSize: 12,
    fontWeight: '600',
  },
  logContainer: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    backgroundColor: COLORS.panelMuted,
    padding: 12,
    gap: 10,
    maxHeight: 320,
  },
  logRow: {
    gap: 4,
  },
  logMeta: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '600',
  },
  logMessage: {
    color: COLORS.text,
    fontSize: 13,
  },
  logWarn: {
    color: COLORS.warning,
  },
  logError: {
    color: COLORS.danger,
  },
  logEmpty: {
    color: COLORS.muted,
    fontSize: 13,
  },
  warningText: {
    color: COLORS.warning,
    fontSize: 13,
  },
  errorText: {
    color: COLORS.danger,
    textAlign: 'center',
    fontSize: 13,
  },
  detailValue: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  stepText: {
    color: COLORS.text,
    fontSize: 13,
    lineHeight: 20,
  },
});


