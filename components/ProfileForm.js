import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Image, StyleSheet, TouchableOpacity, Alert, ScrollView } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { FACE_SERVER_URL } from '../utils/config';
import { appendImageFile } from '../utils/upload';

// Warm editorial palette shared with the ivory/coral app background.
const COLORS = {
  ocean950: '#17150f',
  ocean300: '#746f61',
  ocean200: '#48443a',
  ocean100: '#26241d',
  ocean50: '#14130f',
  sky400: '#17150f',
  sky300: '#d94638',
  mist: 'rgba(255, 255, 245, 0.58)',
  mistBorder: 'rgba(23, 21, 15, 0.15)',
  danger: '#ff6b5e',
  dangerBg: 'rgba(255, 73, 61, 0.12)',
  dangerBorder: 'rgba(180, 46, 38, 0.28)',
};

async function buildProfileFormData({ name, relationship, photos }) {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('relationship', relationship);

  await Promise.all(
    photos.map((uri, index) =>
      appendImageFile(formData, 'files', uri, `person_${index}.jpg`)
    )
  );
  return formData;
}

async function sendProfileRequest(url, method, profile) {
  const response = await fetch(url, {
    method,
    body: await buildProfileFormData(profile),
  });
  const result = await response.json();
  return { response, result };
}

async function saveKnownPerson({ personId, name, relationship, photos }) {
  const profile = { name, relationship, photos };

  if (personId !== null && personId !== undefined) {
    const update = await sendProfileRequest(
      `${FACE_SERVER_URL}/people/${personId}`,
      'PUT',
      profile
    );
    if (update.response.ok) return update.result;

    // Profiles created by older app versions stored a timestamp instead of
    // the backend ID. Re-enroll once and replace that stale local ID.
    if (update.response.status !== 404) return update.result;
  }

  const enrollment = await sendProfileRequest(
    `${FACE_SERVER_URL}/enroll`,
    'POST',
    profile
  );
  return enrollment.result;
}

