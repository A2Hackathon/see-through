const PHOTON_URL = 'https://photon.komoot.io/api/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

function uniqueLabel(parts) {
  return [...new Set(parts.filter(Boolean))].join(', ');
}

function fromPhoton(feature) {
  const [lng, lat] = feature?.geometry?.coordinates || [];
  const props = feature?.properties || {};
  if (lat == null || lng == null) return null;
  const street = [props.housenumber, props.street].filter(Boolean).join(' ');
  const locality = props.city || props.town || props.village || props.district;
  const title = props.name || street || locality || 'Place';
  const address = uniqueLabel([
    props.name,
    street,
    locality,
    props.state,
    props.postcode,
    props.country,
  ]);
  return {
    id: String(props.osm_id || `${lat},${lng},${title}`),
    title,
    address,
    lat,
    lng,
  };
}

function fromNominatim(item) {
  if (item?.lat == null || item?.lon == null) return null;
  return {
    id: String(item.place_id),
    title: item.name || item.display_name.split(',')[0],
    address: item.display_name,
    lat: Number(item.lat),
    lng: Number(item.lon),
  };
}

async function searchPhoton(query) {
  const url = `${PHOTON_URL}?q=${encodeURIComponent(query)}&limit=6&lang=en`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Photon ${response.status}`);
  const payload = await response.json();
  return (payload.features || []).map(fromPhoton).filter(Boolean);
}

async function searchNominatim(query) {
  const url = `${NOMINATIM_URL}?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'SeeThrough/1.0 (HopHacks Expo app)',
    },
  });
  if (!response.ok) throw new Error(`Nominatim ${response.status}`);
  const payload = await response.json();
  return (Array.isArray(payload) ? payload : []).map(fromNominatim).filter(Boolean);
}

export async function searchAddresses(query) {
  const trimmed = String(query || '').trim();
  if (trimmed.length < 3) return [];
  try {
    const photon = await searchPhoton(trimmed);
    if (photon.length) return photon;
  } catch (error) {
    console.warn('Photon search skipped', error.message);
  }
  try {
    return await searchNominatim(trimmed);
  } catch (error) {
    console.warn('Nominatim search skipped', error.message);
    return [];
  }
}
