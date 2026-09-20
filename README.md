# See Through

An Expo React Native app that recognizes familiar faces, detects obstacles, and speaks concise guidance for people who are blind or visually impaired. OpenGlass snapshots are analyzed about every 5 seconds; Snowflake Cortex turns detections into spoken cues, daily-pattern memory, and family alerts. Camera photos never leave the laptop.

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

Copy `server/.env.example` to `server/.env` and add your xAI API key. The key stays on the laptop, never commit it or add it to `app.json`, `utils/config.js`, or any `EXPO_PUBLIC_` variable.

3. Point [utils/config.js](utils/config.js) at this computer's LAN IP, then start Expo:

```bash
npm start
```

Open the QR code in Expo Go. Voice control is push-to-talk via the microphone button.

## Voice control

- Tap the microphone, speak, then tap again to send.
- Voice tools navigate the app, list/check profiles, manage safe spaces, report current place, toggle live GPS, and read the latest glasses scene.
- Deleting a profile or place and disabling GPS require a separate spoken confirmation. Photo enrollment stays caregiver-operated.
- See [VOICE_TESTING.md](VOICE_TESTING.md) for the device acceptance flow.

## Snowflake Cortex setup

One-time setup using a student trial:

1. Sign up via the HopHacks booth/Discord, or [signup.snowflake.com/?trial=st](https://signup.snowflake.com/?trial=st).
2. Cloud **AWS**, region **US East (N. Virginia)** or **US West (Oregon)**, Edition Enterprise if offered.
3. In Snowsight: bottom-left name → **Connect a tool to Snowflake**. Copy `https://<account>.snowflakecomputing.com`.
4. Create a programmatic access token (PAT) and add a **network policy exception** for hackathon Wi-Fi.
5. Smoke-test Cortex REST:

```bash
curl "https://<account>.snowflakecomputing.com/api/v2/cortex/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <PAT>" \
  -d '{"model":"llama3.1-8b","messages":[{"role":"user","content":"Say hi in 5 words"}]}'
```

If this returns `Trial accounts are not allowed`, run the SQL form in a worksheet, then set `SNOWFLAKE_COMPLETE_VIA_SQL=true` in `.env` (the client also auto-falls back on 403):

```sql
SELECT SNOWFLAKE.CORTEX.COMPLETE('llama3.1-8b', 'Say hi in 5 words');
```

6. Run [server/setup_snowflake.sql](server/setup_snowflake.sql) in a worksheet (warehouse, `SEE_THROUGH.APP.SCENE_EVENTS`, optional Cortex Search).
7. Fill `SNOWFLAKE_ACCOUNT_URL` and `SNOWFLAKE_PAT` in `server/.env`. Never commit `.env`.

Without `.env`, glasses and Test recognition still work using local speech templates.

## Implemented

- Local profiles with name, relationship, and avatar photos (3–5 enrollment photos per person).
- FastAPI face enrollment/verification (InsightFace embeddings) and YOLO object detection.
- OpenGlass BLE capture in `glasses_bridge.py` with spoken Cortex cues and template fallback.
- Duplicate scene suppression (~20s) so Cortex isn't called every frame.
- Family brief / Q&A screen (Cortex Search when available, else last N events).
- Home/away safe-space toggle with a Cortex family-alert sentence.
- Spoken hazard filtering for high-confidence people, cars, and stop signs, alongside visual alerts.
- xAI speech transcription and app-wide function-calling voice control.
- Foreground GPS safe spaces with voice-controlled add, list, remove, and status.

## Provisional spatial calibration

The detector adds image geometry, horizontal bearing, and rough monocular distance to each YOLO detection. `box` remains `[x, y, width, height]`. Bearing is negative left / positive right using a provisional 70° horizontal FOV. Distance uses approximate real-world heights for people, cars, and stop signs; other classes return `null`. Values are marked `distance_quality: "provisional"` (development only) until the OpenGlass camera is calibrated.

## Remaining work

- Family push notifications to a second device.
- Calibrate recognition thresholds with positive and unknown-person test data.
- Production deployment, background geofencing, retries, logging, and broader device validation.
