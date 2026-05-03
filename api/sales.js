export default function handler(req, res) {
  const sales = [
    {
      id: "1",
      title: "Hollywood Estate Sale",
      address: "123 Sunset Blvd",
      city: "Los Angeles",
      dateText: "Today 9AM–3PM",
      distanceMiles: 2.1,
      latitude: 34.06,
      longitude: -118.24,
      sourceName: "Test",
      sourceURLString: "https://example.com"
    },
    {
      id: "2",
      title: "Silver Lake Vintage Sale",
      address: "456 Hyperion Ave",
      city: "Silver Lake",
      dateText: "Tomorrow 10AM–4PM",
      distanceMiles: 1.3,
      latitude: 34.08,
      longitude: -118.27,
      sourceName: "Test",
      sourceURLString: "https://example.com"
    }
  ];

  res.status(200).json({ sales });
}
