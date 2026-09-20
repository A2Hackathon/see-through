import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
  FlatList,
  Modal,
  TouchableOpacity,
  Image,
  Animated,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import {
  useFonts,
  Outfit_300Light,
  Outfit_400Regular,
  Outfit_500Medium,
  Outfit_600SemiBold,
} from '@expo-google-fonts/outfit';
import {
  DMSerifDisplay_400Regular,
  DMSerifDisplay_400Regular_Italic,
} from '@expo-google-fonts/dm-serif-display';
import AsyncStorage from '@react-native-async-storage/async-storage';
import WheelPicker from './components/WheelPicker';
import ProfileForm from './components/ProfileForm';
import PlacesPanel from './components/FamilyPanel';
import ArchitectureGraph from './components/ArchitectureGraph';
import Esp32SenseViewer from './components/Esp32SenseViewer';
import { FACE_SERVER_URL, GLASSES_BRIDGE_URL } from './utils/config';
import { speakText } from './utils/speech';
import {
  configureRecognitionNotifications,
  notifyGlassesResult,
} from './utils/notifications';
import { useLiveGps } from './utils/liveGps';
import { createAppActionRegistry } from './utils/appActions';
import { useVoiceAssistant } from './hooks/useVoiceAssistant';

const GLASSES_POLL_INTERVAL_MS = 3000;

// Warm editorial palette inspired by the ivory, coral, amber and ice-blue
// lighting in the reference.
const COLORS = {
  ocean950: '#17150f',
  ocean900: '#2d2a20',
  ocean800: '#494537',
  ocean700: '#77745b',
  ocean600: '#a8ad72',
  ocean500: '#ff5746',
  ocean400: '#ff7557',
  ocean300: '#746f61',
  ocean200: '#48443a',
  ocean100: '#26241d',
  ocean50: '#14130f',
  sky400: '#ff493d',
  sky300: '#df4c3d',
  sky200: '#9fd5df',
  ivory: '#f3f0dc',
  warmWhite: '#f8f1e3',
  coral: '#ff493d',
  orange: '#e78a2f',
  cyan: '#91cfdd',
  olive: '#b5bb7e',
  paleBlue: '#deedf0',
  mist: 'rgba(255, 255, 245, 0.52)',
  mistStrong: 'rgba(255, 255, 245, 0.72)',
  mistBorder: 'rgba(23, 21, 15, 0.12)',
  mistBorderStrong: 'rgba(23, 21, 15, 0.20)',

  // -- Glass / pill tokens (editorial, frosted-card look) --
  glassCard: 'rgba(255, 255, 245, 0.58)',
  glassCardStrong: 'rgba(255, 255, 245, 0.78)',
  glassBorder: 'rgba(23, 21, 15, 0.14)',
  hairline: 'rgba(23, 21, 15, 0.14)',
  pillPrimaryBg: '#17150f',
  pillPrimaryText: '#f8f1e3',
  pillSecondaryBg: 'rgba(255, 255, 245, 0.50)',
  pillSecondaryBorder: 'rgba(23, 21, 15, 0.16)',
  pillDangerBg: 'rgba(255, 73, 61, 0.10)',
  pillDangerBorder: 'rgba(180, 46, 38, 0.28)',
  pillDangerText: '#a92f27',
};

// Soft base gradients crossfade with the selected quick action.
const BG_GRADIENTS = [
  [COLORS.ivory, '#f7e4d7', COLORS.warmWhite],
  [COLORS.paleBlue, COLORS.ivory, COLORS.warmWhite],
];

const BG_TRANSITION_MS = 450;

