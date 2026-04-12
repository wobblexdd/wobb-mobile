import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  DeviceEventEmitter,
  Linking,
  NativeModules,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View
} from 'react-native';
import { GoogleSignin } from './googleSignIn';
import * as storage from './storage';

type ConnectionState =
  | 'idle'
  | 'verifying'
  | 'permission_required'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'blocked'
  | 'error';

type ConnectionMode = 'vpn' | 'proxy' | 'own_server';

type ApiError = Error & {
  code?: string;
  prompt?: string;
};

type SessionData = {
  mode: ConnectionMode;
  state: 'idle' | 'blocked';
  user: {
    id: number;
    googleEmail: string;
    googleSub: string;
    uuid: string;
    xrayUuid: string | null;
    vpnKey: string | null;
    installationId: string | null;
    telegramUsername: string | null;
  };
  subscription: {
    tier: string;
    title: string;
    status: string;
    isLifetime: boolean;
    isActive: boolean;
    expiryDate: string | null;
    daysRemaining: number | null;
    devicesLimit: number;
    blockedReason: string | null;
  };
  traffic: {
    usedBytes: number;
    limitBytes: number;
    remainingBytes: number;
  };
  location: {
    selectedId: string | null;
  };
  provisioning: {
    assignedEndpoint: string | null;
    maintenanceMode: boolean;
    maintenanceReason: string | null;
    vpnConfig: Record<string, unknown> | null;
  };
  diagnostics: {
    serverTime: string;
    messages: Array<{
      level?: string;
      message: string;
    }>;
  };
};

type SessionApiResponse = {
  success: boolean;
  message?: string;
  data?: SessionData;
};

type LocationItem = {
  id: string;
  country: string;
  flag: string;
  city: string;
  loadPercent: number;
};

type DiagnosticLogEntry = {
  id: string;
  level: 'info' | 'warn' | 'error';
  source: 'app' | 'native' | 'api';
  message: string;
  timestamp: string;
};

type OnboardingSlide = {
  eyebrow: string;
  title: string;
  body: string;
};

const API_BASE_CANDIDATES = ['http://127.0.0.1:3000', 'http://10.0.2.2:3000'];
const SESSION_CACHE_KEY = 'wobb.mobile.session.v7';
const SESSION_TOKEN_KEY = 'wobb.mobile.session-token.v4';
const INSTALLATION_ID_KEY = 'wobb.mobile.installation-id.v1';
const SELECTED_LOCATION_KEY = 'wobb.mobile.location.v1';
const ONBOARDING_COMPLETE_KEY = 'wobb.mobile.onboarding.v1';
const GOOGLE_WEB_CLIENT_ID =
  '157778125537-th8lu3rlhkm1gieqisv0e73lvdh0g5re.apps.googleusercontent.com';

const ONBOARDING_SLIDES: OnboardingSlide[] = [
  {
    eyebrow: 'Fast secure connection',
    title: 'Connect in seconds',
    body: 'Set up your account, choose a server, and keep the flow simple from the first launch.',
  },
  {
    eyebrow: 'Global access made simple',
    title: 'Pick a server and go',
    body: 'Refresh your session, switch locations, and use one clean connection path.',
  },
  {
    eyebrow: 'Private by design',
    title: 'Modern infrastructure',
    body: 'Provisioning stays tied to your current account and subscription state.',
  },
  {
    eyebrow: 'Ready to continue',
    title: 'Sign in with Google',
    body: 'Use your Google account to load your plan and create the current session.',
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
  accentSoft: '#1d4ed8',
  success: '#bfdbfe',
  successSoft: '#172554',
  warning: '#cbd5e1',
  warningSoft: '#1e293b',
  danger: '#fca5a5',
  dangerSoft: '#3f1d2e'
};

const { WobbVpnModule } = NativeModules as {
  WobbVpnModule?: {
    prepareVpn?: () => Promise<{ granted?: boolean }>;
    startVpn?: (configJson: string) => Promise<void>;
    stopVpn?: () => Promise<void>;
    getOrCreateInstallationId?: () => Promise<string>;
  };
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
  }
};

function createPseudoUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const next = character === 'x' ? random : (random & 0x3) | 0x8;
    return next.toString(16);
  });
}

async function getInstallationId(): Promise<string> {
  if (WobbVpnModule?.getOrCreateInstallationId) {
    return WobbVpnModule.getOrCreateInstallationId();
  }

  const existing = await storage.getItem(INSTALLATION_ID_KEY);
  if (existing) {
    return existing;
  }

  const created = createPseudoUuid();
  await storage.setItem(INSTALLATION_ID_KEY, created);
  return created;
}

async function readCachedSession(): Promise<SessionData | null> {
  const raw = await storage.getItem(SESSION_CACHE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

async function writeCachedSession(session: SessionData): Promise<void> {
  await storage.setItem(SESSION_CACHE_KEY, JSON.stringify(session));
}

async function readCachedToken(): Promise<string | null> {
  return storage.getItem(SESSION_TOKEN_KEY);
}

async function writeCachedToken(idToken: string): Promise<void> {
  await storage.setItem(SESSION_TOKEN_KEY, idToken);
}

async function readSelectedLocation(): Promise<string | null> {
  return storage.getItem(SELECTED_LOCATION_KEY);
}

async function writeSelectedLocation(locationId: string): Promise<void> {
  await storage.setItem(SELECTED_LOCATION_KEY, locationId);
}

async function readOnboardingComplete(): Promise<boolean> {
  return (await storage.getItem(ONBOARDING_COMPLETE_KEY)) === '1';
}

async function writeOnboardingComplete(): Promise<void> {
  await storage.setItem(ONBOARDING_COMPLETE_KEY, '1');
}

function formatBytes(bytes: number): string {
  const safeBytes = Math.max(0, Number(bytes || 0));
  const gb = safeBytes / (1024 * 1024 * 1024);
  const rounded = gb < 10 ? Math.round(gb * 10) / 10 : Math.round(gb);
  return `${rounded} GB`;
}

function formatExpiry(subscription: SessionData['subscription']): string {
  if (subscription.isLifetime) {
    return 'Lifetime';
  }

  if (subscription.daysRemaining == null) {
    return 'Unknown';
  }

  return `${subscription.daysRemaining} day${subscription.daysRemaining === 1 ? '' : 's'}`;
}

function formatBlockedReason(reason: string | null): string {
  switch (reason) {
    case 'quota_exhausted':
      return 'Traffic limit reached';
    case 'expired':
      return 'Subscription expired';
    case 'inactive':
      return 'Subscription inactive';
    default:
      return reason || 'Blocked';
  }
}

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
    timestamp: new Date().toISOString()
  };
}

