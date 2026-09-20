import { Platform, PermissionsAndroid } from 'react-native';
import { BleManager } from 'react-native-ble-plx';
import * as FileSystem from 'expo-file-system';
import { toByteArray, fromByteArray } from 'base64-js';

// These UUIDs are copied directly from firmware.ino (configure_ble()). They
// must match the firmware exactly, or the app will simply never discover the
// service/characteristics and every connection attempt will time out.
export const SERVICE_UUID = '19b10000-e8f2-537e-4f6c-d104768a1214';
export const PHOTO_DATA_UUID = '19b10005-e8f2-537e-4f6c-d104768a1214';
export const PHOTO_CONTROL_UUID = '19b10006-e8f2-537e-4f6c-d104768a1214';
export const BATTERY_SERVICE_UUID = '0000180f-0000-1000-8000-00805f9b34fb';
export const BATTERY_LEVEL_UUID = '00002a19-0000-1000-8000-00805f9b34fb';

// Set by BLEDevice::init("OpenGlass") in setup/configure_ble().
export const DEVICE_NAME = 'OpenGlass';

const manager = new BleManager();

let photoSubscription = null;
let photoChunks = [];

// Android 12+ (API 31+) uses runtime Bluetooth permissions instead of location.
// Older Android still requires location permission for BLE scanning.
export async function requestBlePermissions() {
  if (Platform.OS !== 'android') return true;

  if (Platform.Version >= 31) {
    const granted = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
    return Object.values(granted).every(
      (result) => result === PermissionsAndroid.RESULTS.GRANTED
    );
  }

  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
  );
  return granted === PermissionsAndroid.RESULTS.GRANTED;
}

function scanForGlasses({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      manager.stopDeviceScan();
      reject(
        new Error(
          'Timed out looking for glasses. Make sure they are powered on and nearby.'
        )
      );
    }, timeoutMs);

    manager.startDeviceScan([SERVICE_UUID], null, (error, device) => {
      if (finished) return;
      if (error) {
        finished = true;
        clearTimeout(timeout);
        manager.stopDeviceScan();
        reject(error);
        return;
      }
      if (device && (device.name === DEVICE_NAME || device.localName === DEVICE_NAME)) {
        finished = true;
        clearTimeout(timeout);
        manager.stopDeviceScan();
        resolve(device);
      }
    });
  });
}

export async function connectToGlasses() {
  const permitted = await requestBlePermissions();
  if (!permitted) {
    throw new Error('Bluetooth permissions were not granted.');
  }
  const found = await scanForGlasses();
  const device = await found.connect();
  await device.discoverAllServicesAndCharacteristics();
  return device;
}

export async function disconnectGlasses(device) {
  if (photoSubscription) {
    photoSubscription.remove();
    photoSubscription = null;
  }
  photoChunks = [];
  if (device) {
    try {
      await device.cancelConnection();
    } catch (e) {
      console.warn('Error disconnecting glasses', e);
    }
  }
}

async function writeJpegToFile(bytes) {
  const base64 = fromByteArray(bytes);
  const path = `${FileSystem.cacheDirectory}glasses_frame_${Date.now()}.jpg`;
  await FileSystem.writeAsStringAsync(path, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return path;
}

// Reassembles chunked photo notifications into a single JPEG and writes it to
// a temp file, then calls onPhotoUri with a file:// URI that can be dropped
// straight into the existing detectFromUri / verifyPersonFromImage pipeline.
//
// Firmware framing (see the photo-upload block at the bottom of loop() in
// firmware.ino):
//   - Each notification is [frameIndexLow, frameIndexHigh, ...up to 200 bytes of JPEG]
//   - A notification of exactly [0xFF, 0xFF] with no payload marks end-of-photo
export function watchForPhotos(device, onPhotoUri) {
  photoChunks = [];
  photoSubscription = device.monitorCharacteristicForService(
    SERVICE_UUID,
    PHOTO_DATA_UUID,
    async (error, characteristic) => {
      if (error) {
        console.warn('Photo notification error', error);
        return;
      }
      if (!characteristic?.value) return;

      const bytes = toByteArray(characteristic.value);
      if (bytes.length < 2) return;

      const isEndMarker = bytes.length === 2 && bytes[0] === 0xff && bytes[1] === 0xff;
      if (isEndMarker) {
        const totalLength = photoChunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const full = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of photoChunks) {
          full.set(chunk, offset);
          offset += chunk.length;
        }
        photoChunks = [];

        if (totalLength === 0) return; // stray terminator with nothing captured

        try {
          const uri = await writeJpegToFile(full);
          onPhotoUri(uri);
        } catch (e) {
          console.warn('Failed to save glasses photo', e);
        }
        return;
      }

      // Non-terminal chunk: bytes[0..1] is a little-endian frame index. We
      // don't strictly need to reorder by it since BLE notifications arrive
      // in order on a single connection, so we just append in receive order.
      photoChunks.push(bytes.slice(2));
    }
  );
  return photoSubscription;
}

async function writePhotoControl(device, signedByteValue) {
  const byte = signedByteValue & 0xff;
  const base64Value = fromByteArray(new Uint8Array([byte]));
  await device.writeCharacteristicWithResponseForService(
    SERVICE_UUID,
    PHOTO_CONTROL_UUID,
    base64Value
  );
}

// Semantics from handlePhotoControl() in firmware.ino:
//   -1      -> take exactly one photo
//    0      -> stop periodic capture
//   5..300  -> start periodic capture every N seconds (rounded to nearest 5s)
export async function takeSinglePhoto(device) {
  await writePhotoControl(device, -1);
}

export async function startPeriodicCapture(device, intervalSeconds = 5) {
  const clamped = Math.min(300, Math.max(5, intervalSeconds));
  await writePhotoControl(device, clamped);
}

export async function stopPeriodicCapture(device) {
  await writePhotoControl(device, 0);
}

export async function readBatteryLevel(device) {
  const characteristic = await device.readCharacteristicForService(
    BATTERY_SERVICE_UUID,
    BATTERY_LEVEL_UUID
  );
  const bytes = toByteArray(characteristic.value);
  return bytes[0];
}
