// EstateScout Backend
// Deploy this as a Vercel Serverless Function at: /api/sales
// File path in your project: api/sales.js
//
// What it does:
// - Accepts lat, lng, radius, and source from the iPhone app
// - Converts location into a ZIP code using OpenStreetMap Nominatim
// - Pulls public estate-sale listing pages
// - Normalizes results into the JSON shape the Swift app expects
//
// Important:
// - For a real App Store app, prefer an approved API/scraper service or permissioned data source.
// - Keep scraping rate low and cache responses.
// - If a site blocks or changes markup, use Apify/approved API instead.

export default async function handler(req, res) {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radius = Number(req.query.radius || 15);
    const source = String(req.query.source || "all");

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: "Missing or invalid lat/lng" });
    }

    const place = await reverseGeocode(lat, lng);
    const zip = place.zip || "90026";
    const city = slugCity(place.city || "Los Angeles");
    const state = place.stateCode || "CA";

    let sales = [];

    if (source === "all" || source === "estatesalesnet") {
      const netSales = await fetchEstateSalesNet({ state, city, zip, radius });
      sales.push(...netSales);
    }

    if (source === "all" || source === "estatesalesorg") {
      const orgSales = await fetchEstateSalesOrg({ state, city, zip, radius });
      sales.push(...orgSales);
    }

    if ((source === "all" || source === "apify") && process.env.APIFY_TOKEN && process.env.APIFY_ACTOR_ID) {
      const apifySales = await fetchApifySales({ lat, lng, radius });
      sales.push(...apifySales);
    }

    sales = dedupeSales(sales)
      .filter((sale) => Number.isFinite(sale.latitude) && Number.isFinite(sale.longitude))
      .slice(0, 80);

    return res.status(200).json({ sales });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "EstateScout backend failed", details: error.message });
  }
}

async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "EstateScout/1.0 contact@example.com"
    }
  });

  if (!response.ok) throw new Error(`Reverse geocode failed: ${response.status}`);

  const json = await response.json();
  const address = json.address || {};

  return {
    zip: address.postcode,
    city: address.city || address.town || address.village || address.suburb,
    stateCode: address.state_code || stateNameToCode(address.state)
  };
}

async function fetchEstateSalesNet({ state, city, zip }) {
  // EstateSales.NET commonly supports city/zip listing pages like:
  // https://www.estatesales.net/CA/Los-Angeles/90026
  const url = `https://www.estatesales.net/${encodeURIComponent(state)}/${encodeURIComponent(city)}/${encodeURIComponent(zip)}`;
  const html = await fetchHTML(url);

  // This intentionally uses broad regex because public page markup changes often.
  // Good enough for a prototype; replace with a paid/approved data feed for production.
  const blocks = html
    .split(/(?:Listed by|Last modified|\d+ Pictures\.)/i)
    .map(stripTags)
    .map(cleanText)
    .filter((text) => text.length > 40)
    .slice(0, 30);

  return blocks.map((text, index) => {
    const title = extractTitle(text) || `Estate Sale ${index + 1}`;
    const address = extractAddress(text) || "Address listed on source site";
    const dateText = extractDateText(text) || "See listing for dates";
    const distanceMiles = extractDistance(text) ?? 0;
    const pseudo = pseudoCoordinateFromIndex(index, 34.0522, -118.2437);

    return {
      id: cryptoRandomUUID(),
      title,
      address,
      city: city.replaceAll("-", " "),
      dateText,
      distanceMiles,
      latitude: pseudo.latitude,
      longitude: pseudo.longitude,
      sourceName: "EstateSales.NET",
      sourceURLString: url
    };
  });
}

async function fetchEstateSalesOrg({ state, city, zip }) {
  // EstateSales.org pages commonly look like:
  // https://estatesales.org/estate-sales/ca/los-angeles/90026
  const url = `https://estatesales.org/estate-sales/${state.toLowerCase()}/${city.toLowerCase()}/${zip}`;
  const html = await fetchHTML(url);

  const blocks = html
    .split(/(?:View photos|Estate Sale|Auction|Listed)/i)
    .map(stripTags)
    .map(cleanText)
    .filter((text) => text.length > 40)
    .slice(0, 30);

  return blocks.map((text, index) => {
    const title = extractTitle(text) || `Estate Sale ${index + 1}`;
    const address = extractAddress(text) || "Address listed on source site";
    const dateText = extractDateText(text) || "See listing for dates";
    const distanceMiles = extractDistance(text) ?? 0;
    const pseudo = pseudoCoordinateFromIndex(index + 40, 34.0522, -118.2437);

    return {
      id: cryptoRandomUUID(),
      title,
      address,
      city: city.replaceAll("-", " "),
      dateText,
      distanceMiles,
      latitude: pseudo.latitude,
      longitude: pseudo.longitude,
      sourceName: "EstateSales.org",
      sourceURLString: url
    };
  });
}

