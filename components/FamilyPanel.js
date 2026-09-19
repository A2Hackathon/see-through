import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import {
  addSafeSpace,
  removeSafeSpace,
} from '../utils/snowflake';
import {
  loadLocalSpaces,
  makeLocalSpace,
  saveLocalSpaces,
  subscribeLocalSpaces,
} from '../utils/safeSpacesLocal';
import {
  getLiveGpsEnabled,
  requestLiveGpsPermission,
  setLiveGpsEnabled,
} from '../utils/liveGps';
import { searchAddresses } from '../utils/addressSearch';

const COLORS = {
  ocean950: '#17150f',
  ocean300: '#746f61',
  ocean200: '#48443a',
  ocean50: '#14130f',
  sky300: '#d94638',
  mist: 'rgba(255, 255, 245, 0.58)',
  mistBorder: 'rgba(23, 21, 15, 0.15)',
  dangerBg: 'rgba(255, 73, 61, 0.12)',
  dangerBorder: 'rgba(180, 46, 38, 0.28)',
  dangerText: '#a92f27',
  pillOn: '#17150f',
  pillOnText: '#f8f1e3',
};

function regionForPins(pins) {
  if (!pins.length) {
    return {
      latitude: 39.3299,
      longitude: -76.6205,
      latitudeDelta: 0.06,
      longitudeDelta: 0.06,
    };
  }
  if (pins.length === 1) {
    return {
      latitude: pins[0].lat,
      longitude: pins[0].lng,
      latitudeDelta: 0.02,
      longitudeDelta: 0.02,
    };
  }
  const lats = pins.map((pin) => pin.lat);
  const lngs = pins.map((pin) => pin.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * 1.8, 0.02),
    longitudeDelta: Math.max((maxLng - minLng) * 1.8, 0.02),
  };
}