// Fakes a soft radial glow using concentric circles of decreasing
// size/opacity (RN's LinearGradient can't do radial falloff on its own).
function GlowBlob({ color, size = 260, intensity = 0.5, style }) {
  const rings = 8;
  return (
    <View
      pointerEvents="none"
      style={[{ position: 'absolute', width: size, height: size }, style]}
    >
      {Array.from({ length: rings }).map((_, i) => {
        const ringSize = size * (1 - i / rings);
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              top: (size - ringSize) / 2,
              left: (size - ringSize) / 2,
              width: ringSize,
              height: ringSize,
              borderRadius: ringSize / 2,
              backgroundColor: color,
              opacity: intensity * ((i + 1) / rings) * 0.42,
            }}
          />
        );
      })}
    </View>
  );
}

const ACTION_WHEEL_COLORS = {
  labelText: COLORS.ocean900,
  descriptionText: COLORS.ocean300,
  pillBackground: COLORS.glassCardStrong,
  pillBorder: COLORS.glassBorder,
  pillText: COLORS.ocean950,
  bubbleBackground: 'rgba(255, 255, 245, 0.56)',
  curveColor: 'rgba(23, 21, 15, 0.15)',
  thumbColor: COLORS.ocean950,
};

function FallingTitle({ text, style }) {
  const letters = text.split('');

  const animsRef = useRef(
    letters.map(() => new Animated.Value(-40))
  );

  const opacityRef = useRef(
    letters.map(() => new Animated.Value(0))
  );

  useEffect(() => {
    const animations = letters.map((_, i) =>
      Animated.parallel([
        Animated.spring(animsRef.current[i], {
          toValue: 0,
          friction: 5,
          tension: 60,
          useNativeDriver: true,
        }),

        Animated.timing(opacityRef.current[i], {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
      ])
    );

    Animated.stagger(60, animations).start();
  }, []);

  return (
    <View style={styles.fallingTitleRow}>
      {letters.map((letter, i) => (
        <Animated.Text
          key={i}
          style={[
            style,
            {
              opacity: opacityRef.current[i],
              transform: [
                {
                  translateY: animsRef.current[i],
                },
              ],
            },
          ]}
        >
          {letter === ' ' ? '\u00A0' : letter}
        </Animated.Text>
      ))}
    </View>
  );
}

export default function App() {
  const [profiles, setProfiles] = useState([]);
  const [profilesModalVisible, setProfilesModalVisible] = useState(false);
  const [profileFormOpen, setProfileFormOpen] = useState(false);
  const [safeZonesModalVisible, setSafeZonesModalVisible] = useState(false);
  const [infoModalVisible, setInfoModalVisible] = useState(false);
  const [editingProfile, setEditingProfile] = useState(null);
  const profilesRef = useRef([]);
  const latestSceneRef = useRef(null);
  const lastAlertRef = useRef('');
  const lastAssistantResponseRef = useRef('');
  const currentScreenRef = useRef('home');

  profilesRef.current = profiles;
  currentScreenRef.current = profileFormOpen
    ? 'profiles'
    : profilesModalVisible
      ? 'profiles'
      : safeZonesModalVisible
        ? 'places'
        : infoModalVisible
          ? 'info'
          : 'home';

  const gradientOpacities = useRef(
    BG_GRADIENTS.map(
      (_, index) =>
        new Animated.Value(index === 0 ? 1 : 0)
    )
  ).current;

  const animateBackgroundToIndex = (index) => {
    Animated.parallel(
      gradientOpacities.map((opacity, i) =>
        Animated.timing(opacity, {
          toValue: i === index ? 1 : 0,
          duration: BG_TRANSITION_MS,
          useNativeDriver: true,
        })
      )
    ).start();
  };

  const [fontsLoaded] = useFonts({
    Outfit_300Light,
    Outfit_400Regular,
    Outfit_500Medium,
    Outfit_600SemiBold,
    DMSerifDisplay_400Regular,
    DMSerifDisplay_400Regular_Italic,
  });
  useLiveGps();

  useEffect(() => {
    loadProfiles();

    configureRecognitionNotifications().catch((error) => {
      console.warn(
        'Could not enable recognition notifications',
        error
      );
    });
  }, []);

  const loadProfiles = async () => {
    try {
      const raw = await AsyncStorage.getItem('@profiles');

      if (raw) {
        setProfiles(JSON.parse(raw));
      }
    } catch (e) {
      console.warn('Failed to load profiles', e);
    }
  };

  const saveProfiles = async (newProfiles) => {
    try {
      await AsyncStorage.setItem(
        '@profiles',
        JSON.stringify(newProfiles)
      );

      setProfiles(newProfiles);
    } catch (e) {
      console.warn('Failed to save profiles', e);
    }
  };

  const handleSave = (profile) => {
    let newProfiles;

    const record = {
      ...profile,
      id: profile.id,
      createdAt: editingProfile
        ? editingProfile.createdAt
        : new Date().toISOString(),
    };

    if (editingProfile) {
      newProfiles = profiles.map((p) =>
        p.id === editingProfile.id
          ? {
              ...editingProfile,
              ...record,
            }
          : p
      );
    } else {
      newProfiles = [record, ...profiles];
    }

    saveProfiles(newProfiles);

    setProfileFormOpen(false);
    setEditingProfile(null);
  };

  const handleEdit = (p) => {
    setEditingProfile(p);
    setProfileFormOpen(true);
  };

  const handleDelete = async (id) => {
    try {
      const response = await fetch(
        `${FACE_SERVER_URL}/people/${id}`,
        {
          method: 'DELETE',
        }
      );

      if (!response.ok) {
        console.warn(
          `Failed to delete profile ${id} from server: ${response.status}`
        );
      }
    } catch (e) {
      console.warn(
        'Network error deleting profile from backend',
        e
      );
    }

    const filtered = profiles.filter(
      (p) => p.id !== id
    );

    saveProfiles(filtered);
  };

  const confirmDeleteProfile = (profile) => {
    Alert.alert(
      'Delete profile?',
      `Delete ${profile.name}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => handleDelete(profile.id),
        },
      ]
    );
  };

  const actionRegistry = useMemo(
    () =>
      createAppActionRegistry({
        getProfiles: () => profilesRef.current,
        saveProfiles,
        navigate: (section) => {
          setInfoModalVisible(section === 'info');
          setSafeZonesModalVisible(section === 'places');
          setProfilesModalVisible(section === 'profiles');
          if (section !== 'profiles') {
            setProfileFormOpen(false);
            setEditingProfile(null);
          }
        },
        getCurrentScreen: () => currentScreenRef.current,
        getLatestScene: () => latestSceneRef.current,
        getLastAlert: () => lastAlertRef.current,
        getLastResponse: () => lastAssistantResponseRef.current,
      }),
    []
  );

  const voiceAssistant = useVoiceAssistant({
    registry: actionRegistry,
    onResponse: (message) => {
      lastAssistantResponseRef.current = message;
    },
  });

  // Polls glasses_bridge.py.
  const lastGlassesTimestampRef =
    useRef(null);

  useEffect(() => {
    const pollGlassesFeed = async () => {
      try {
        const response = await fetch(
          `${GLASSES_BRIDGE_URL}/latest_result`
        );

        if (!response.ok) {
          return;
        }

        const result =
          await response.json();

        if (
          !result.timestamp ||
          result.timestamp ===
            lastGlassesTimestampRef.current
        ) {
          return;
        }

        lastGlassesTimestampRef.current =
          result.timestamp;
        latestSceneRef.current = result;

        const notification =
          await notifyGlassesResult(result);

        if (notification?.body) {
          lastAlertRef.current = notification.body;
          await speakText(
            notification.body
          );
        }
      } catch (e) {
        console.warn(
          'Glasses bridge poll failed',
          e.message
        );
      }
    };

    const intervalId = setInterval(
      pollGlassesFeed,
      GLASSES_POLL_INTERVAL_MS
    );

    return () =>
      clearInterval(intervalId);
  }, []);

  const actionItems = [
    {
      id: 'zones',
      label: 'My places',
      description: 'Saved familiar places',
      icon: 'location',
      color: COLORS.coral,
    },
    {
      id: 'list',
      label: 'Profiles saved',
      description: `View ${profiles.length} loved ones`,
      icon: 'people',
      color: COLORS.cyan,
    },
  ];

  const handleActionSelect = (item) => {
    if (item.id === 'zones') {
      setSafeZonesModalVisible(true);
    } else if (item.id === 'list') {
      setProfileFormOpen(false);
      setEditingProfile(null);
      setProfilesModalVisible(true);
    }
  };

  if (!fontsLoaded) {
    return (
      <LinearGradient
        colors={BG_GRADIENTS[0]}
        style={styles.container}
      />
    );
  }

  return (
    <View style={styles.container}>
      {BG_GRADIENTS.map((colors, index) => (
        <Animated.View
          key={index}
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { opacity: gradientOpacities[index] },
          ]}
        >
          <LinearGradient
            colors={colors}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ))}
      <GlowBlob
        color={COLORS.olive}
        size={340}
        intensity={0.34}
        style={styles.glowTop}
      />
      <GlowBlob
        color={COLORS.coral}
        size={430}
        intensity={0.52}
        style={styles.glowCenter}
      />
      <GlowBlob
        color={COLORS.orange}
        size={360}
        intensity={0.42}
        style={styles.glowBottom}
      />
      <GlowBlob
        color={COLORS.cyan}
        size={340}
        intensity={0.34}
        style={styles.glowBlue}
      />

      {/* Soft light fade over the animated background */}
      <LinearGradient
        pointerEvents="none"
        colors={[
          'rgba(255,255,245,0.34)',
          'rgba(255,255,245,0.08)',
          'rgba(255,255,245,0)',
        ]}
        style={styles.lightFade}
      />

      <View style={styles.headerBlock}>
        <FallingTitle
          text="See Through"
          style={styles.title}
        />

        <TouchableOpacity
          onPress={() => setInfoModalVisible(true)}
          style={styles.infoButton}
          accessibilityRole="button"
          accessibilityLabel="Open information about how See Through works"
        >
          <Ionicons
            name="information-circle-outline"
            size={16}
            color={COLORS.ocean50}
          />
          <Text style={styles.infoButtonText}>Info</Text>
        </TouchableOpacity>

        <Text style={styles.subtitle}>
          Store a photo, name and relationship to
          easily recognize family and friends.
        </Text>
      </View>

      <View style={styles.actions}>
        <Text style={styles.quickActionsLabel}>
          QUICK ACTIONS
        </Text>

        <WheelPicker
          data={actionItems}
          initialIndex={0}
          visibleRows={2}
          itemHeight={92}
          colors={ACTION_WHEEL_COLORS}
          onSelect={handleActionSelect}
          onChangeIndex={(index) =>
            animateBackgroundToIndex(index)
          }
        />
      </View>

      <View
        style={styles.voiceDock}
        accessibilityLiveRegion="polite"
        accessibilityLabel={`Voice assistant. ${voiceAssistant.statusMessage}`}
      >
        <TouchableOpacity
          onPress={voiceAssistant.toggleRecording}
          onLongPress={voiceAssistant.cancel}
          accessibilityRole="button"
          accessibilityLabel={
            voiceAssistant.status === 'listening'
              ? 'Stop recording and send voice command'
              : 'Start voice command'
          }
          accessibilityHint="Tap to start or finish speaking. Hold to cancel."
          style={[
            styles.voiceButton,
            voiceAssistant.status === 'listening' && styles.voiceButtonListening,
          ]}
        >
          <Ionicons
            name={voiceAssistant.status === 'listening' ? 'stop' : 'mic'}
            size={26}
            color={COLORS.warmWhite}
          />
        </TouchableOpacity>
        <View style={styles.voiceCopy}>
          <Text style={styles.voiceStatus}>{voiceAssistant.statusMessage}</Text>
          {voiceAssistant.transcript ? (
            <Text numberOfLines={1} style={styles.voiceTranscript}>
              {voiceAssistant.transcript}
            </Text>
          ) : null}
          {voiceAssistant.error ? (
            <Text accessibilityRole="alert" style={styles.voiceError}>
              {voiceAssistant.error}
            </Text>
          ) : null}
        </View>
      </View>

      <Modal
        visible={infoModalVisible}
        animationType="slide"
      >
        <LinearGradient
          colors={[COLORS.ivory, COLORS.warmWhite, COLORS.paleBlue]}
          style={styles.modalContainer}
        >
          <GlowBlob
            color={COLORS.olive}
            size={360}
            intensity={0.28}
            style={styles.modalGlow}
          />
          <View style={styles.profilesHeader}>
            <TouchableOpacity
              onPress={() => setInfoModalVisible(false)}
              style={styles.backButton}
              accessibilityRole="button"
              accessibilityLabel="Back to home"
            >
              <Text style={styles.backButtonText}>‹</Text>
            </TouchableOpacity>
            <Text style={styles.profilesTitle}>How it works</Text>
            <View style={styles.backButtonSpacer} />
          </View>
          <ScrollView
            style={styles.infoBody}
            contentContainerStyle={styles.infoContent}
            showsVerticalScrollIndicator={false}
          >
            <Esp32SenseViewer />
            <ScrollView
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator
              contentContainerStyle={styles.infoGraphScroll}
            >
              <ArchitectureGraph visible={infoModalVisible} />
            </ScrollView>
            <Text style={styles.infoCaption}>
              Swipe sideways to see the full graph. Photos stay on the paired laptop.
              xAI handles voice commands; optional Snowflake services add narration
              and event intelligence.
            </Text>
          </ScrollView>
        </LinearGradient>
      </Modal>

      {/* Profiles Saved */}
      <Modal
        visible={profilesModalVisible}
        animationType="slide"
      >
        <LinearGradient
          colors={[COLORS.ivory, COLORS.warmWhite, COLORS.paleBlue]}
          style={styles.modalContainer}
        >
          <GlowBlob
            color={COLORS.coral}
            size={360}
            intensity={0.28}
            style={styles.modalGlow}
          />
          {profileFormOpen ? (
            <ProfileForm
              initial={editingProfile}
              onCancel={() => {
                setProfileFormOpen(false);
                setEditingProfile(null);
              }}
              onSave={handleSave}
            />
          ) : (
            <>
              <View style={styles.profilesHeader}>
                <TouchableOpacity
                  onPress={() =>
                    setProfilesModalVisible(false)
                  }
                  style={styles.backButton}
                  accessibilityRole="button"
                  accessibilityLabel="Back to home"
                >
                  <Text
                    style={styles.backButtonText}
                  >
                    ‹
                  </Text>
                </TouchableOpacity>

                <Text
                  style={styles.profilesTitle}
                >
                  Profiles saved
                </Text>

                <TouchableOpacity
                  onPress={() => {
                    setEditingProfile(null);
                    setProfileFormOpen(true);
                  }}
                  style={styles.addProfileButton}
                  accessibilityRole="button"
                  accessibilityLabel="Add profile with caregiver assistance"
                >
                  <Text style={styles.addProfileButtonText}>Add</Text>
                </TouchableOpacity>
              </View>

              <View
                style={styles.headerDivider}
              />

              <FlatList
                data={profiles}
                keyExtractor={(item) =>
                  String(item.id)
                }
                contentContainerStyle={
                  styles.profilesListContent
                }
                ListEmptyComponent={
                  <Text
                    style={styles.emptyText}
                  >
                    No profiles yet. Tap Add to
                    save a face.
                  </Text>
                }
                renderItem={({ item }) => (
                  <View style={styles.card}>
                    {item.avatar_uri ? (
                      <Image
                        source={{
                          uri: item.avatar_uri,
                        }}
                        style={styles.avatar}
                      />
                    ) : item.photos &&
                      item.photos.length > 0 ? (
                      <Image
                        source={{
                          uri: item.photos[0],
                        }}
                        style={styles.avatar}
                      />
                    ) : (
                      <LinearGradient
                        colors={[
                          COLORS.warmWhite,
                          COLORS.cyan,
                        ]}
                        style={[
                          styles.avatar,
                          styles.placeholder,
                        ]}
                      />
                    )}

                    <View
                      style={styles.cardBody}
                    >
                      <Text
                        style={styles.name}
                      >
                        {item.name}
                      </Text>

                      <Text
                        style={styles.relation}
                      >
                        {item.relationship}
                      </Text>
                    </View>

                    <View
                      style={styles.cardActions}
                    >
                      <TouchableOpacity
                        onPress={() =>
                          handleEdit(item)
                        }
                        style={styles.link}
                        accessibilityRole="button"
                        accessibilityLabel={`Edit profile for ${item.name}`}
                      >
                        <Text
                          style={styles.linkText}
                        >
                          Edit
                        </Text>
                      </TouchableOpacity>

                      <TouchableOpacity
                        onPress={() => confirmDeleteProfile(item)}
                        style={
                          styles.deleteLink
                        }
                        accessibilityRole="button"
                        accessibilityLabel={`Delete profile for ${item.name}`}
                      >
                        <Text
                          style={[
                            styles.linkText,
                            styles.deleteText,
                          ]}
                        >
                          Delete
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              />
            </>
          )}
        </LinearGradient>
      </Modal>

      <Modal
        visible={safeZonesModalVisible}
        animationType="slide"
      >
        <LinearGradient
          colors={[COLORS.ivory, COLORS.warmWhite, COLORS.paleBlue]}
          style={styles.modalContainer}
        >
          <GlowBlob
            color={COLORS.coral}
            size={360}
            intensity={0.28}
            style={styles.modalGlow}
          />
          <PlacesPanel
            visible={safeZonesModalVisible}
            onClose={() => setSafeZonesModalVisible(false)}
          />
        </LinearGradient>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 118,
    paddingHorizontal: 28,
    paddingBottom: 20,
  },

  headerBlock: {
    marginBottom: 4,
  },

  lightFade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '55%',
  },

  glowTop: {
    top: -120,
    left: -110,
  },

  glowCenter: {
    top: 220,
    right: -190,
  },

  glowBottom: {
    bottom: -130,
    left: -130,
  },

  glowBlue: {
    bottom: -160,
    right: -140,
  },

  modalGlow: {
    top: 180,
    right: -170,
  },

  fallingTitleRow: {
    flexDirection: 'row',
    flexWrap: 'nowrap',
  },

  title: {
    fontFamily:
      'DMSerifDisplay_400Regular',
    fontSize: 36,
    lineHeight: 42,
    color: COLORS.ocean50,
  },

  subtitle: {
    fontFamily:
      'Outfit_400Regular',
    color: COLORS.ocean200,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
    marginBottom: 10,
    maxWidth: 270,
  },

  infoButton: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: COLORS.pillSecondaryBg,
    borderWidth: 1,
    borderColor: COLORS.pillSecondaryBorder,
  },

  infoButtonText: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 13,
    color: COLORS.ocean50,
  },

  infoBody: {
    flex: 1,
  },

  infoContent: {
    paddingHorizontal: 12,
    paddingBottom: 36,
  },

  infoGraphScroll: {
    paddingRight: 20,
    paddingBottom: 8,
  },

  infoCaption: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 13,
    lineHeight: 19,
    color: COLORS.ocean200,
    marginTop: 12,
    paddingHorizontal: 4,
  },

  quickActionsLabel: {
    fontFamily:
      'Outfit_600SemiBold',
    color: COLORS.ocean300,
    fontSize: 11,
    letterSpacing: 1.4,
    marginBottom: 14,
    alignSelf: 'flex-start',
  },

  actions: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 36,
  },

  card: {
    backgroundColor:
      'rgba(255, 255, 245, 0.58)',
    borderRadius: 17,
    padding: 11,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor:
      'rgba(23, 21, 15, 0.13)',
    shadowColor: '#000',
    shadowOpacity: 0.10,
    shadowRadius: 12,
    shadowOffset: {
      width: 0,
      height: 5,
    },
    elevation: 3,
  },

  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginRight: 10,
    borderWidth: 1,
    borderColor: COLORS.glassBorder,
  },

  placeholder: {
    backgroundColor:
      COLORS.cyan,
  },

  cardBody: {
    flex: 1,
    paddingRight: 8,
  },

  name: {
    fontFamily:
      'Outfit_600SemiBold',
    fontSize: 12,
    color: COLORS.ocean50,
  },

  relation: {
    fontFamily:
      'Outfit_400Regular',
    color: COLORS.ocean200,
    fontSize: 9.5,
    marginTop: 1,
  },

  cardActions: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 3,
  },

  link: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor:
      COLORS.pillSecondaryBg,
    borderWidth: 1,
    borderColor:
      COLORS.pillSecondaryBorder,
  },

  deleteLink: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor:
      COLORS.pillDangerBg,
    borderWidth: 1,
    borderColor:
      COLORS.pillDangerBorder,
  },

  linkText: {
    fontFamily:
      'Outfit_500Medium',
    fontSize: 9,
    color: COLORS.sky300,
  },

  deleteText: {
    color:
      COLORS.pillDangerText,
  },

  voiceDock: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 24,
    minHeight: 68,
    borderRadius: 24,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 245, 0.92)',
    borderWidth: 1,
    borderColor: COLORS.glassBorderStrong,
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 7 },
    elevation: 7,
  },
  voiceButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.ocean950,
  },
  voiceButtonListening: {
    backgroundColor: COLORS.coral,
  },
  voiceCopy: {
    flex: 1,
    paddingHorizontal: 12,
  },
  voiceStatus: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 13,
    color: COLORS.ocean50,
  },
  voiceTranscript: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 11,
    color: COLORS.ocean300,
    marginTop: 2,
  },
  voiceError: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 10,
    color: COLORS.pillDangerText,
    marginTop: 2,
  },
  modalContainer: {
    flex: 1,
    paddingTop: 64,
    backgroundColor:
      COLORS.ivory,
  },

  profilesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginBottom: 20,
  },

  backButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor:
      COLORS.pillSecondaryBg,
    borderWidth: 1,
    borderColor:
      COLORS.pillSecondaryBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },

  backButtonSpacer: {
    width: 34,
    height: 34,
  },

  addProfileButton: {
    minWidth: 34,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    backgroundColor: COLORS.coral,
    alignItems: 'center',
    justifyContent: 'center',
  },

  addProfileButtonText: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 13,
    color: COLORS.warmWhite,
  },

  backButtonText: {
    fontFamily:
      'Outfit_600SemiBold',
    fontSize: 18,
    lineHeight: 20,
    color: COLORS.ocean50,
  },

  headerDivider: {
    height: 1,
    backgroundColor:
      COLORS.hairline,
    marginHorizontal: 16,
    marginBottom: 10,
  },

  profilesTitle: {
    fontFamily:
      'DMSerifDisplay_400Regular',
    fontSize: 20,
    color: COLORS.ocean50,
  },

  profilesListContent: {
    paddingHorizontal: 16,
    paddingBottom: 40,
    paddingTop: 0,
  },

  emptyText: {
    fontFamily:
      'Outfit_400Regular',
    color: COLORS.ocean200,
    textAlign: 'center',
    marginTop: 40,
  },
});