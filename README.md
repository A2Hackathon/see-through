# Hophacks - Loved Ones Assistive App

An Expo React Native prototype that stores familiar-person profiles, verifies faces, detects selected objects, and provides concise spoken feedback for image verification. OpenGlass snapshots are analyzed about every 5 seconds. Snowflake Cortex turns those structured detections into spoken cues, daily-pattern memory, and family alerts. Photos never leave the laptop.

## Getting started

1. Install dependencies:

```bash
npm install
```

2. Start the Python services (from `server/`, with your venv active):

```bash
pip install -r requirements.txt
uvicorn detector_server:app --host 0.0.0.0 --port 8000
uvicorn face_service:app --host 0.0.0.0 --port 8001
uvicorn glasses_bridge:app --host 0.0.0.0 --port 8002
uvicorn assistant_service:app --host 0.0.0.0 --port 8003
```

Before starting the assistant, copy `server/.env.example` to `server/.env` and
replace the placeholder with your xAI API key. The `.env` file is ignored by Git.

3. Point [utils/config.js](utils/config.js) at this computer's LAN IP, then start Expo:

```bash
npm start
```

Open the QR code in Expo Go. Voice control is push-to-talk and uses the
microphone button.

The xAI key stays on the laptop and must never be added to `app.json`,
`utils/config.js`, or any `EXPO_PUBLIC_` environment variable.

## Voice control

- Tap the microphone button, speak, then tap again to send the command.
- Voice tools can navigate the app; list/check profiles; manage safe spaces;
  report current place; toggle live GPS; and read the latest glasses scene.
- Deleting a profile or place and disabling GPS require a separate spoken
  confirmation. Profile photo enrollment remains caregiver-operated.
- Use [VOICE_TESTING.md](VOICE_TESTING.md) for the physical-device acceptance flow.

## Snowflake Cortex (your account setup)

Credits come from a student trial, not a separate API store. Do this once:

1. Use the HopHacks Snowflake booth / Discord signup if you have it. Otherwise [signup.snowflake.com/?trial=st](https://signup.snowflake.com/?trial=st).
2. Cloud **AWS**, region **US East (N. Virginia)** or **US West (Oregon)**. Edition Enterprise if offered.
3. Activate email, then in Snowsight: bottom-left name → **Connect a tool to Snowflake**. Copy `https://<account>.snowflakecomputing.com`.
4. Create a programmatic access token (PAT) under authentication settings. Add a **network policy exception** for hackathon Wi-Fi.
5. Smoke-test Cortex REST (also the judging CURL clip):

```bash
curl "https://<account>.snowflakecomputing.com/api/v2/cortex/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <PAT>" \
  -d '{"model":"llama3.1-8b","messages":[{"role":"user","content":"Say hi in 5 words"}]}'
```

If that returns `Trial accounts are not allowed`, in a worksheet run:

```sql
SELECT SNOWFLAKE.CORTEX.COMPLETE('llama3.1-8b', 'Say hi in 5 words');
```

Then set `SNOWFLAKE_COMPLETE_VIA_SQL=true` in `.env`. The client also auto-falls back on 403.

6. In a Snowsight worksheet, run [server/setup_snowflake.sql](server/setup_snowflake.sql) (warehouse, `SEE_THROUGH.APP.SCENE_EVENTS`, optional Cortex Search).
7. Copy [server/.env.example](server/.env.example) to `server/.env` and fill `SNOWFLAKE_ACCOUNT_URL` and `SNOWFLAKE_PAT`. Never commit `.env`.

Without `.env`, glasses and Test recognition still work using local speech templates.

## Implemented

- Local profile list with name, relationship, and avatar photos.
- Enrollment with 3-5 photos per person.
- FastAPI face enrollment and verification using InsightFace embeddings.
- FastAPI YOLO object detection service.
- OpenGlass BLE capture in `glasses_bridge.py` with spoken Cortex cues and template fallback.
- Duplicate scene suppression (~20s) so Cortex is not called every frame.
- Family brief / Q&A screen (Cortex Search when available, else last N events).
- Mock home / away safe-space toggle with a Cortex family-alert sentence.
- Spoken hazard filtering for high-confidence people, cars, and stop signs.
- Existing visual alerts remain available alongside audio feedback.
- Local-network service configuration for Expo development.
- xAI speech transcription and app-wide function-calling voice control.
- Foreground GPS safe spaces with voice-controlled add, list, remove, and status.
- Manual face API and multi-face test scripts.

## Provisional spatial calibration

The detector adds image geometry, horizontal bearing, and rough monocular
distance estimates to each YOLO detection. The existing `box` field remains
`[x, y, width, height]`. Bearing is negative to the left and positive to the
right, using a provisional 70-degree horizontal field of view. Distance uses
approximate real-world heights for people, cars, and stop signs; unsupported
classes return `null`. These values are marked `distance_quality: "provisional"`
and are for development only until the OpenGlass camera is measured and
calibrated.

## Remaining Work

- Add family push notifications to a second device.
- Calibrate recognition thresholds with positive and unknown-person test data.
- Add production deployment, background geofencing, retries, logging, and broader physical-device validation.
