export default async function handler(req, res) {
  try {
    const lat = Number(req.query.lat || 34.05);
    const lng = Number(req.query.lng || -118.25);

    // SIMPLE TEST DATA (no external calls yet)
    const sales = [
      {
        id: cryptoRandomUUID(),
        title: "Hollywood Hills Estate Sale",
        address: "123 Sunset Blvd",
        city: "Los Angeles",
        dateText: "Today · 9AM–3PM",
        distanceMiles: 2.1,
        latitude: lat + 0.01,
        longitude: lng + 0.01,
        sourceName: "Test",
        sourceURLString: "https://example.com"
      },
      {
        id: cryptoRandomUUID(),
        title: "Vintage Silver Lake Sale",
        address: "456 Hyperion Ave",
        city: "Silver Lake",
        dateText: "Tomorrow · 10AM–4PM",
        distanceMiles: 1.3,
        latitude: lat - 0.01,
        longitude: lng - 0.01,
        sourceName: "Test",
        sourceURLString: "https://example.com"
      }
    ];

    return res.status(200).json({ sales });

  } catch (error) {
    return res.status(500).json({
      error: "Backend crashed",
      details: error.message
    });
  }
}

function cryptoRandomUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
