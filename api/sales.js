module.exports = function handler(req, res) {
  return res.status(200).json({
    sales: [
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
      }
    ]
  });
};
