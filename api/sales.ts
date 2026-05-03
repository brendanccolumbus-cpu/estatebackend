export default async function handler(req: any, res: any) {
  try {
    const lat = Number(req.query.lat || 34.05);
    const lng = Number(req.query.lng || -118.25);
    const radius = Number(req.query.radius || 15);
    const source = String(req.query.source || "all").toLowerCase();

    const place = await reverseGeocodeSafely(lat, lng);
    let sales: any[] = [];

    if (source === "all" || source === "apify") {
      sales.push(...await fetchApifySales(lat, lng, radius));
    }

    if (source === "all" || source === "estatesalesnet") {
      sales.push(...await fetchEstateSalesNet(place, lat, lng, radius));
    }

    if (source === "all" || source === "estatesalesorg") {
      sales.push(...await fetchEstateSalesOrg(place, lat, lng, radius));
    }

    sales = removeDuplicates(sales).slice(0, 60);

    if (sales.length === 0) {
      sales = fallbackSales(lat, lng);
    }

    return res.status(200).json({
      sales,
      meta: {
        app: "EState",
        source,
        searchedNear: place,
        realResultsFound: sales.some((sale) => sale.sourceName !== "Test Data")
      }
    });
  } catch (error: any) {
    return res.status(200).json({
      sales: fallbackSales(Number(req.query.lat || 34.05), Number(req.query.lng || -118.25)),
      meta: {
        app: "EState",
        realResultsFound: false,
        error: String(error?.message || error)
      }
    });
  }
}

async function fetchApifySales(lat: number, lng: number, radius: number) {
  if (!process.env.APIFY_TOKEN || !process.env.APIFY_ACTOR_ID) return [];

  try {
    const actorId = encodeURIComponent(process.env.APIFY_ACTOR_ID);
    const url = `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?token=${process.env.APIFY_TOKEN}&format=json`;

    const input = {
      query: `estate sales near ${lat},${lng}`,
      latitude: lat,
      longitude: lng,
      radiusMiles: radius,
      maxItems: 40
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    });

    if (!response.ok) return [];

    const items = await response.json();

    return (items || []).map((item: any, index: number) => {
      const itemLat = Number(item.latitude || item.lat || item.location?.lat);
      const itemLng = Number(item.longitude || item.lng || item.location?.lng);
      const coord = nearbyCoordinate(lat, lng, index, radius);

      return {
        id: String(item.id || `apify-${index}`),
        title: String(item.title || item.name || `Estate Sale ${index + 1}`),
        address: String(item.address || item.location?.address || "Address on listing"),
        city: String(item.city || item.location?.city || "Nearby"),
        dateText: String(item.dateText || item.date || item.time || "See listing"),
        distanceMiles: Number(item.distanceMiles || item.distance || index + 1),
        latitude: Number.isFinite(itemLat) ? itemLat : coord.latitude,
        longitude: Number.isFinite(itemLng) ? itemLng : coord.longitude,
        sourceName: "Live Scraper",
        sourceURLString: String(item.url || item.link || "https://apify.com")
      };
    });
  } catch {
    return [];
  }
}

async function reverseGeocodeSafely(lat: number, lng: number) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "EState/1.0"
      }
    });

    if (!response.ok) throw new Error("Reverse geocode failed");

    const json = await response.json();
    const address = json.address || {};

    const city = address.city || address.town || address.village || address.suburb || "Los Angeles";
    const state = address.state_code || stateNameToCode(address.state) || "CA";
    const zip = address.postcode || "90026";

    return {
      city,
      citySlug: slugCity(city),
      state,
      zip
    };
  } catch {
    return {
      city: "Los Angeles",
      citySlug: "Los-Angeles",
      state: "CA",
      zip: "90026"
    };
  }
}

async function fetchEstateSalesNet(place: any, lat: number, lng: number, radius: number) {
  try {
    const url = `https://www.estatesales.net/${place.state}/${place.citySlug}/${place.zip}`;
    const html = await fetchText(url);
    return parsePublicListings(html, "EstateSales.NET", url, place.city, lat, lng, radius);
  } catch {
    return [];
  }
}

