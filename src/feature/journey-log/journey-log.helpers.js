function normalizeLocation(location) {
  const coordinates = location?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length !== 2) return null;

  const lng = Number(coordinates[0]);
  const lat = Number(coordinates[1]);
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    lng < -180 ||
    lng > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    return null;
  }

  return { type: "Point", coordinates: [lng, lat] };
}

module.exports = { normalizeLocation };
