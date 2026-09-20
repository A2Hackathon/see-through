const localState = {
  spaces: [],
  space_id: null,
  alert: '',
  gps: null,
};

jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3 },
  getCurrentPositionAsync: jest.fn(),
  reverseGeocodeAsync: jest.fn(),
}));

jest.mock('../utils/safeSpacesLocal', () => ({
  loadLocalSpaces: jest.fn(async () => localState),
  applyLocalGps: jest.fn(async (lat, lng, accuracy) => {
    localState.gps = {
      lat,
      lng,
      accuracy,
      timestamp: new Date().toISOString(),
      nearest_name: localState.spaces[0]?.name || null,
      distance_m: localState.spaces.length ? 500 : null,
      space_id: null,
      skipped: null,
    };
    localState.space_id = null;
    return localState;
  }),
  makeLocalSpace: jest.fn((name, address, coords) => ({
    id: 'new-space',
    name,
    address,
    ...coords,
  })),
  saveLocalSpaces: jest.fn(async (next) => {
    Object.assign(localState, next);
    return localState;
  }),
}));

jest.mock('../utils/liveGps', () => ({
  getLiveGpsEnabled: jest.fn(async () => false),
  requestLiveGpsPermission: jest.fn(async () => true),
  setLiveGpsEnabled: jest.fn(async () => {}),
}));

jest.mock('../utils/addressSearch', () => ({
  searchAddresses: jest.fn(async () => []),
}));

jest.mock('../utils/snowflake', () => ({
  addSafeSpace: jest.fn(async () => localState),
  removeSafeSpace: jest.fn(async () => localState),
}));

jest.mock('../utils/notifications', () => ({
  buildGlassesNotificationContent: jest.fn(() => null),
}));

import { createAppActionRegistry } from '../utils/appActions';
import { searchAddresses } from '../utils/addressSearch';
import { addSafeSpace } from '../utils/snowflake';
import * as Location from 'expo-location';

function makeRegistry(initialProfiles = []) {
  let profiles = initialProfiles;
  const registry = createAppActionRegistry({
    getProfiles: () => profiles,
    saveProfiles: jest.fn(async (next) => {
      profiles = next;
    }),
    navigate: jest.fn(),
    getCurrentScreen: () => 'home',
    getLatestScene: () => null,
    getLastAlert: () => '',
    getLastResponse: () => '',
  });
  return { registry, getProfiles: () => profiles };
}

describe('app voice action registry', () => {
  beforeEach(() => {
    localState.spaces = [];
    localState.space_id = null;
    localState.gps = null;
    global.fetch = jest.fn(async () => ({ ok: true }));
    jest.clearAllMocks();
  });

  test('lists and counts saved profiles', async () => {
    const { registry } = makeRegistry([
      { id: 1, name: 'Maya', relationship: 'sister' },
      { id: 2, name: 'John', relationship: 'friend' },
    ]);
    await expect(registry.execute('count_profiles')).resolves.toMatchObject({
      message: '2 profiles are saved.',
    });
    await expect(registry.execute('list_profiles')).resolves.toMatchObject({
      message: expect.stringContaining('Maya, your sister'),
    });
  });

  test('requires local confirmation before deleting a profile', async () => {
    const { registry, getProfiles } = makeRegistry([
      { id: 7, name: 'John Smith', relationship: 'friend' },
    ]);
    const pending = await registry.execute('delete_profile', { name: 'John' });
    expect(pending.requiresConfirmation).toBe(true);
    expect(getProfiles()).toHaveLength(1);

    await registry.execute(pending.pendingTool.name, pending.pendingTool.args, {
      confirmed: true,
    });
    expect(getProfiles()).toHaveLength(0);
  });

  test('does not claim a stale GPS location', async () => {
    Location.getCurrentPositionAsync.mockRejectedValueOnce(new Error('unavailable'));
    localState.gps = {
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      space_id: 'home',
    };
    localState.space_id = 'home';
    localState.spaces = [{ id: 'home', name: 'Home', address: '1 Main St' }];
    const { registry } = makeRegistry();
    const result = await registry.execute('get_current_place');
    expect(result.message).toMatch(/stale/i);
  });

  test('reports current address and safe-space status from a fresh GPS fix', async () => {
    localState.spaces = [{ id: 'home', name: 'Home', address: '1 Main St' }];
    Location.getCurrentPositionAsync.mockResolvedValueOnce({
      coords: { latitude: 39.3, longitude: -76.6, accuracy: 12 },
    });
    Location.reverseGeocodeAsync.mockResolvedValueOnce([
      { streetNumber: '10', street: 'Charles Street', city: 'Baltimore' },
    ]);
    const { registry } = makeRegistry();
    const result = await registry.execute('get_current_place');
    expect(result.message).toMatch(/outside your safe places/i);
    expect(result.message).toMatch(/10, Charles Street, Baltimore/i);
    expect(result.message).toMatch(/500 meters from Home/i);
  });

  test('resolves a spoken address before asking for confirmation', async () => {
    searchAddresses.mockResolvedValueOnce([
      {
        id: '1',
        title: 'Library',
        address: '10 Library Road',
        lat: 39.3,
        lng: -76.6,
      },
    ]);
    const { registry } = makeRegistry();
    const result = await registry.execute('add_safe_space_by_address', {
      name: 'Library',
      address: '10 Library Road',
    });
    expect(result.requiresConfirmation).toBe(true);
    expect(result.pendingTool.args).toMatchObject({
      name: 'Library',
      lat: 39.3,
      lng: -76.6,
    });
  });

  test('keeps a confirmed safe space locally when bridge sync is offline', async () => {
    addSafeSpace.mockRejectedValueOnce(new Error('offline'));
    const { registry } = makeRegistry();
    const result = await registry.execute(
      'add_safe_space_by_address',
      {
        name: 'Library',
        address: '10 Library Road',
        lat: 39.3,
        lng: -76.6,
        radius_m: 120,
      },
      { confirmed: true }
    );
    expect(result.message).toMatch(/saved/i);
    expect(localState.spaces).toHaveLength(1);
    expect(localState.spaces[0].name).toBe('Library');
  });

  test('asks for a full profile name when a lookup is ambiguous', async () => {
    const { registry } = makeRegistry([
      { id: 1, name: 'John Smith', relationship: 'friend' },
      { id: 2, name: 'John Doe', relationship: 'neighbor' },
    ]);
    const result = await registry.execute('get_profile', { name: 'John' });
    expect(result.message).toMatch(/more than one/i);
  });

  test('refuses unavailable tool names', async () => {
    const { registry } = makeRegistry();
    await expect(registry.execute('run_arbitrary_code')).resolves.toEqual({
      message: 'That action is not available.',
    });
  });
});