async function fetchEstateSalesOrg(place: any, lat: number, lng: number, radius: number) {
  try {
    const url = `https://estatesales.org/estate-sales/${String(place.state).toLowerCase()}/${String(place.citySlug).toLowerCase()}/${place.zip}`;
    const html = await fetchText(url);
    return parsePublicListings(html, "EstateSales.org", url, place.city, lat, lng, radius);
  } catch {
    return [];
  }
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 EState/1.0",
      "Accept": "text/html"
    }
  });

  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  return await response.text();
}

function parsePublicListings(
  html: string,
  sourceName: string,
  sourceURLString: string,
  city: string,
  baseLat: number,
  baseLng: number,
  radius: number
) {
  const plainText = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();

  const matches = plainText.match(/.{0,80}(estate sale|moving sale|vintage|auction|sale).{0,180}/gi) || [];

  return matches
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 40)
    .filter((text) => !/cookie|privacy|terms|login|sign up|newsletter/i.test(text))
    .slice(0, 25)
    .map((text, index) => {
      const coord = nearbyCoordinate(baseLat, baseLng, index, radius);

      return {
        id: `${sourceName}-${index}-${Date.now()}`,
        title: makeTitle(text, sourceName, index),
        address: makeAddress(text),
        city,
        dateText: makeDateText(text),
        distanceMiles: Number((0.8 + index * 0.7).toFixed(1)),
        latitude: coord.latitude,
        longitude: coord.longitude,
        sourceName,
        sourceURLString
      };
    });
}

function makeTitle(text: string, sourceName: string, index: number) {
  let title = text.split(" ").slice(0, 12).join(" ").trim();

  if (!/sale|auction|estate/i.test(title)) {
    title = `${sourceName} Listing ${index + 1}`;
  }

  return title.length > 90 ? title.slice(0, 87) + "..." : title;
}

function makeAddress(text: string) {
  const match = text.match(/\d{2,6}\s+[a-z0-9 .#-]+\s+(ave|avenue|st|street|blvd|boulevard|dr|drive|rd|road|ln|lane|way|ct|court|pl|place)/i);
  return match ? match[0].trim() : "Address on source listing";
}

function makeDateText(text: string) {
  const match = text.match(/(today|tomorrow|friday|saturday|sunday|monday|tuesday|wednesday|thursday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[^.!?]{0,80}/i);
  return match ? match[0].trim() : "See listing for dates";
}

function fallbackSales(lat: number, lng: number) {
  return [
    {
      id: "test-1",
      title: "Hollywood Estate Sale",
      address: "123 Sunset Blvd",
      city: "Los Angeles",
      dateText: "Today · 9 AM–3 PM",
      distanceMiles: 2.1,
      latitude: lat + 0.01,
      longitude: lng + 0.01,
      sourceName: "Test Data",
      sourceURLString: "https://example.com"
    },
    {
      id: "test-2",
      title: "Silver Lake Vintage Sale",
      address: "456 Hyperion Ave",
      city: "Silver Lake",
      dateText: "Tomorrow · 10 AM–4 PM",
      distanceMiles: 1.3,
      latitude: lat - 0.01,
      longitude: lng - 0.01,
      sourceName: "Test Data",
      sourceURLString: "https://example.com"
    }
  ];
}

function nearbyCoordinate(lat: number, lng: number, index: number, radiusMiles: number) {
  const angle = index * 0.9;
  const distanceDegrees = Math.min(radiusMiles, 20) / 69 / 4 + index * 0.002;

  return {
    latitude: lat + Math.sin(angle) * distanceDegrees,
    longitude: lng + Math.cos(angle) * distanceDegrees
  };
}

function removeDuplicates(sales: any[]) {
  const seen = new Set();

  return sales.filter((sale) => {
    const key = `${sale.title}-${sale.address}`.toLowerCase().replace(/\s+/g, " ");

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function slugCity(city: string) {
  return String(city || "Los Angeles")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "Los-Angeles";
}

function stateNameToCode(stateName: string) {
  const states: Record<string, string> = {
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
    Arizona: "AZ",
    Colorado: "CO",
    Massachusetts: "MA",
    Connecticut: "CT",
    "New Jersey": "NJ"
  };

  return states[stateName] || "CA";
}