async function fetchApifySales({ lat, lng, radius }) {
  // This calls an Apify actor synchronously and returns its dataset items.
  // Set these in Vercel Environment Variables:
  // APIFY_TOKEN=your_token
  // APIFY_ACTOR_ID=username~actor-name
  //
  // You may need to adjust input shape depending on the actor you choose.
  const actorId = encodeURIComponent(process.env.APIFY_ACTOR_ID);
  const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${process.env.APIFY_TOKEN}&format=json`;

  const input = {
    query: `estate sales near ${lat},${lng}`,
    latitude: lat,
    longitude: lng,
    radiusMiles: radius,
    maxItems: 50
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error(`Apify actor failed: ${response.status}`);
  }

  const items = await response.json();

  return items.map((item, index) => normalizeApifyItem(item, index));
}

function normalizeApifyItem(item, index) {
  const lat = Number(item.latitude || item.lat || item.location?.lat);
  const lng = Number(item.longitude || item.lng || item.location?.lng);
  const pseudo = pseudoCoordinateFromIndex(index + 80, 34.0522, -118.2437);

  return {
    id: cryptoRandomUUID(),
    title: String(item.title || item.name || `Estate Sale ${index + 1}`),
    address: String(item.address || item.location?.address || "Address listed on source site"),
    city: String(item.city || item.location?.city || "Nearby"),
    dateText: String(item.dateText || item.date || item.time || "See listing for dates"),
    distanceMiles: Number(item.distanceMiles || item.distance || 0),
    latitude: Number.isFinite(lat) ? lat : pseudo.latitude,
    longitude: Number.isFinite(lng) ? lng : pseudo.longitude,
    sourceName: "Apify Feed",
    sourceURLString: item.url || item.link || "https://apify.com"
  };
}

async function fetchHTML(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 EstateScoutBot/1.0",
      "Accept": "text/html"
    }
  });

  if (!response.ok) throw new Error(`Fetch failed ${response.status}: ${url}`);
  return await response.text();
}

function dedupeSales(sales) {
  const seen = new Set();
  const unique = [];

  for (const sale of sales) {
    const key = `${sale.title}|${sale.address}`.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(sale);
  }

  return unique;
}

function extractTitle(text) {
  const cleaned = cleanText(text);
  const match = cleaned.match(/^(.{8,90}?)(?:\s+Listed by|\s+Last modified|\s+\d+ Pictures|\s+\d+ miles|\s+May|\s+Jun|\s+Jul|\s+Aug|\s+Sep|\s+Oct|\s+Nov|\s+Dec|\s+Jan|\s+Feb|\s+Mar|\s+Apr)/i);
  return match?.[1]?.trim();
}

function extractAddress(text) {
  const match = text.match(/\d{2,6}\s+[a-z0-9 .#-]+\s+(?:ave|avenue|st|street|blvd|boulevard|dr|drive|rd|road|ln|lane|way|court|ct|place|pl)\b[^.]{0,80}/i);
  return match ? cleanText(match[0]) : null;
}

function extractDateText(text) {
  const match = text.match(/(?:Today|Tomorrow|Ends Today|Going on Now|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Jan|Feb|Mar|Apr)[^.!?]{0,90}/i);
  return match ? cleanText(match[0]) : null;
}

function extractDistance(text) {
  const match = text.match(/(\d+(?:\.\d+)?)\s+miles?\s+away/i);
  return match ? Number(match[1]) : null;
}

function stripTags(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function cleanText(text) {
  return String(text)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function slugCity(city) {
  return String(city || "Los Angeles")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "Los-Angeles";
}

function stateNameToCode(stateName) {
  const states = {
    California: "CA",
    "New York": "NY",
    Texas: "TX",
    Florida: "FL",
    Illinois: "IL",
    Pennsylvania: "PA",
    Ohio: "OH",
    Georgia: "GA",
    Michigan: "MI",
    Washington: "WA",
    Oregon: "OR",
    Nevada: "NV",
    Arizona: "AZ"
  };
  return states[stateName] || "CA";
}

function pseudoCoordinateFromIndex(index, baseLat, baseLng) {
  // Temporary fallback when a page gives a city/zip listing but not exact coordinates.
  // Replace with geocoding of individual addresses once the data source is stable.
  const angle = index * 0.8;
  const distance = 0.01 + (index % 7) * 0.006;
  return {
    latitude: baseLat + Math.sin(angle) * distance,
    longitude: baseLng + Math.cos(angle) * distance
  };
}

function cryptoRandomUUID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
