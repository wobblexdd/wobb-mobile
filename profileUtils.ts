export type ProfileMode = 'vpn' | 'proxy';
export type BootstrapAuthMethod = 'private_key' | 'password';

export type LocalProfile = {
  id: string;
  name: string;
  host: string;
  port: string;
  uuid: string;
  security: 'reality';
  serverName: string;
  publicKey: string;
  shortId: string;
  fingerprint: string;
  spiderX: string;
  flow: string;
  remarks: string;
  mode: ProfileMode;
  isFavorite: boolean;
  lastUsedAt: string | null;
  lastConnectionResult: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BootstrapDraft = {
  profileName: string;
  publicHost: string;
  publicPort: string;
  serverName: string;
  realityDest: string;
  fingerprint: string;
  spiderX: string;
  flow: string;
  mode: ProfileMode;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  authMethod: BootstrapAuthMethod;
  uuid: string;
  publicKey: string;
  shortId: string;
  remarks: string;
};

export type ValidationResult = {
  valid: boolean;
  errors: string[];
  fieldErrors: Partial<Record<keyof LocalProfile, string>>;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function generateUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const next = character === 'x' ? random : (random & 0x3) | 0x8;
    return next.toString(16);
  });
}

export function normalizeMode(value: unknown): ProfileMode {
  return value === 'proxy' ? 'proxy' : 'vpn';
}

export function normalizeBootstrapAuthMethod(value: unknown): BootstrapAuthMethod {
  return value === 'password' ? 'password' : 'private_key';
}

export function isPlaceholderValue(value: unknown): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('example.com') ||
    normalized.includes('replace-with-') ||
    normalized.includes('your-') ||
    normalized === 'change-me' ||
    normalized === 'test-public-key' ||
    normalized === 'test-short-id'
  );
}

export function createEmptyProfile(overrides: Partial<LocalProfile> = {}): LocalProfile {
  const timestamp = nowIso();
  return {
    id: overrides.id || generateUuid(),
    name: overrides.name || '',
    host: overrides.host || '',
    port: String(overrides.port || '8443'),
    uuid: overrides.uuid || generateUuid(),
    security: 'reality',
    serverName: overrides.serverName || 'www.google.com',
    publicKey: overrides.publicKey || '',
    shortId: overrides.shortId || '',
    fingerprint: overrides.fingerprint || 'chrome',
    spiderX: overrides.spiderX || '/',
    flow: overrides.flow || 'xtls-rprx-vision',
    remarks: overrides.remarks || '',
    mode: normalizeMode(overrides.mode),
    isFavorite: Boolean(overrides.isFavorite),
    lastUsedAt: overrides.lastUsedAt || null,
    lastConnectionResult: overrides.lastConnectionResult || null,
    createdAt: overrides.createdAt || timestamp,
    updatedAt: overrides.updatedAt || timestamp,
  };
}

export function createEmptyBootstrapDraft(): BootstrapDraft {
  return {
    profileName: 'My VPS',
    publicHost: '',
    publicPort: '8443',
    serverName: 'www.google.com',
    realityDest: 'www.google.com:443',
    fingerprint: 'chrome',
    spiderX: '/',
    flow: 'xtls-rprx-vision',
    mode: 'vpn',
    sshHost: '',
    sshPort: '22',
    sshUser: 'root',
    authMethod: 'private_key',
    uuid: '',
    publicKey: '',
    shortId: '',
    remarks: '',
  };
}