export default function ProfileForm({ initial = null, onSave, onCancel }) {
  const [name, setName] = useState(initial ? initial.name : '');
  const [relationship, setRelationship] = useState(initial ? initial.relationship : '');
  // photos: array of uri strings (3-5)
  const [photos, setPhotos] = useState(initial ? (initial.photos || (initial.image ? [initial.image] : [])) : []);

  useEffect(() => {
    setName(initial ? initial.name : '');
    setRelationship(initial ? initial.relationship : '');
    setPhotos(initial ? (initial.photos || (initial.image ? [initial.image] : [])) : []);
  }, [initial]);

  useEffect(() => {
    (async () => {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permissions required', 'Permission to access media library is required.');
      }
    })();
  }, []);

  const pickImage = async () => {
    if (photos.length >= 5) {
      Alert.alert('Limit reached', 'You can add up to 5 photos.');
      return;
    }

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        quality: 0.7,
      });
      if (!result.canceled) {
        setPhotos([...photos, result.assets[0].uri]);
      }
    } catch (e) {
      console.warn(e);
    }
  };

  const takePhoto = async () => {
    if (photos.length >= 5) {
      Alert.alert('Limit reached', 'You can add up to 5 photos.');
      return;
    }

    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permissions required', 'Camera permission is required to take a photo.');
      return;
    }

    try {
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        quality: 0.7,
      });
      if (!result.canceled) {
        setPhotos([...photos, result.assets[0].uri]);
      }
    } catch (e) {
      Alert.alert('Camera error', 'The camera could not be opened.');
      console.warn('Camera error', e);
    }
  };

  const removePhoto = (index) => {
    const next = photos.slice();
    next.splice(index, 1);
    setPhotos(next);
  };

  // The Figma design shows one "Add Photo" circle; underneath it still
  // offers the same Library/Camera choice the app already supported.
  const handleAddPhotoPress = () => {
    if (photos.length >= 5) {
      Alert.alert('Limit reached', 'You can add up to 5 photos.');
      return;
    }
    Alert.alert('Add Photo', 'Choose a source', [
      { text: 'Camera', onPress: takePhoto },
      { text: 'Photo Library', onPress: pickImage },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleSubmit = async () => {
    if (!name.trim()) return Alert.alert('Validation', 'Please enter a name.');
    if (!relationship.trim()) return Alert.alert('Validation', 'Please enter relationship.');
    if (!photos || photos.length < 3) return Alert.alert('Validation', 'Please add at least 3 photos for enrollment.');

    try {
      const saved = await saveKnownPerson({
        personId: initial?.id,
        name: name.trim(),
        relationship: relationship.trim(),
        photos,
      });

      if (!saved.success) {
        Alert.alert(
          initial ? 'Update failed' : 'Enrollment failed',
          saved.detail || 'The backend could not save this person.'
        );
        return;
      }

      const avatar = photos[0];
      onSave({
        id: saved.person_id,
        name: saved.name,
        relationship: saved.relationship,
        photos,
        avatar_uri: avatar,
      });
    } catch (error) {
      Alert.alert('Enrollment error', 'The backend could not process the uploaded photos.');
      console.warn('Enrollment error', error);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.containerContent}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onCancel} style={styles.cancelButton}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{initial ? 'Edit Profile' : 'New Profile'}</Text>
        <View style={styles.cancelButton} />
      </View>

      <View style={styles.photoSection}>
        <TouchableOpacity onPress={handleAddPhotoPress} style={styles.avatarCircle}>
          {photos[0] ? (
            <Image source={{ uri: photos[0] }} style={styles.avatarImage} />
          ) : (
            <Ionicons name="camera-outline" size={32} color={COLORS.sky300} />
          )}
        </TouchableOpacity>
        <Text style={styles.addPhotoLabel}>{photos[0] ? 'Change Photo' : 'Add Photo'}</Text>
        <Text style={styles.photoHint}>
          {photos.length}/5 added · at least 3 needed for recognition
        </Text>

        {photos.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.thumbRow}>
            {photos.map((p, i) => (
              <View key={i} style={styles.thumbWrap}>
                <Image source={{ uri: p }} style={styles.thumb} />
                <TouchableOpacity onPress={() => removePhoto(i)} style={styles.thumbRemove}>
                  <Ionicons name="close" size={12} color={COLORS.ocean950} />
                </TouchableOpacity>
              </View>
            ))}
            {photos.length < 5 && (
              <TouchableOpacity onPress={handleAddPhotoPress} style={styles.thumbAdd}>
                <Ionicons name="add" size={22} color={COLORS.sky300} />
              </TouchableOpacity>
            )}
          </ScrollView>
        )}
      </View>

      <Text style={styles.label}>NAME</Text>
      <TextInput
        placeholder="Enter full name"
        placeholderTextColor={COLORS.ocean300}
        value={name}
        onChangeText={setName}
        style={styles.input}
      />

      <Text style={styles.label}>RELATIONSHIP</Text>
      <TextInput
        placeholder="e.g., Mother, Brother, Friend"
        placeholderTextColor={COLORS.ocean300}
        value={relationship}
        onChangeText={setRelationship}
        style={styles.input}
      />

      <TouchableOpacity onPress={handleSubmit} style={styles.saveButton}>
        <Text style={styles.saveButtonText}>Save Profile</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  containerContent: {
    paddingHorizontal: 24,
    paddingBottom: 48,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 28,
  },
  cancelButton: {
    minWidth: 56,
  },
  cancelText: {
    fontFamily: 'Outfit_500Medium',
    fontSize: 15,
    color: COLORS.sky300,
  },
  headerTitle: {
    fontFamily: 'DMSerifDisplay_400Regular',
    fontSize: 18,
    color: COLORS.ocean50,
  },
  photoSection: {
    alignItems: 'center',
    marginBottom: 28,
  },
  avatarCircle: {
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 1.5,
    borderColor: COLORS.mistBorder,
    borderStyle: 'dashed',
    backgroundColor: COLORS.mist,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  addPhotoLabel: {
    fontFamily: 'Outfit_500Medium',
    fontSize: 14,
    color: COLORS.sky300,
    marginTop: 10,
  },
  photoHint: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 11.5,
    color: COLORS.ocean300,
    marginTop: 4,
  },
  thumbRow: {
    marginTop: 16,
    maxHeight: 64,
  },
  thumbWrap: {
    marginRight: 8,
  },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.mistBorder,
  },
  thumbRemove: {
    position: 'absolute',
    top: -5,
    right: -5,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: COLORS.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbAdd: {
    width: 52,
    height: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.mistBorder,
    backgroundColor: COLORS.mist,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 11,
    letterSpacing: 1.2,
    color: COLORS.ocean300,
    marginBottom: 8,
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
    marginBottom: 20,
  },
  saveButton: {
    backgroundColor: COLORS.sky400,
    borderRadius: 26,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 12,
  },
  saveButtonText: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 15,
    color: '#f8f1e3',
  },
});