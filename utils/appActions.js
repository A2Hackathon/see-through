import * as Location from 'expo-location';
import { FACE_SERVER_URL } from './config';
import { searchAddresses } from './addressSearch';
import {
  applyLocalGps,
  loadLocalSpaces,
  makeLocalSpace,
  saveLocalSpaces,
} from './safeSpacesLocal';
import {
  getLiveGpsEnabled,
  requestLiveGpsPermission,
  setLiveGpsEnabled,
} from './liveGps';
import { addSafeSpace, removeSafeSpace } from './snowflake';
import { buildGlassesNotificationContent } from './notifications';

function normalized(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
}

function findNamed(items, requestedName) {
  const query = normalized(requestedName);
  if (!query) return { item: null, ambiguous: [] };
  const exact = items.filter((item) => normalized(item.name) === query);
  if (exact.length === 1) return { item: exact[0], ambiguous: [] };
  const partial = items.filter((item) => normalized(item.name).includes(query));
  if (partial.length === 1) return { item: partial[0], ambiguous: [] };
  return { item: null, ambiguous: exact.length ? exact : partial };
}

function spokenProfile(profile) {
  return profile.relationship
    ? `${profile.name}, your ${profile.relationship}`
    : profile.name;
}

function formatReverseAddress(place, lat, lng) {
  if (!place) return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  return [
    place.name,
    place.streetNumber,
    place.street,
    place.city,
    place.region,
    place.postalCode,
    place.country,
  ]
    .filter(Boolean)
    .join(', ');
}

async function syncAddedSpace(localPayload, name, address, coords) {
  try {
    const remote = await addSafeSpace(name, address, coords);
    await saveLocalSpaces(remote);
    return remote;
  } catch (error) {
    console.warn('Voice safe-space sync deferred', error.message);
    return localPayload;
  }
}

async function syncRemovedSpace(localPayload, spaceId) {
  try {
    const remote = await removeSafeSpace(spaceId);
    await saveLocalSpaces(remote);
    return remote;
  } catch (error) {
    console.warn('Voice safe-space removal sync deferred', error.message);
    return localPayload;
  }
}