export function validateProfile(profile: LocalProfile): ValidationResult {
  const errors: string[] = [];
  const fieldErrors: ValidationResult['fieldErrors'] = {};
  const host = String(profile.host || '').trim();
  const name = String(profile.name || '').trim();
  const serverName = String(profile.serverName || '').trim();
  const publicKey = String(profile.publicKey || '').trim();
  const shortId = String(profile.shortId || '').trim();
  const uuid = String(profile.uuid || '').trim();
  const fingerprint = String(profile.fingerprint || '').trim();
  const port = Number(profile.port);

  function push(field: keyof LocalProfile, message: string) {
    errors.push(message);
    fieldErrors[field] = message;
  }

  if (!name) {
    push('name', 'Profile name is required.');
  }
  if (!host || isPlaceholderValue(host)) {
    push('host', 'Server host is required.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    push('port', 'Server port must be between 1 and 65535.');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    push('uuid', 'UUID must be a valid UUID.');
  }
  if (!serverName || isPlaceholderValue(serverName)) {
    push('serverName', 'Server name is required.');
  }
  if (!publicKey || isPlaceholderValue(publicKey)) {
    push('publicKey', 'REALITY public key is required.');
  }
  if (!shortId || isPlaceholderValue(shortId)) {
    push('shortId', 'REALITY short ID is required.');
  }
  if (!fingerprint) {
    push('fingerprint', 'Fingerprint is required.');
  }

  return {
    valid: errors.length === 0,
    errors,
    fieldErrors,
  };
}

export function normalizeProfile(input: Partial<LocalProfile>): LocalProfile {
  const next = createEmptyProfile({
    ...input,
    id: input.id || generateUuid(),
    name: String(input.name || '').trim(),
    host: String(input.host || '').trim(),
    port: String(input.port || '').trim(),
    uuid: String(input.uuid || '').trim(),
    serverName: String(input.serverName || '').trim(),
    publicKey: String(input.publicKey || '').trim(),
    shortId: String(input.shortId || '').trim(),
    fingerprint: String(input.fingerprint || '').trim() || 'chrome',
    spiderX: String(input.spiderX || '').trim() || '/',
    flow: String(input.flow || '').trim() || 'xtls-rprx-vision',
    remarks: String(input.remarks || '').trim(),
    mode: normalizeMode(input.mode),
    isFavorite: Boolean(input.isFavorite),
    lastUsedAt: input.lastUsedAt || null,
    lastConnectionResult: input.lastConnectionResult || null,
    createdAt: input.createdAt || nowIso(),
    updatedAt: nowIso(),
  });

  const validation = validateProfile(next);
  if (!validation.valid) {
    throw new Error(validation.errors[0]);
  }

  return next;
}

export function duplicateProfile(profile: LocalProfile): LocalProfile {
  return createEmptyProfile({
    ...profile,
    id: generateUuid(),
    name: `${profile.name} Copy`.trim(),
    isFavorite: false,
    lastUsedAt: null,
    lastConnectionResult: null,
  });
}

export function touchProfileUsage(profile: LocalProfile, result: string): LocalProfile {
  return createEmptyProfile({
    ...profile,
    lastUsedAt: nowIso(),
    lastConnectionResult: result,
    updatedAt: nowIso(),
  });
}

export function sortProfiles(profiles: LocalProfile[]): LocalProfile[] {
  return [...profiles].sort((left, right) => {
    if (left.isFavorite !== right.isFavorite) {
      return left.isFavorite ? -1 : 1;
    }

    const leftLastUsed = left.lastUsedAt ? Date.parse(left.lastUsedAt) : 0;
    const rightLastUsed = right.lastUsedAt ? Date.parse(right.lastUsedAt) : 0;
    if (leftLastUsed !== rightLastUsed) {
      return rightLastUsed - leftLastUsed;
    }

    const leftUpdated = left.updatedAt ? Date.parse(left.updatedAt) : 0;
    const rightUpdated = right.updatedAt ? Date.parse(right.updatedAt) : 0;
    if (leftUpdated !== rightUpdated) {
      return rightUpdated - leftUpdated;
    }

    return left.name.localeCompare(right.name);
  });
}

export function createShareLink(profile: LocalProfile): string {
  const normalized = normalizeProfile(profile);
  const pairs = [
    ['type', 'tcp'],
    ['security', 'reality'],
    ['pbk', normalized.publicKey],
    ['sid', normalized.shortId],
    ['fp', normalized.fingerprint],
    ['sni', normalized.serverName],
    ['spx', normalized.spiderX],
  ];

  if (normalized.flow) {
    pairs.push(['flow', normalized.flow]);
  }

  const query = pairs
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  return `vless://${normalized.uuid}@${normalized.host}:${normalized.port}?${query}#${encodeURIComponent(normalized.name)}`;
}

export function createProfileSummary(profile: LocalProfile): string {
  const normalized = normalizeProfile(profile);
  return [
    `Name: ${normalized.name}`,
    `Endpoint: ${normalized.host}:${normalized.port}`,
    `Mode: ${normalized.mode === 'vpn' ? 'VPN' : 'Proxy'}`,
    `Server Name: ${normalized.serverName}`,
    `Public Key: ${normalized.publicKey}`,
    `Short ID: ${normalized.shortId}`,
    `Fingerprint: ${normalized.fingerprint}`,
    normalized.flow ? `Flow: ${normalized.flow}` : null,
    normalized.remarks ? `Remarks: ${normalized.remarks}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function parseVlessUri(input: string): LocalProfile {
  const trimmed = input.trim();
  if (!trimmed.toLowerCase().startsWith('vless://')) {
    throw new Error('Import supports VLESS URIs only.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('The VLESS URI is invalid.');
  }

  const security = parsed.searchParams.get('security');
  if (security && security.toLowerCase() !== 'reality') {
    throw new Error('Only VLESS REALITY profiles are supported.');
  }

  const profile = createEmptyProfile({
    name: decodeURIComponent(parsed.hash.replace(/^#/, '') || 'Imported profile'),
    host: parsed.hostname,
    port: parsed.port || '443',
    uuid: decodeURIComponent(parsed.username || '').trim(),
    serverName: parsed.searchParams.get('sni') || parsed.searchParams.get('serverName') || '',
    publicKey: parsed.searchParams.get('pbk') || parsed.searchParams.get('publicKey') || '',
    shortId: parsed.searchParams.get('sid') || parsed.searchParams.get('shortId') || '',
    fingerprint: parsed.searchParams.get('fp') || 'chrome',
    spiderX: parsed.searchParams.get('spx') || '/',
    flow: parsed.searchParams.get('flow') || 'xtls-rprx-vision',
    remarks: 'Imported from VLESS URI',
    mode: 'vpn',
  });

  return normalizeProfile(profile);
}

function parseJsonProfile(input: string): LocalProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Import text is neither valid VLESS URI nor JSON.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Imported JSON must describe a profile object.');
  }

  const maybeProfile = (parsed as { profile?: unknown }).profile;
  if (maybeProfile && typeof maybeProfile === 'object') {
    return normalizeProfile(maybeProfile as Partial<LocalProfile>);
  }

  const maybeOutbounds = (parsed as { outbounds?: unknown }).outbounds;
  if (Array.isArray(maybeOutbounds)) {
    const outbound = maybeOutbounds.find((entry) => entry && typeof entry === 'object' && (entry as { protocol?: string }).protocol === 'vless');
    if (!outbound || typeof outbound !== 'object') {
      throw new Error('No VLESS outbound was found in the imported JSON.');
    }

    const vnext = Array.isArray((outbound as { settings?: { vnext?: unknown[] } }).settings?.vnext)
      ? (outbound as { settings?: { vnext?: Array<Record<string, unknown>> } }).settings?.vnext?.[0]
      : null;
    const user = Array.isArray(vnext?.users) ? (vnext?.users?.[0] as Record<string, unknown> | undefined) : undefined;
    const realitySettings = ((outbound as { streamSettings?: { realitySettings?: Record<string, unknown> } }).streamSettings?.realitySettings || {}) as Record<string, unknown>;

    return normalizeProfile({
      name: String((parsed as { remarks?: unknown }).remarks || 'Imported profile').trim(),
      host: String(vnext?.address || '').trim(),
      port: String(vnext?.port || '').trim(),
      uuid: String(user?.id || '').trim(),
      serverName: String(realitySettings.serverName || '').trim(),
      publicKey: String(realitySettings.publicKey || '').trim(),
      shortId: String(realitySettings.shortId || '').trim(),
      fingerprint: String(realitySettings.fingerprint || 'chrome').trim() || 'chrome',
      spiderX: String(realitySettings.spiderX || '/').trim() || '/',
      flow: String(user?.flow || 'xtls-rprx-vision').trim() || 'xtls-rprx-vision',
      remarks: 'Imported from Xray JSON',
      mode: 'vpn',
    });
  }

  return normalizeProfile(parsed as Partial<LocalProfile>);
}

export function parseProfileImport(input: string): LocalProfile {
  const trimmed = String(input || '').trim();
  if (!trimmed) {
    throw new Error('Paste a VLESS URI or JSON profile first.');
  }

  if (trimmed.toLowerCase().startsWith('vless://')) {
    return parseVlessUri(trimmed);
  }

  return parseJsonProfile(trimmed);
}

export function buildTunnelConfig(profile: LocalProfile, stealthMode = false): Record<string, unknown> {
  const normalized = normalizeProfile(profile);

  return {
    log: {
      loglevel: 'warning',
    },
    dns: {
      servers: ['1.1.1.1', '8.8.8.8', 'localhost'],
    },
    inbounds: [
      {
        tag: 'socks-in',
        listen: '127.0.0.1',
        port: 10808,
        protocol: 'socks',
        settings: {
          auth: 'noauth',
          udp: true,
        },
        sniffing: {
          enabled: true,
          destOverride: ['http', 'tls', 'quic'],
        },
      },
    ],
    outbounds: [
      {
        tag: 'proxy',
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: normalized.host,
              port: Number(normalized.port),
              users: [
                {
                  id: normalized.uuid,
                  encryption: 'none',
                  flow: normalized.flow,
                },
              ],
            },
          ],
        },
        streamSettings: {
          network: 'tcp',
          security: 'reality',
          sockopt: stealthMode
            ? {
                tcpNoDelay: true,
              }
            : undefined,
          realitySettings: {
            show: false,
            serverName: normalized.serverName,
            fingerprint: normalized.fingerprint,
            publicKey: normalized.publicKey,
            shortId: normalized.shortId,
            spiderX: normalized.spiderX,
          },
        },
        mux: {
          enabled: false,
          concurrency: -1,
        },
      },
      {
        tag: 'direct',
        protocol: 'freedom',
      },
      {
        tag: 'block',
        protocol: 'blackhole',
      },
    ],
    routing: {
      domainStrategy: stealthMode ? 'IPOnDemand' : 'IPIfNonMatch',
      rules: [
        {
          type: 'field',
          inboundTag: ['socks-in'],
          outboundTag: 'proxy',
        },
      ],
    },
    policy: stealthMode
      ? {
          levels: {
            0: {
              handshake: 4,
              connIdle: 300,
              uplinkOnly: 1,
              downlinkOnly: 1,
            },
          },
        }
      : undefined,
  };
}

export function profileEndpoint(profile: LocalProfile): string {
  return `${profile.host}:${profile.port}`;
}

export function bootstrapDraftToProfile(draft: Partial<BootstrapDraft & LocalProfile>): LocalProfile {
  return createEmptyProfile({
    name: String(draft.profileName || draft.name || '').trim() || 'My VPS',
    host: String(draft.publicHost || draft.host || '').trim(),
    port: String(draft.publicPort || draft.port || '8443').trim(),
    uuid: String(draft.uuid || generateUuid()).trim(),
    serverName: String(draft.serverName || '').trim() || 'www.google.com',
    publicKey: String(draft.publicKey || '').trim(),
    shortId: String(draft.shortId || '').trim(),
    fingerprint: String(draft.fingerprint || 'chrome').trim() || 'chrome',
    spiderX: String(draft.spiderX || '/').trim() || '/',
    flow: String(draft.flow || 'xtls-rprx-vision').trim() || 'xtls-rprx-vision',
    remarks: String(draft.remarks || '').trim(),
    mode: normalizeMode(draft.mode),
    isFavorite: Boolean((draft as Partial<LocalProfile>).isFavorite),
    lastUsedAt: (draft as Partial<LocalProfile>).lastUsedAt || null,
    lastConnectionResult: (draft as Partial<LocalProfile>).lastConnectionResult || null,
  });
}
