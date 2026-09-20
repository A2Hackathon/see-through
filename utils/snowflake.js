import { GLASSES_BRIDGE_URL } from './config';
import { saveLocalSpaces } from './safeSpacesLocal';

function fetchJson(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

export async function enrichSceneWithSnowflake(result, detections, { force = true } = {}) {
  try {
    const response = await fetchJson(`${GLASSES_BRIDGE_URL}/scene_event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matched: Boolean(result?.matched),
        name: result?.name || null,
        relationship: result?.relationship || null,
        score: result?.score || 0,
        detections: detections || [],
        force,
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.spoken_text || null;
  } catch (error) {
    console.warn('Snowflake narration skipped', error.message);
    return null;
  }
}

export async function addSafeSpace(name, address, { lat, lng, radius_m } = {}) {
  const response = await fetchJson(`${GLASSES_BRIDGE_URL}/safe_spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, address, lat, lng, radius_m }),
  });
  if (!response.ok) {
    throw new Error(`Add safe space failed: ${response.status}`);
  }
  return response.json();
}

export async function applyGpsLocation(lat, lng, accuracy) {
  const response = await fetchJson(`${GLASSES_BRIDGE_URL}/location`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng, accuracy }),
  });
  if (!response.ok) {
    throw new Error(`GPS update failed: ${response.status}`);
  }
  const payload = await response.json();
  if (payload.gps && !payload.gps.timestamp) {
    payload.gps.timestamp = new Date().toISOString();
  }
  await saveLocalSpaces(payload);
  return payload;
}

export async function removeSafeSpace(spaceId) {
  const response = await fetchJson(
    `${GLASSES_BRIDGE_URL}/safe_spaces/${encodeURIComponent(spaceId)}`,
    { method: 'DELETE' }
  );
  if (!response.ok) {
    throw new Error(`Remove safe space failed: ${response.status}`);
  }
  return response.json();
}