export default function PlacesPanel({ onClose, visible = true }) {
  const [spaces, setSpaces] = useState([]);
  const [spaceId, setSpaceId] = useState(null);
  const [alertText, setAlertText] = useState('');
  const [spaceName, setSpaceName] = useState('');
  const [spaceAddress, setSpaceAddress] = useState('');
  const [addressHits, setAddressHits] = useState([]);
  const [selectedPlace, setSelectedPlace] = useState(null);
  const [searchingAddress, setSearchingAddress] = useState(false);
  const [savingPlace, setSavingPlace] = useState(false);
  const [addingSpace, setAddingSpace] = useState(false);
  const [error, setError] = useState('');
  const [liveGps, setLiveGps] = useState(false);
  const [gpsStatus, setGpsStatus] = useState('');
  const addressTimer = useRef(null);

  const applyPlaceState = (payload) => {
    setSpaces(Array.isArray(payload.spaces) ? payload.spaces : []);
    setSpaceId(payload.space_id || null);
    if (payload.alert !== undefined) {
      setAlertText(payload.alert || '');
    }
    if (!('gps' in payload)) return;
    const gps = payload.gps;
    if (!gps) {
      setGpsStatus('');
      return;
    }
    if (gps.skipped === 'accuracy') {
      setGpsStatus('GPS signal is too weak to trust right now.');
    } else if (gps.skipped === 'no_geocoded_spaces') {
      setGpsStatus('Add an address that can be mapped before live GPS can match.');
    } else if (gps.space_id && gps.nearest_name) {
      setGpsStatus(`GPS: at ${gps.nearest_name} (${gps.distance_m}m)`);
    } else if (gps.nearest_name && gps.distance_m != null) {
      setGpsStatus(`GPS: ${gps.distance_m}m from ${gps.nearest_name}`);
    } else {
      setGpsStatus('Live GPS is on.');
    }
  };

  const loadPlaces = useCallback(async () => {
    const local = await loadLocalSpaces();
    applyPlaceState({
      spaces: local.spaces,
      space_id: local.space_id,
      alert: local.alert,
      gps: local.gps,
    });
    setError('');
  }, []);

  useEffect(() => {
    if (visible) loadPlaces();
  }, [visible, loadPlaces]);

  useEffect(() => {
    if (!visible) return undefined;
    const unsubscribe = subscribeLocalSpaces((payload) => {
      applyPlaceState(payload);
    });
    return unsubscribe;
  }, [visible]);

  useEffect(() => {
    getLiveGpsEnabled().then(setLiveGps);
  }, [visible]);

  useEffect(() => {
    return () => {
      if (addressTimer.current) clearTimeout(addressTimer.current);
    };
  }, []);

  const handleAddressChange = (text) => {
    setSpaceAddress(text);
    setSelectedPlace(null);
    setError('');
    if (addressTimer.current) clearTimeout(addressTimer.current);
    if (text.trim().length < 3) {
      setAddressHits([]);
      setSearchingAddress(false);
      return;
    }
    setSearchingAddress(true);
    addressTimer.current = setTimeout(async () => {
      const hits = await searchAddresses(text);
      setAddressHits(hits);
      setSearchingAddress(false);
    }, 350);
  };

  const handleSelectAddress = (place) => {
    setSelectedPlace(place);
    setSpaceAddress(place.address);
    setAddressHits([]);
    if (!spaceName.trim()) {
      setSpaceName(place.title);
    }
  };

  const handleAddSpace = async () => {
    if (addingSpace || !spaceName.trim()) return;
    if (!selectedPlace) {
      setError('Choose an address from the suggestions.');
      return;
    }
    setAddingSpace(true);
    setError('');
    const name = spaceName.trim();
    const address = selectedPlace.address;
    const coords = { lat: selectedPlace.lat, lng: selectedPlace.lng };
    const localSpace = makeLocalSpace(name, address, coords);
    const next = {
      spaces: [...spaces, localSpace],
      space_id: spaceId,
      alert: alertText,
    };
    applyPlaceState(next);
    await saveLocalSpaces(next);
    setSpaceName('');
    setSpaceAddress('');
    setSelectedPlace(null);
    setAddressHits([]);
    setAddingSpace(false);

    try {
      const payload = await addSafeSpace(name, address, coords);
      applyPlaceState(payload);
      await saveLocalSpaces(payload);
    } catch (err) {
      setError(
        'Saved on this phone. Cortex will see it once the glasses bridge is reachable.'
      );
      console.warn('Add safe space sync error', err);
    }
  };

  const handleRemoveSpace = async (id) => {
    if (savingPlace) return;
    setSavingPlace(true);
    setError('');
    const remaining = spaces.filter((space) => space.id !== id);
    const next = {
      spaces: remaining,
      space_id: spaceId === id ? null : spaceId,
      alert: spaceId === id ? '' : alertText,
    };
    applyPlaceState(next);
    await saveLocalSpaces(next);
    try {
      const payload = await removeSafeSpace(id);
      applyPlaceState(payload);
      await saveLocalSpaces(payload);
    } catch (err) {
      console.warn('Remove safe space error', err);
    } finally {
      setSavingPlace(false);
    }
  };

  const handleToggleGps = async () => {
    setError('');
    if (liveGps) {
      await setLiveGpsEnabled(false);
      setLiveGps(false);
      return;
    }
    const granted = await requestLiveGpsPermission();
    if (!granted) {
      setError('Location permission is required for live GPS.');
      return;
    }
    await setLiveGpsEnabled(true);
    setLiveGps(true);
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} style={styles.backButton}>
          <Text style={styles.backButtonText}>‹</Text>
        </TouchableOpacity>
        <Text style={styles.title}>My places</Text>
        <View style={styles.backButtonSpacer} />
      </View>

      <Text style={styles.label}>SAVED PLACES</Text>
          <TouchableOpacity
            onPress={handleToggleGps}
            style={[styles.awayButton, liveGps && styles.toggleOn]}
          >
            <Text style={[styles.toggleText, liveGps && styles.toggleTextOn]}>
              {liveGps ? 'Live GPS on' : 'Use live GPS'}
            </Text>
          </TouchableOpacity>
          {gpsStatus ? <Text style={styles.usualHours}>{gpsStatus}</Text> : null}
          <TextInput
            placeholder="Name, e.g. Home"
            placeholderTextColor={COLORS.ocean300}
            value={spaceName}
            onChangeText={setSpaceName}
            style={styles.input}
          />
          <TextInput
            placeholder="Search address or place"
            placeholderTextColor={COLORS.ocean300}
            value={spaceAddress}
            onChangeText={handleAddressChange}
            autoCorrect={false}
            style={styles.input}
          />
          {searchingAddress ? (
            <Text style={styles.spaceHint}>Searching maps…</Text>
          ) : null}
          {addressHits.length > 0 ? (
            <View style={styles.suggestList}>
              {addressHits.map((place) => (
                <TouchableOpacity
                  key={place.id}
                  onPress={() => handleSelectAddress(place)}
                  style={styles.suggestRow}
                >
                  <Text style={styles.suggestTitle}>{place.title}</Text>
                  <Text style={styles.suggestAddress}>{place.address}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
          {selectedPlace ? (
            <Text style={styles.spaceHint}>Selected from maps</Text>
          ) : null}
          <TouchableOpacity
            onPress={handleAddSpace}
            style={styles.askButton}
            disabled={addingSpace}
          >
            <Text style={styles.askButtonText}>
              {addingSpace ? 'Adding…' : 'Add address'}
            </Text>
          </TouchableOpacity>

          {spaces.length === 0 ? (
            <Text style={styles.empty}>
              Search a place, pick it from the list, then save. Live GPS highlights a space when you are there.
            </Text>
          ) : (
            spaces.map((space) => {
              const selected = liveGps && space.id === spaceId;
              return (
                <View
                  key={space.id}
                  style={[styles.spaceCard, selected && styles.spaceCardOn]}
                >
                  <View style={styles.spaceCopy}>
                    <Text style={[styles.spaceName, selected && styles.spaceNameOn]}>
                      {space.name}
                    </Text>
                    <Text style={[styles.spaceAddress, selected && styles.spaceAddressOn]}>
                      {space.address}
                    </Text>
                    <Text style={[styles.spaceHint, selected && styles.spaceHintOn]}>
                      {selected
                        ? 'Here now · live GPS'
                        : space.lat != null
                          ? 'Mapped for GPS'
                          : 'Address not mapped yet'}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => handleRemoveSpace(space.id)}
                    style={styles.removeButton}
                  >
                    <Text style={[styles.removeButtonText, selected && styles.removeButtonTextOn]}>
                      Remove
                    </Text>
                  </TouchableOpacity>
                </View>
              );
            })
          )}
          {Platform.OS !== 'web' &&
          spaces.some((space) => space.lat != null && space.lng != null) ? (
            <View style={styles.mapWrap}>
              <MapView
                style={styles.map}
                region={regionForPins(
                  spaces.filter((space) => space.lat != null && space.lng != null)
                )}
                scrollEnabled={false}
                rotateEnabled={false}
                pitchEnabled={false}
                zoomEnabled={false}
              >
                {spaces
                  .filter((space) => space.lat != null && space.lng != null)
                  .map((space) => (
                    <Marker
                      key={space.id}
                      coordinate={{
                        latitude: space.lat,
                        longitude: space.lng,
                      }}
                      title={space.name}
                      description={space.address}
                      pinColor={
                        liveGps && space.id === spaceId ? '#d94638' : '#17150f'
                      }
                    />
                  ))}
              </MapView>
            </View>
          ) : null}
      {alertText ? (
        <View style={styles.alertCard}>
          <Text style={styles.alertLabel}>ROUTINE REMINDER</Text>
          <Text style={styles.alertBody}>{alertText}</Text>
        </View>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 48 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  backButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255, 255, 245, 0.50)',
    borderWidth: 1,
    borderColor: 'rgba(23, 21, 15, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonSpacer: { width: 34, height: 34 },
  backButtonText: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 18,
    lineHeight: 20,
    color: COLORS.ocean50,
  },
  title: {
    fontFamily: 'DMSerifDisplay_400Regular',
    fontSize: 20,
    color: COLORS.ocean50,
  },
  label: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 11,
    letterSpacing: 1.2,
    color: COLORS.ocean300,
    marginBottom: 8,
    marginTop: 8,
  },
  empty: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: COLORS.ocean200,
    marginBottom: 12,
  },
  spaceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.mist,
    borderWidth: 1,
    borderColor: COLORS.mistBorder,
    borderRadius: 18,
    padding: 14,
    marginBottom: 10,
    gap: 10,
  },
  spaceCardOn: {
    backgroundColor: COLORS.pillOn,
    borderColor: COLORS.pillOn,
  },
  spaceCopy: { flex: 1 },
  spaceName: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 15,
    color: COLORS.ocean50,
    marginBottom: 2,
  },
  spaceNameOn: { color: COLORS.pillOnText },
  spaceAddress: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 13,
    lineHeight: 18,
    color: COLORS.ocean200,
  },
  spaceAddressOn: { color: 'rgba(248, 241, 227, 0.86)' },
  spaceHint: {
    fontFamily: 'Outfit_500Medium',
    fontSize: 11,
    marginTop: 6,
    color: COLORS.ocean300,
  },
  spaceHintOn: { color: 'rgba(248, 241, 227, 0.72)' },
  mapWrap: {
    height: 240,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.mistBorder,
    marginTop: 6,
    marginBottom: 16,
  },
  map: {
    width: '100%',
    height: '100%',
  },
  removeButton: {
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  removeButtonText: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 12,
    color: COLORS.dangerText,
  },
  removeButtonTextOn: { color: 'rgba(255, 186, 176, 0.95)' },
  awayButton: {
    borderRadius: 22,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: COLORS.mist,
    borderWidth: 1,
    borderColor: COLORS.mistBorder,
    marginBottom: 8,
  },
  toggleOn: { backgroundColor: COLORS.pillOn, borderColor: COLORS.pillOn },
  toggleText: {
    fontFamily: 'Outfit_500Medium',
    fontSize: 14,
    color: COLORS.ocean50,
  },
  toggleTextOn: { color: COLORS.pillOnText },
  usualHours: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 13,
    lineHeight: 18,
    color: COLORS.ocean200,
    marginBottom: 16,
  },
  alertCard: {
    backgroundColor: COLORS.dangerBg,
    borderWidth: 1,
    borderColor: COLORS.dangerBorder,
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
  },
  alertLabel: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 11,
    letterSpacing: 1.2,
    color: COLORS.dangerText,
    marginBottom: 6,
  },
  alertBody: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 14,
    lineHeight: 20,
    color: COLORS.ocean50,
  },
  input: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 15,
    color: COLORS.ocean50,
    backgroundColor: COLORS.mist,
    borderWidth: 1,
    borderColor: COLORS.mistBorder,
    borderRadius: 26,
    paddingVertical: 14,
    paddingHorizontal: 18,
    marginBottom: 12,
  },
  suggestList: {
    backgroundColor: COLORS.mist,
    borderWidth: 1,
    borderColor: COLORS.mistBorder,
    borderRadius: 18,
    marginBottom: 12,
    overflow: 'hidden',
  },
  suggestRow: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.mistBorder,
  },
  suggestTitle: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 14,
    color: COLORS.ocean50,
    marginBottom: 2,
  },
  suggestAddress: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 12,
    lineHeight: 16,
    color: COLORS.ocean200,
  },
  askButton: {
    backgroundColor: COLORS.pillOn,
    borderRadius: 26,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 16,
  },
  askButtonText: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 15,
    color: COLORS.pillOnText,
  },
  error: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 13,
    lineHeight: 18,
    color: COLORS.dangerText,
    marginTop: 8,
  },
});
