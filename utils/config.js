import Constants from 'expo-constants';

// Use the computer's LAN address so Expo Go on a phone can reach all services.
export const BACKEND_HOST = 'http://10.191.233.50';
const metroHost =
  Constants.expoConfig?.hostUri || Constants.expoGoConfig?.debuggerHost || null;
const metroBase = metroHost
  ? `${metroHost.endsWith('.exp.direct') ? 'https' : 'http'}://${metroHost}`
  : null;

// In Expo Go, proxy through Metro. This works over both LAN and Expo tunnels
// and avoids managed/public Wi-Fi blocking the laptop's backend ports.
export const DETECTOR_SERVER_URL = metroBase
  ? `${metroBase}/api/detector`
  : `${BACKEND_HOST}:8000`;
export const FACE_SERVER_URL = metroBase
  ? `${metroBase}/api/face`
  : `${BACKEND_HOST}:8001`;
export const GLASSES_BRIDGE_URL = metroBase
  ? `${metroBase}/api/glasses`
  : `${BACKEND_HOST}:8002`;
export const ASSISTANT_SERVER_URL = metroBase
  ? `${metroBase}/api/assistant`
  : `${BACKEND_HOST}:8003`;

export const SNOWFLAKE_ACCOUNT_URL =
  'https://YNCKWCX-IK47084.snowflakecomputing.com';
export const SNOWFLAKE_WAREHOUSE = 'SEE_THROUGH_WH';
export const SNOWFLAKE_DATABASE = 'SEE_THROUGH';
export const SNOWFLAKE_SCHEMA = 'APP';
export const SNOWFLAKE_MODEL = 'llama3.1-8b';
