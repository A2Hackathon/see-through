import { DETECTOR_SERVER_URL } from './config';
import { appendImageFile } from './upload';

// Sends an image to the detector. The response is { image, detections }.
// Each detection keeps box: [x, y, width, height] and may include provisional
// center, bottom_center, normalized_center, bearing_deg, and distance_m_estimate.
export async function detectFromUri(uri) {
  try {
    // fetch image blob from local uri
    const fd = new FormData();
    await appendImageFile(fd, 'file', uri, 'frame.jpg');

    const res = await fetch(`${DETECTOR_SERVER_URL}/detect`, {
      method: 'POST',
      body: fd,
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Detector error: ${res.status} ${txt}`);
    }

    const json = await res.json();
    return json;
  } catch (e) {
    console.warn('detectFromUri error', e);
    return [];
  }
}
