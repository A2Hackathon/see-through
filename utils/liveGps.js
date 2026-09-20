import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { applyGpsLocation } from './snowflake';
import { applyLocalGps } from './safeSpacesLocal';
import {
  notifyLeftSafeZones,
  notifyUnusualActivity,
} from './notifications';
import { speakText } from './speech';

const LIVE_GPS_KEY = '@live_gps';

let awayAlertSent = false;
let lastUnusualReminder = null;

async function maybeNotifyLeftSafeZones(state) {
  const mapped = (state.spaces || []).some(
    (space) => space.lat != null && space.lng != null
  );
  if (state.gps?.skipped || !mapped) return;
  if (state.space_id) {
    awayAlertSent = false;
    return;
  }
  if (awayAlertSent) return;
  awayAlertSent = true;
  try {
    const notification = await notifyLeftSafeZones();
    if (notification?.body) {
      await speakText(notification.body);
    }
  } catch (error) {
    awayAlertSent = false;
    console.warn('Safe zone notification skipped', error.message);
  }
}

async function maybeNotifyUnusualActivity(state) {
  if (state?.space_id) {
    lastUnusualReminder = null;
    return;
  }
  const reminder = String(state?.alert || '').trim();
  if (!reminder || reminder === lastUnusualReminder) return;
  lastUnusualReminder = reminder;
  try {
    const notification = await notifyUnusualActivity(reminder);
    if (notification?.body) {
      await speakText(notification.body);
    }
  } catch (error) {
    lastUnusualReminder = null;
    console.warn('Routine reminder skipped', error.message);
  }
}

const listeners = new Set();

function emitLiveGps(enabled) {
  listeners.forEach((listener) => listener(enabled));
}

export async function getLiveGpsEnabled() {
  try {
    return (await AsyncStorage.getItem(LIVE_GPS_KEY)) === '1';
  } catch (error) {
    console.warn('Could not read live GPS setting', error);
    return false;
  }
}

export async function setLiveGpsEnabled(enabled) {
  try {
    await AsyncStorage.setItem(LIVE_GPS_KEY, enabled ? '1' : '0');
  } catch (error) {
    console.warn('Could not save live GPS setting', error);
  }
  emitLiveGps(Boolean(enabled));
}

export function subscribeLiveGps(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function geocodeAddress(address, timeoutMs = 4000) {
  try {
    const results = await Promise.race([
      Location.geocodeAsync(address),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('geocode timeout')), timeoutMs)
      ),
    ]);
    const first = results?.[0];
    if (!first || first.latitude == null || first.longitude == null) {
      return null;
    }
    return { lat: first.latitude, lng: first.longitude };
  } catch (error) {
    console.warn('Geocode skipped', error.message);
    return null;
  }
}

export async function requestLiveGpsPermission() {
  const current = await Location.getForegroundPermissionsAsync();
  if (current.status === 'granted') return true;
  const next = await Location.requestForegroundPermissionsAsync();
  return next.status === 'granted';
}

export function useLiveGps() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    getLiveGpsEnabled().then((value) => {
      if (active) setEnabled(value);
    });
    const unsubscribe = subscribeLiveGps((value) => {
      if (active) setEnabled(value);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let subscription = null;
    let cancelled = false;

    (async () => {
      const granted = await requestLiveGpsPermission();
      if (!granted || cancelled) {
        if (!granted) await setLiveGpsEnabled(false);
        return;
      }
      subscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 15000,
          distanceInterval: 20,
        },
        async (position) => {
          try {
            const next = await applyLocalGps(
              position.coords.latitude,
              position.coords.longitude,
              position.coords.accuracy
            );
            await maybeNotifyLeftSafeZones(next);
            const remote = await applyGpsLocation(
              position.coords.latitude,
              position.coords.longitude,
              position.coords.accuracy
            );
            await maybeNotifyUnusualActivity(remote);
          } catch (error) {
            console.warn('Live GPS update skipped', error.message);
          }
        }
      );
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [enabled]);

  return enabled;
}