export function createAppActionRegistry({
  getProfiles,
  saveProfiles,
  navigate,
  getCurrentScreen,
  getLatestScene,
  getLastAlert,
  getLastResponse,
}) {
  async function execute(toolName, args = {}, options = {}) {
    const confirmed = Boolean(options.confirmed);

    switch (toolName) {
      case 'open_section': {
        const section = normalized(args.section);
        if (!['home', 'profiles', 'places', 'info'].includes(section)) {
          return { message: 'I can open Home, Profiles, My Places, or Info.' };
        }
        navigate(section);
        return { message: `Opened ${section === 'places' ? 'My Places' : section}.` };
      }
      case 'close_section':
        navigate('home');
        return { message: 'Back on the home screen.' };
      case 'describe_current_screen': {
        const screen = getCurrentScreen();
        const descriptions = {
          home: 'You are on the home screen. You can ask about profiles, saved places, GPS, or the latest scene.',
          profiles: 'You are viewing saved profiles. You can ask me to list or check a profile.',
          places: 'You are viewing My Places. You can add, list, or remove a safe space and control live GPS.',
          info: 'You are viewing information about how See Through works.',
        };
        return { message: descriptions[screen] || descriptions.home };
      }
      case 'help':
        return {
          message:
            'You can ask me which profiles are saved, manage safe spaces, turn live GPS on or off, open app sections, or read the latest scene. Say stop at any time.',
        };
      case 'stop_speaking':
        return { message: '', stopSpeaking: true };
      case 'repeat_last': {
        const last = getLastResponse();
        return { message: last || 'There is nothing to repeat yet.' };
      }
      case 'count_profiles': {
        const count = getProfiles().length;
        return { message: `${count} ${count === 1 ? 'profile is' : 'profiles are'} saved.` };
      }
      case 'list_profiles': {
        const profiles = getProfiles();
        if (!profiles.length) return { message: 'No profiles are saved.' };
        return {
          message: `Saved profiles are ${profiles.map(spokenProfile).join('; ')}.`,
        };
      }
      case 'get_profile': {
        const profiles = getProfiles();
        const match = findNamed(profiles, args.name);
        if (match.ambiguous.length) {
          return {
            message: `I found more than one possible match: ${match.ambiguous
              .map((profile) => profile.name)
              .join(', ')}. Please say the full name.`,
          };
        }
        if (!match.item) return { message: `I could not find a saved profile named ${args.name}.` };
        return { message: `${spokenProfile(match.item)} is saved.` };
      }
      case 'delete_profile': {
        const profiles = getProfiles();
        const match = findNamed(profiles, args.name);
        if (match.ambiguous.length) {
          return {
            message: `Which profile do you mean: ${match.ambiguous
              .map((profile) => profile.name)
              .join(', ')}?`,
          };
        }
        if (!match.item) return { message: `I could not find ${args.name}.` };
        if (!confirmed) {
          return {
            requiresConfirmation: true,
            confirmationText: `Delete the profile for ${match.item.name}?`,
            pendingTool: { name: toolName, args: { name: match.item.name } },
          };
        }
        try {
          await fetch(`${FACE_SERVER_URL}/people/${match.item.id}`, { method: 'DELETE' });
        } catch (error) {
          console.warn('Profile backend deletion deferred', error.message);
        }
        await saveProfiles(profiles.filter((profile) => profile.id !== match.item.id));
        return { message: `${match.item.name}'s profile was deleted.` };
      }
      case 'list_safe_spaces': {
        const state = await loadLocalSpaces();
        if (!state.spaces.length) return { message: 'No safe spaces are saved.' };
        return {
          message: `Saved places are ${state.spaces
            .map((space) => `${space.name}, ${space.address}`)
            .join('; ')}.`,
        };
      }
      case 'get_current_place': {
        const granted = await requestLiveGpsPermission();
        if (!granted) {
          return { message: 'Location permission is required to tell you where you are.' };
        }

        let state;
        let currentAddress = '';
        try {
          const position = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          const { latitude, longitude, accuracy } = position.coords;
          state = await applyLocalGps(latitude, longitude, accuracy);
          const reverse = await Location.reverseGeocodeAsync({ latitude, longitude });
          currentAddress = formatReverseAddress(reverse?.[0], latitude, longitude);
        } catch (error) {
          console.warn('Fresh location lookup failed', error.message);
          state = await loadLocalSpaces();
        }

        if (!state.gps) return { message: 'I do not have a recent GPS location.' };
        const gpsAge = state.gps.timestamp
          ? Date.now() - Date.parse(state.gps.timestamp)
          : Number.POSITIVE_INFINITY;
        if (gpsAge > 2 * 60 * 1000) {
          return { message: 'The saved GPS location is stale. Turn on live GPS and try again.' };
        }
        if (state.gps.skipped === 'accuracy') {
          return { message: 'The current GPS signal is too weak to trust.' };
        }
        const current = state.spaces.find((space) => space.id === state.space_id);
        if (current) {
          return {
            message: currentAddress
              ? `You are at the safe place ${current.name}, near ${currentAddress}.`
              : `You are at the safe place ${current.name}.`,
          };
        }
        if (state.gps.nearest_name && state.gps.distance_m != null) {
          return {
            message: `You are outside your safe places.${
              currentAddress ? ` Your current location is near ${currentAddress}.` : ''
            } You are about ${Math.round(state.gps.distance_m)} meters from ${
              state.gps.nearest_name
            }.`,
          };
        }
        return {
          message: `You are outside your safe places.${
            currentAddress ? ` Your current location is near ${currentAddress}.` : ''
          }`,
        };
      }
      case 'add_safe_space_here': {
        if (!confirmed) {
          const granted = await requestLiveGpsPermission();
          if (!granted) return { message: 'Location permission is required to save this place.' };
          const position = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          const { latitude: lat, longitude: lng, accuracy } = position.coords;
          if (accuracy != null && accuracy > 250) {
            return { message: 'The GPS signal is too weak to save this place safely.' };
          }
          const reverse = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
          const address = formatReverseAddress(reverse?.[0], lat, lng);
          const current = await loadLocalSpaces();
          const existing = current.spaces.find(
            (space) => normalized(space.name) === normalized(args.name)
          );
          return {
            requiresConfirmation: true,
            confirmationText: existing
              ? `Replace the existing safe space ${existing.name} with your current location at ${address}?`
              : `Save ${args.name} at ${address} as a safe space?`,
            pendingTool: {
              name: toolName,
              args: {
                name: args.name,
                address,
                lat,
                lng,
                radius_m: 120,
                replace_id: existing?.id || null,
              },
            },
          };
        }
        const current = await loadLocalSpaces();
        const localSpace = makeLocalSpace(args.name, args.address, args);
        const localPayload = await saveLocalSpaces({
          ...current,
          spaces: [
            ...current.spaces.filter((space) => space.id !== args.replace_id),
            localSpace,
          ],
        });
        if (args.replace_id) {
          try {
            await removeSafeSpace(args.replace_id);
          } catch (error) {
            console.warn('Voice safe-space replacement removal deferred', error.message);
          }
        }
        await syncAddedSpace(localPayload, args.name, args.address, args);
        return { message: `${args.name} was saved as a safe space.` };
      }
      case 'add_safe_space_by_address': {
        if (!confirmed) {
          const candidates = await searchAddresses(args.address);
          if (!candidates.length) {
            return { message: `I could not map the address ${args.address}. Please be more specific.` };
          }
          const selected = candidates[0];
          const current = await loadLocalSpaces();
          const existing = current.spaces.find(
            (space) => normalized(space.name) === normalized(args.name)
          );
          const toPending = (place) => ({
            confirmationText: existing
              ? `Replace the existing safe space ${existing.name} with ${place.address}?`
              : `Use ${place.address} for ${args.name}?`,
            pendingTool: {
              name: toolName,
              args: {
                name: args.name,
                address: place.address,
                lat: place.lat,
                lng: place.lng,
                radius_m: 120,
                replace_id: existing?.id || null,
              },
            },
          });
          const first = toPending(selected);
          return {
            requiresConfirmation: true,
            ...first,
            alternatives: candidates.slice(1, 4).map(toPending),
          };
        }
        const current = await loadLocalSpaces();
        const localSpace = makeLocalSpace(args.name, args.address, args);
        const localPayload = await saveLocalSpaces({
          ...current,
          spaces: [
            ...current.spaces.filter((space) => space.id !== args.replace_id),
            localSpace,
          ],
        });
        if (args.replace_id) {
          try {
            await removeSafeSpace(args.replace_id);
          } catch (error) {
            console.warn('Voice safe-space replacement removal deferred', error.message);
          }
        }
        await syncAddedSpace(localPayload, args.name, args.address, args);
        return { message: `${args.name} was saved as a safe space.` };
      }
      case 'remove_safe_space': {
        const state = await loadLocalSpaces();
        const match = findNamed(state.spaces, args.name);
        if (match.ambiguous.length) {
          return {
            message: `Which saved place do you mean: ${match.ambiguous
              .map((space) => space.name)
              .join(', ')}?`,
          };
        }
        if (!match.item) return { message: `I could not find a saved place named ${args.name}.` };
        if (!confirmed) {
          return {
            requiresConfirmation: true,
            confirmationText: `Remove ${match.item.name} from your safe spaces?`,
            pendingTool: { name: toolName, args: { name: match.item.name } },
          };
        }
        const localPayload = await saveLocalSpaces({
          ...state,
          spaces: state.spaces.filter((space) => space.id !== match.item.id),
          space_id: state.space_id === match.item.id ? null : state.space_id,
        });
        await syncRemovedSpace(localPayload, match.item.id);
        return { message: `${match.item.name} was removed from your safe spaces.` };
      }
      case 'set_live_gps': {
        const enabled = Boolean(args.enabled);
        const current = await getLiveGpsEnabled();
        if (!enabled && current && !confirmed) {
          return {
            requiresConfirmation: true,
            confirmationText: 'Turn off live GPS safety alerts?',
            pendingTool: { name: toolName, args: { enabled: false } },
          };
        }
        if (enabled) {
          const granted = await requestLiveGpsPermission();
          if (!granted) return { message: 'Location permission was not granted.' };
        }
        await setLiveGpsEnabled(enabled);
        return { message: `Live GPS is now ${enabled ? 'on' : 'off'}.` };
      }
      case 'read_latest_scene': {
        const scene = getLatestScene();
        if (!scene?.timestamp) return { message: 'No scene result is available yet.' };
        const content = buildGlassesNotificationContent(scene);
        return { message: content?.body || 'Nothing important was detected in the latest scene.' };
      }
      case 'repeat_last_alert': {
        const last = getLastAlert();
        return { message: last || 'There is no previous alert to repeat.' };
      }
      case 'recognition_status': {
        const scene = getLatestScene();
        if (!scene?.timestamp) return { message: 'The glasses have not sent a result yet.' };
        const ageSeconds = Math.max(0, (Date.now() - Date.parse(scene.timestamp)) / 1000);
        return {
          message:
            ageSeconds < 20
              ? 'The glasses recognition feed is active.'
              : `The last glasses result was ${Math.round(ageSeconds)} seconds ago.`,
        };
      }
      default:
        return { message: 'That action is not available.' };
    }
  }

  async function getContext() {
    const places = await loadLocalSpaces();
    return {
      current_screen: getCurrentScreen(),
      profiles: getProfiles().map(({ name, relationship }) => ({ name, relationship })),
      safe_spaces: places.spaces.map(({ name, address }) => ({ name, address })),
      current_space_id: places.space_id,
      gps_enabled: await getLiveGpsEnabled(),
      gps: places.gps
        ? {
            accuracy: places.gps.accuracy,
            nearest_name: places.gps.nearest_name,
            distance_m: places.gps.distance_m,
            space_id: places.gps.space_id,
            skipped: places.gps.skipped,
            timestamp: places.gps.timestamp,
          }
        : null,
      latest_scene_timestamp: getLatestScene()?.timestamp || null,
    };
  }

  return { execute, getContext };
}
