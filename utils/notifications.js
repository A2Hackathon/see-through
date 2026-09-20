import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  formatDetectionWithDistance,
  getImportantHazardDetections,
  getPersonDistance,
} from './speech';

const ALERT_CHANNEL_ID = 'see-through-alerts';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    // Banner only — voice reads the notification body.
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function configureRecognitionNotifications() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(ALERT_CHANNEL_ID, {
      name: 'See Through alerts',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 150, 250],
      sound: null,
    });
  }

  const current = await Notifications.getPermissionsAsync();
  if (current.status === 'granted') return true;

  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === 'granted';
}

/** Build the exact title/body shown in the notification (and spoken aloud). */
export function buildGlassesNotificationContent(result) {
  if (result?.status === 'retake_needed') {
    return null;
  }

  const spoken = String(result?.spoken_text || '').trim();
  if (spoken) {
    return {
      title: result?.matched ? 'Loved one recognized' : 'Obstacle detected',
      body: spoken,
    };
  }

  // Unknown / no-face: never announce that — only speak loved ones or obstacles.
  // Unmatched "person" detections are treated as obstacles.
  const detections = result?.detections || [];
  const personDistance = getPersonDistance(detections);
  const obstacles = getImportantHazardDetections(detections)
    .filter(
      (detection) =>
        !result?.matched ||
        String(detection.label).toLowerCase().trim() !== 'person'
    )
    .slice(0, 4);

  const bodyParts = [];
  if (result?.matched && result.name) {
    const relationship = result.relationship
      ? `Your ${result.relationship}, ${result.name}, was recognized`
      : `${result.name} was recognized`;
    const distance = personDistance
      ? ` about ${personDistance.toFixed(1)} meters away`
      : '';
    bodyParts.push(`${relationship}${distance}.`);
  }
  if (obstacles.length > 0) {
    bodyParts.push(
      `Obstacles: ${obstacles.map(formatDetectionWithDistance).join('; ')}.`
    );
  }

  if (bodyParts.length === 0) return null;

  return {
    title: result?.matched ? 'Loved one recognized' : 'Obstacle detected',
    body: bodyParts.join(' '),
  };
}

/**
 * Shows a notification and returns { title, body } so voice can speak
 * the same message. Returns null when there is nothing to announce.
 */
export async function notifyGlassesResult(result) {
  const content = buildGlassesNotificationContent(result);
  if (!content) return null;

  await Notifications.scheduleNotificationAsync({
    content: {
      title: content.title,
      body: content.body,
      sound: false,
      data: {
        name: result?.name || null,
        relationship: result?.relationship || null,
        score: result?.score || 0,
        spokenBody: content.body,
      },
      ...(Platform.OS === 'android' ? { channelId: ALERT_CHANNEL_ID } : null),
    },
    trigger: null,
  });

  return content;
}

export async function notifyLeftSafeZones() {
  const content = {
    title: 'Outside saved places',
    body: 'You are outside your saved places.',
  };

  await Notifications.scheduleNotificationAsync({
    content: {
      title: content.title,
      body: content.body,
      sound: false,
      data: { kind: 'left_safe_zone', spokenBody: content.body },
      ...(Platform.OS === 'android' ? { channelId: ALERT_CHANNEL_ID } : null),
    },
    trigger: null,
  });

  return content;
}

export async function notifyUnusualActivity(message) {
  const body = String(message || '').trim();
  if (!body) return null;

  const content = {
    title: 'Routine reminder',
    body,
  };

  await Notifications.scheduleNotificationAsync({
    content: {
      title: content.title,
      body: content.body,
      sound: false,
      data: { kind: 'unusual_activity', spokenBody: content.body },
      ...(Platform.OS === 'android' ? { channelId: ALERT_CHANNEL_ID } : null),
    },
    trigger: null,
  });

  return content;
}