function deriveConnectionState(session: SessionData | null, localState: ConnectionState): ConnectionState {
  if (session?.subscription?.blockedReason) {
    return 'blocked';
  }

  return localState;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: unknown;

  for (const baseUrl of API_BASE_CANDIDATES) {
    try {
      const response = await fetch(`${baseUrl}${path}`, init);
      const payload = (await response.json()) as T & { message?: string; code?: string; prompt?: string };

      if (!response.ok) {
        const error = new Error(payload.message || `Request failed with status ${response.status}`) as ApiError;
        error.code = payload.code;
        error.prompt = payload.prompt;
        throw error;
      }

      return payload;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('API request failed');
}

async function openMobileSession(params: {
  installationId: string;
  googleIdToken: string;
  transferSession?: boolean;
  locationId?: string;
}): Promise<SessionApiResponse> {
  return apiRequest<SessionApiResponse>('/api/v1/mobile/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params)
  });
}

async function fetchMobileState(
  installationId: string,
  locationId?: string
): Promise<SessionApiResponse> {
  const query = locationId ? `?locationId=${encodeURIComponent(locationId)}` : '';
  return apiRequest<SessionApiResponse>(`/api/v1/mobile/state/${installationId}${query}`);
}

async function fetchLocations(): Promise<LocationItem[]> {
  const response = await apiRequest<{ success: boolean; data?: LocationItem[] }>('/api/locations');
  return response.data || [];
}

function stateLabel(state: ConnectionState, session: SessionData | null): string {
  switch (state) {
    case 'verifying':
      return 'Verifying access';
    case 'permission_required':
      return 'VPN permission required';
    case 'connecting':
      return 'Connecting';
    case 'connected':
      return 'Connected';
    case 'disconnecting':
      return 'Disconnecting';
    case 'blocked':
      return formatBlockedReason(session?.subscription?.blockedReason || null);
    case 'error':
      return 'Connection error';
    default:
      return 'Idle';
  }
}

function stateTone(state: ConnectionState) {
  if (state === 'connected') {
    return {
      text: COLORS.success,
      background: COLORS.successSoft
    };
  }

  if (state === 'blocked' || state === 'error') {
    return {
      text: COLORS.danger,
      background: COLORS.dangerSoft
    };
  }

  if (state === 'verifying' || state === 'connecting' || state === 'disconnecting' || state === 'permission_required') {
    return {
      text: COLORS.warning,
      background: COLORS.warningSoft
    };
  }

  return {
    text: COLORS.text,
    background: COLORS.accentSoft
  };
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [localConnectionState, setLocalConnectionState] = useState<ConnectionState>('idle');
  const [session, setSession] = useState<SessionData | null>(null);
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [logs, setLogs] = useState<DiagnosticLogEntry[]>([]);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef<SessionData | null>(null);

  const effectiveConnectionState = deriveConnectionState(session, localConnectionState);
  const tone = stateTone(effectiveConnectionState);
  const currentSlide = ONBOARDING_SLIDES[Math.min(onboardingStep, ONBOARDING_SLIDES.length - 1)];
  const selectedLocation = useMemo(() => {
    const targetId = selectedLocationId || session?.location.selectedId || null;
    if (!targetId) {
      return locations[0] || null;
    }

    return locations.find((entry) => entry.id === targetId) || null;
  }, [locations, selectedLocationId, session?.location.selectedId]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  function appendLog(
    source: DiagnosticLogEntry['source'],
    message: string,
    level: DiagnosticLogEntry['level'] = 'info'
  ) {
    setLogs((current) => [...current, createLogEntry(source, message, level)].slice(-120));
  }

  async function applySession(response: SessionApiResponse) {
    if (!response.data) {
      return;
    }

    await writeCachedSession(response.data);
    setSession(response.data);
    setSelectedLocationId(response.data.location.selectedId);

    if (response.data.diagnostics.messages.length > 0) {
      for (const message of response.data.diagnostics.messages) {
        appendLog('api', message.message, (message.level as DiagnosticLogEntry['level']) || 'info');
      }
    }

    if (response.data.provisioning.maintenanceMode && response.data.provisioning.maintenanceReason) {
      appendLog('api', response.data.provisioning.maintenanceReason, 'warn');
    }

    if (response.message === 'Limit Exceeded' || response.data.subscription.blockedReason) {
      setLocalConnectionState('blocked');
    } else if (localConnectionState === 'verifying') {
      setLocalConnectionState('idle');
    }
  }

  useEffect(() => {
    let cancelled = false;

    const statusListener = DeviceEventEmitter.addListener('WobbVpnStatus', (payload) => {
      const status = String(payload?.status || '').toLowerCase();

      if (status === 'connecting') {
        setLocalConnectionState('connecting');
        appendLog('native', 'VPN service is starting.');
      } else if (status === 'connected') {
        setLocalConnectionState('connected');
        appendLog('native', 'VPN tunnel connected.');
      } else if (status === 'disconnecting') {
        setLocalConnectionState('disconnecting');
        appendLog('native', 'VPN tunnel is stopping.');
      } else if (status === 'idle' || status === 'disconnected') {
        setLocalConnectionState(sessionRef.current?.subscription.blockedReason ? 'blocked' : 'idle');
        appendLog('native', 'VPN tunnel is idle.');
      } else if (status === 'error') {
        setLocalConnectionState('error');
        appendLog('native', 'VPN service reported an error.', 'error');
      }
    });

    const permissionListener = DeviceEventEmitter.addListener('WobbVpnPermission', (payload) => {
      const status = String(payload?.status || '').toLowerCase();
      if (status === 'requested') {
        setLocalConnectionState('permission_required');
        appendLog('native', 'VPN permission requested on device.', 'warn');
      } else if (status === 'denied') {
        setLocalConnectionState('permission_required');
        appendLog('native', 'VPN permission denied.', 'error');
      } else if (status === 'granted') {
        appendLog('native', 'VPN permission granted.');
      }
    });

    const logListener = DeviceEventEmitter.addListener('WobbVpnLog', (payload) => {
      const stream = String(payload?.stream || 'native').toLowerCase();
      const level = stream === 'stderr' ? 'error' : stream === 'service' ? 'info' : 'warn';
      appendLog('native', String(payload?.message || ''), level);
    });

    async function bootstrap() {
      try {
        await GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID, offlineAccess: false });

        const [nextInstallationId, savedLocationId, cached, fetchedLocations, onboardingDone] = await Promise.all([
          getInstallationId(),
          readSelectedLocation(),
          readCachedSession(),
          fetchLocations(),
          readOnboardingComplete()
        ]);

        if (cancelled) {
          return;
        }

        setOnboardingComplete(onboardingDone);
        setInstallationId(nextInstallationId);
        setLocations(fetchedLocations);
        appendLog('app', 'Application initialized.');

        const defaultLocationId =
          savedLocationId && fetchedLocations.some((entry) => entry.id === savedLocationId)
            ? savedLocationId
            : cached?.location.selectedId || fetchedLocations[0]?.id || null;

        setSelectedLocationId(defaultLocationId);

        if (cached) {
          setSession(cached);
          appendLog('app', 'Loaded cached session.');
        }

        const cachedToken = await readCachedToken();
        if (cachedToken) {
          setLocalConnectionState('verifying');
          const response = await openMobileSession({
            installationId: nextInstallationId,
            googleIdToken: cachedToken,
            locationId: defaultLocationId || undefined
          });
          await applySession(response);
          if (defaultLocationId) {
            await writeSelectedLocation(defaultLocationId);
          }
          appendLog('api', 'Session refreshed from backend.');
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Failed to initialize app.';
          setErrorText(message);
          setLocalConnectionState('error');
          appendLog('app', message, 'error');
        }
      } finally {
        if (!cancelled) {
          setBooting(false);
        }
      }
    }

    bootstrap();

    return () => {
      cancelled = true;
      statusListener.remove();
      permissionListener.remove();
      logListener.remove();
    };
  }, []);

  useEffect(() => {
    if (!installationId || !session) {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }

    const refresh = async () => {
      try {
        const response = await fetchMobileState(
          installationId,
          selectedLocationId || session.location.selectedId || undefined
        );
        await applySession(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to refresh state.';
        setErrorText(message);
        appendLog('api', message, 'error');
      }
    };

    refresh();
    pollingRef.current = setInterval(refresh, 60 * 1000);

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [installationId, selectedLocationId, session?.user.id, session?.location.selectedId]);

  async function handleCompleteOnboarding() {
    await writeOnboardingComplete();
    setOnboardingComplete(true);
  }

  async function handleSignIn() {
    setErrorText(null);
    setLocalConnectionState('verifying');

    try {
      const nextInstallationId = installationId || (await getInstallationId());
      const user = await GoogleSignin.signIn();
      if (!user.idToken) {
        throw new Error('Google sign-in did not return an idToken.');
      }

      await writeCachedToken(user.idToken);
      const response = await openMobileSession({
        installationId: nextInstallationId,
        googleIdToken: user.idToken,
        locationId: selectedLocationId || undefined
      });

      await applySession(response);
      setInstallationId(nextInstallationId);
      appendLog('api', 'Signed in and session created.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sign-in failed.';
      setErrorText(message);
      setLocalConnectionState('error');
      appendLog('api', message, 'error');
    }
  }

  async function handleLocationSelect(location: LocationItem) {
    if (!installationId) {
      return;
    }

    setSelectedLocationId(location.id);
    await writeSelectedLocation(location.id);
    appendLog('app', `Selected location ${location.country}.`);

    try {
      setLocalConnectionState('verifying');
      const response = await fetchMobileState(installationId, location.id);
      await applySession(response);
      setErrorText(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to switch location.';
      setErrorText(message);
      setLocalConnectionState('error');
      appendLog('api', message, 'error');
    }
  }

  async function handleToggleVpn() {
    if (!session) {
      return;
    }

    if (session.subscription.blockedReason) {
      setLocalConnectionState('blocked');
      setErrorText(formatBlockedReason(session.subscription.blockedReason));
      return;
    }

    try {
      setErrorText(null);

      if (effectiveConnectionState === 'connected' || effectiveConnectionState === 'connecting') {
        setLocalConnectionState('disconnecting');
        await VpnInterface.stop();
        return;
      }

      const vpnConfig = session.provisioning.vpnConfig;
      if (!vpnConfig) {
        throw new Error('VPN config is unavailable for this account.');
      }

      setLocalConnectionState('connecting');
      await VpnInterface.prepare();
      await VpnInterface.start(vpnConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'VPN error.';
      setLocalConnectionState('error');
      setErrorText(message);
      appendLog('native', message, 'error');
    }
  }

  async function handleOpenTelegramPurchase() {
    try {
      await Linking.openURL('https://t.me/wobbvpnbot');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open Telegram.';
      setErrorText(message);
      appendLog('app', message, 'error');
    }
  }

  async function handleRefreshSession() {
    if (!installationId) {
      return;
    }

    try {
      setErrorText(null);
      setLocalConnectionState('verifying');
      const response = await fetchMobileState(
        installationId,
        selectedLocation?.id || session?.location.selectedId || undefined
      );
      await applySession(response);
      appendLog('api', 'Session refreshed.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to refresh session.';
      setErrorText(message);
      setLocalConnectionState('error');
      appendLog('api', message, 'error');
    }
  }

  async function handleShareSession() {
    if (!session) {
      return;
    }

    try {
      const lines = [
        'Wobb',
        `Status: ${stateLabel(effectiveConnectionState, session)}`,
        `Server: ${selectedLocation ? `${selectedLocation.country}${selectedLocation.city ? `, ${selectedLocation.city}` : ''}` : 'Not selected'}`,
        `Mode: ${session.mode === 'vpn' ? 'TUN' : session.mode === 'proxy' ? 'Proxy' : 'Own server'}`
      ];

      if (session.provisioning.assignedEndpoint) {
        lines.push(`Endpoint: ${session.provisioning.assignedEndpoint}`);
      }

      await Share.share({ message: lines.join('\n') });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to share session.';
      setErrorText(message);
      appendLog('app', message, 'error');
    }
  }

  async function handleOpenSettings() {
    try {
      await Linking.openSettings();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to open settings.';
      setErrorText(message);
      appendLog('app', message, 'error');
    }
  }

  const connectLabel = useMemo(() => {
    if (effectiveConnectionState === 'connected') {
      return 'Disconnect';
    }
    if (effectiveConnectionState === 'connecting' || effectiveConnectionState === 'verifying') {
      return 'Working';
    }
    if (effectiveConnectionState === 'disconnecting') {
      return 'Stopping';
    }
    if (effectiveConnectionState === 'blocked') {
      return 'Blocked';
    }
    return 'Connect';
  }, [effectiveConnectionState]);

  const connectDisabled =
    !session ||
    !session.provisioning.vpnConfig ||
    effectiveConnectionState === 'verifying' ||
    effectiveConnectionState === 'disconnecting' ||
    effectiveConnectionState === 'blocked';

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />

      {booting ? (
        <View style={styles.center}>
          <View style={styles.logoBadge}>
            <Text style={styles.logoBadgeText}>W</Text>
          </View>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.screenTitle}>Wobb</Text>
          <Text style={styles.mutedText}>Preparing your local session.</Text>
        </View>
      ) : !onboardingComplete ? (
        <View style={styles.onboardingRoot}>
          <View style={styles.onboardingHero}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoBadgeText}>W</Text>
            </View>
            <Text style={styles.onboardingEyebrow}>{currentSlide.eyebrow}</Text>
            <Text style={styles.onboardingTitle}>{currentSlide.title}</Text>
            <Text style={styles.onboardingBody}>{currentSlide.body}</Text>
          </View>

          <View style={styles.onboardingPanel}>
            <View style={styles.featureCard}>
              <Text style={styles.featureCardTitle}>Simple setup</Text>
              <Text style={styles.featureCardBody}>
                Sign in, choose a location, and keep the connection flow predictable.
              </Text>
            </View>
            <View style={styles.featureCard}>
              <Text style={styles.featureCardTitle}>Account-based access</Text>
              <Text style={styles.featureCardBody}>
                Subscription state, provisioning, and diagnostics all come from the backend.
              </Text>
            </View>

            <View style={styles.onboardingDots}>
              {ONBOARDING_SLIDES.map((_, index) => (
                <View
                  key={index}
                  style={[styles.onboardingDot, index === onboardingStep && styles.onboardingDotActive]}
                />
              ))}
            </View>

            <View style={styles.onboardingActions}>
              <Pressable style={styles.secondaryButton} onPress={handleCompleteOnboarding}>
                <Text style={styles.secondaryButtonText}>Skip</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryButton, styles.flexButton]}
                onPress={() => {
                  if (onboardingStep === ONBOARDING_SLIDES.length - 1) {
                    handleCompleteOnboarding();
                    return;
                  }
                  setOnboardingStep((current) => current + 1);
                }}
              >
                <Text style={styles.primaryButtonText}>
                  {onboardingStep === ONBOARDING_SLIDES.length - 1 ? 'Continue' : 'Next'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : !session ? (
        <View style={styles.center}>
          <View style={styles.signInCard}>
            <View style={styles.logoBadge}>
              <Text style={styles.logoBadgeText}>W</Text>
            </View>
            <Text style={styles.screenTitle}>Wobb</Text>
            <Text style={styles.signInText}>
              Sign in to load your subscription, choose a server, and create a secure session.
            </Text>
            <Pressable style={[styles.primaryButton, styles.fullWidthButton]} onPress={handleSignIn}>
              <Text style={styles.primaryButtonText}>Sign in with Google</Text>
            </Pressable>
            <Text style={styles.signInHint}>
              Your account is used to verify access and load the current connection state.
            </Text>
          </View>
          {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text style={styles.screenTitle}>Wobb</Text>
              <Text style={styles.screenSubtitle}>{session.user.googleEmail}</Text>
            </View>
            <View style={[styles.stateBadge, { backgroundColor: tone.background }]}>
              <Text style={[styles.stateBadgeText, { color: tone.text }]}>
                {stateLabel(effectiveConnectionState, session)}
              </Text>
            </View>
          </View>

          <View style={styles.connectionCard}>
            <View style={styles.connectionCopy}>
              <Text style={styles.sectionLabel}>Selected Server</Text>
              <Text style={styles.connectionTitle}>
                {selectedLocation ? selectedLocation.country : 'No server selected'}
              </Text>
              <Text style={styles.connectionSubtitle}>
                {selectedLocation
                  ? `${selectedLocation.city || 'Default edge'}${session.provisioning.assignedEndpoint ? ` - ${session.provisioning.assignedEndpoint}` : ''}`
                  : 'No endpoint assigned'}
              </Text>
            </View>

            <Pressable
              disabled={connectDisabled}
              onPress={handleToggleVpn}
              style={[styles.connectButton, connectDisabled && styles.connectButtonDisabled]}
            >
              <Text style={styles.connectButtonLabel}>{connectLabel}</Text>
            </Pressable>
          </View>

          <View style={styles.summaryRow}>
            <View style={styles.summaryChip}>
              <Text style={styles.summaryLabel}>Mode</Text>
              <Text style={styles.summaryValue}>
                {session.mode === 'vpn' ? 'TUN' : session.mode === 'proxy' ? 'Proxy' : 'Own server'}
              </Text>
            </View>
            <View style={styles.summaryChip}>
              <Text style={styles.summaryLabel}>Server</Text>
              <Text style={styles.summaryValue}>
                {selectedLocation ? selectedLocation.flag : '--'}
              </Text>
            </View>
          </View>

          <View style={styles.quickActions}>
            <Pressable style={styles.quickActionButton} onPress={handleRefreshSession}>
              <Text style={styles.quickActionLabel}>Refresh</Text>
            </Pressable>
            <Pressable style={styles.quickActionButton} onPress={handleShareSession}>
              <Text style={styles.quickActionLabel}>Share</Text>
            </Pressable>
            <Pressable style={styles.quickActionButton} onPress={handleOpenSettings}>
              <Text style={styles.quickActionLabel}>Settings</Text>
            </Pressable>
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Plan</Text>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Tier</Text>
              <Text style={styles.detailValue}>{session.subscription.title}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Traffic</Text>
              <Text style={styles.detailValue}>
                {formatBytes(session.traffic.usedBytes)} / {formatBytes(session.traffic.limitBytes)}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Expiry</Text>
              <Text style={styles.detailValue}>{formatExpiry(session.subscription)}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>State</Text>
              <Text style={styles.detailValue}>
                {session.subscription.blockedReason
                  ? formatBlockedReason(session.subscription.blockedReason)
                  : session.subscription.status}
              </Text>
            </View>
            {session.subscription.blockedReason ? (
              <Pressable style={styles.inlineAction} onPress={handleOpenTelegramPurchase}>
                <Text style={styles.inlineActionText}>Open Telegram</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Servers</Text>
            {locations.map((item, index) => {
              const selected = item.id === (selectedLocationId || session.location.selectedId);
              return (
                <React.Fragment key={item.id}>
                  {index > 0 ? <View style={styles.locationSeparator} /> : null}
                  <Pressable
                    onPress={() => handleLocationSelect(item)}
                    style={[styles.locationRow, selected && styles.locationRowSelected]}
                  >
                    <View style={styles.locationPrimary}>
                      <Text style={styles.locationFlag}>{item.flag}</Text>
                      <View>
                        <Text style={styles.locationTitle}>{item.country}</Text>
                        <Text style={styles.locationSubtitle}>{item.city || 'Default edge'}</Text>
                      </View>
                    </View>
                    <Text style={styles.locationMeta}>{selected ? 'Selected' : item.city || 'Server'}</Text>
                  </Pressable>
                </React.Fragment>
              );
            })}
          </View>

          <View style={styles.panel}>
            <Text style={styles.panelTitle}>Logs</Text>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Backend state</Text>
              <Text style={styles.detailValue}>{session.state}</Text>
            </View>
            {session.provisioning.maintenanceReason ? (
              <Text style={styles.warningText}>{session.provisioning.maintenanceReason}</Text>
            ) : null}
            <View style={styles.logContainer}>
              {logs.length === 0 ? (
                <Text style={styles.logEmpty}>No diagnostics yet.</Text>
              ) : (
                logs.map((entry) => (
                  <View key={entry.id} style={styles.logRow}>
                    <Text style={styles.logMeta}>
                      {entry.timestamp.slice(11, 19)} {entry.source.toUpperCase()}
                    </Text>
                    <Text
                      style={[
                        styles.logMessage,
                        entry.level === 'error'
                          ? styles.logError
                          : entry.level === 'warn'
                            ? styles.logWarn
                            : null
                      ]}
                    >
                      {entry.message}
                    </Text>
                  </View>
                ))
              )}
            </View>
          </View>

          {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: COLORS.background
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12
  },
  onboardingRoot: {
    flex: 1,
    justifyContent: 'space-between',
    padding: 20
  },
  onboardingHero: {
    paddingTop: 40
  },
  logoBadge: {
    width: 52,
    height: 52,
    borderRadius: 8,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18
  },
  logoBadgeText: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '700'
  },
  onboardingEyebrow: {
    color: COLORS.accent,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 14
  },
  onboardingTitle: {
    color: COLORS.text,
    fontSize: 34,
    fontWeight: '700',
    lineHeight: 40,
    maxWidth: 280
  },
  onboardingBody: {
    color: COLORS.muted,
    fontSize: 16,
    lineHeight: 24,
    marginTop: 16,
    maxWidth: 320
  },
  onboardingPanel: {
    backgroundColor: COLORS.panel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 18,
    gap: 14
  },
  featureCard: {
    backgroundColor: COLORS.panelMuted,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 14
  },
  featureCardTitle: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 6
  },
  featureCardBody: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 19
  },
  onboardingDots: {
    flexDirection: 'row',
    gap: 8
  },
  onboardingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLORS.border
  },
  onboardingDotActive: {
    width: 22,
    backgroundColor: COLORS.accent
  },
  onboardingActions: {
    flexDirection: 'row',
    gap: 10
  },
  scrollContent: {
    padding: 16,
    gap: 12
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12
  },
  headerCopy: {
    flex: 1
  },
  screenTitle: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '700'
  },
  screenSubtitle: {
    color: COLORS.muted,
    fontSize: 14,
    marginTop: 4
  },
  panel: {
    backgroundColor: COLORS.panel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    gap: 12
  },
  connectionCard: {
    backgroundColor: COLORS.panel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    gap: 16
  },
  connectionCopy: {
    gap: 6
  },
  sectionLabel: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase'
  },
  connectionTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: '700'
  },
  connectionSubtitle: {
    color: COLORS.muted,
    fontSize: 13
  },
  panelTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700'
  },
  stateBadge: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  stateBadgeText: {
    fontSize: 12,
    fontWeight: '700'
  },
  connectButton: {
    width: '100%',
    borderRadius: 8,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14
  },
  connectButtonDisabled: {
    opacity: 0.45
  },
  connectButtonLabel: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700'
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 10
  },
  summaryChip: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelMuted,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4
  },
  summaryLabel: {
    color: COLORS.muted,
    fontSize: 12
  },
  summaryValue: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600'
  },
  quickActions: {
    flexDirection: 'row',
    gap: 10
  },
  quickActionButton: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelMuted,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11
  },
  quickActionLabel: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600'
  },
  primaryButton: {
    backgroundColor: COLORS.accent,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 18
  },
  fullWidthButton: {
    alignSelf: 'stretch'
  },
  flexButton: {
    flex: 1
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700'
  },
  secondaryButton: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: COLORS.panelMuted,
    alignItems: 'center',
    justifyContent: 'center'
  },
  secondaryButtonText: {
    color: COLORS.text,
    fontWeight: '600'
  },
  signInCard: {
    alignSelf: 'stretch',
    backgroundColor: COLORS.panel,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 24,
    alignItems: 'center'
  },
  signInText: {
    color: COLORS.muted,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 20
  },
  signInHint: {
    color: COLORS.muted,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 14,
    textAlign: 'center'
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12
  },
  detailLabel: {
    color: COLORS.muted,
    fontSize: 14
  },
  detailValue: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right'
  },
  locationSeparator: {
    height: 10
  },
  locationRow: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: COLORS.panelMuted
  },
  locationRowSelected: {
    backgroundColor: '#11213f',
    borderColor: COLORS.accent
  },
  locationPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1
  },
  locationFlag: {
    width: 28,
    textAlign: 'center',
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700'
  },
  locationTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600'
  },
  locationSubtitle: {
    color: COLORS.muted,
    fontSize: 12
  },
  locationMeta: {
    color: COLORS.muted,
    fontSize: 12,
    maxWidth: 90,
    textAlign: 'right'
  },
  logContainer: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    backgroundColor: COLORS.panelMuted,
    padding: 12,
    gap: 10,
    maxHeight: 260
  },
  logRow: {
    gap: 4
  },
  logMeta: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '600'
  },
  logMessage: {
    color: COLORS.text,
    fontSize: 13
  },
  logWarn: {
    color: COLORS.warning
  },
  logError: {
    color: COLORS.danger
  },
  logEmpty: {
    color: COLORS.muted,
    fontSize: 13
  },
  warningText: {
    color: COLORS.warning,
    fontSize: 13
  },
  inlineAction: {
    marginTop: 8,
    alignSelf: 'flex-start',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panelMuted,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  inlineActionText: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600'
  },
  mutedText: {
    color: COLORS.muted,
    fontSize: 13
  },
  errorText: {
    color: COLORS.danger,
    textAlign: 'center',
    fontSize: 13
  }
});
