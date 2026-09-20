import AsyncStorage from '@react-native-async-storage/async-storage';

const SPACES_KEY = '@safe_spaces';
const DEFAULT_RADIUS_M = 120;
const LEAVE_RADIUS_M = 180;
const MAX_GPS_ACCURACY_M = 250;

const listeners = new Set();

function newId() {
  return `space_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function emitSpaces(payload) {
  listeners.forEach((listener) => listener(payload));
}

export function subscribeLocalSpaces(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function loadLocalSpaces() {
  try {
    const raw = await AsyncStorage.getItem(SPACES_KEY);
    if (!raw) return { spaces: [], space_id: null, alert: '', gps: null };
    const parsed = JSON.parse(raw);
    return {
      spaces: Array.isArray(parsed.spaces) ? parsed.spaces : [],
      space_id: parsed.space_id || null,
      alert: parsed.alert || '',
      gps: parsed.gps || null,
    };
  } catch (error) {
    console.warn('Could not load local safe spaces', error);
    return { spaces: [], space_id: null, alert: '', gps: null };
  }
}

export async function saveLocalSpaces({ spaces, space_id, alert, gps }) {
  const current = gps === undefined ? await loadLocalSpaces() : null;
  const payload = {
    spaces: Array.isArray(spaces) ? spaces : [],
    space_id: space_id || null,
    alert: alert || '',
    gps: gps === undefined ? current?.gps || null : gps,
  };
  try {
    await AsyncStorage.setItem(SPACES_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn('Could not save local safe spaces', error);
  }
  emitSpaces(payload);
  return payload;
}

export async function applyLocalGps(lat, lng, accuracy) {
  const current = await loadLocalSpaces();
  const gps = {
    lat,
    lng,
    accuracy,
    timestamp: new Date().toISOString(),
    distance_m: null,
    nearest_name: null,
    space_id: null,
    skipped: null,
  };
  const geocoded = current.spaces.filter(
    (space) => space.lat != null && space.lng != null
  );
  if (!geocoded.length) {
    gps.skipped = 'no_geocoded_spaces';
    return saveLocalSpaces({ ...current, gps });
  }
  if (accuracy != null && accuracy > MAX_GPS_ACCURACY_M) {
    gps.skipped = 'accuracy';
    return saveLocalSpaces({ ...current, gps });
  }

  let nearest = null;
  let nearestDist = null;
  let matched = null;
  let matchedDist = null;
  for (const space of geocoded) {
    const dist = haversineM(lat, lng, space.lat, space.lng);
    if (nearestDist == null || dist < nearestDist) {
      nearest = space;
      nearestDist = dist;
    }
    let radius = Number(space.radius_m) || DEFAULT_RADIUS_M;
    if (current.space_id === space.id) {
      radius = Math.max(radius, LEAVE_RADIUS_M);
    }
    if (dist <= radius && (matchedDist == null || dist < matchedDist)) {
      matched = space;
      matchedDist = dist;
    }
  }

  gps.nearest_name = nearest?.name || null;
  gps.distance_m = nearestDist != null ? Math.round(nearestDist * 10) / 10 : null;
  gps.space_id = matched?.id || null;
  return saveLocalSpaces({
    ...current,
    space_id: matched?.id || null,
    gps,
  });
}

export function makeLocalSpace(name, address, coords = {}) {
  return {
    id: newId(),
    name,
    address,
    lat: coords.lat ?? null,
    lng: coords.lng ?? null,
    radius_m: coords.radius_m ?? DEFAULT_RADIUS_M,
  };
}
