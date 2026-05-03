// EState Backend
// File path: api/sales.ts
// Vercel URL: https://estatebackend-orpin.vercel.app/api/sales
//
// Sources:
// - Apify Actor: lulzasaur~estate-sales-scraper
// - EstateSales.NET public page fallback
// - EstateSales.org public page fallback
//
// Vercel Environment Variables:
// APIFY_TOKEN = your Apify token
// APIFY_ACTOR_ID = lulzasaur~estate-sales-scraper

export default async function handler(req: any, res: any) {
  try {
    const lat = Number(req.query.lat || 34.05);
    const lng = Number(req.query.lng || -118.25);
    const radius = Number(req.query.radius || 15);
    const source = String(req.query.source || "all").toLowerCase();

    const place = await reverseGeocodeSafely(lat, lng);

    let sales: any[] = [];

    if (source === "all" || source === "apify") {
      const apifySales = await fetchApifySales(place, lat, lng, radius);
      sales.push(...apifySales);
    }

    if (source === "all" || source === "estatesalesnet") {
      const netSales = await fetchEstateSalesNet(place, lat, lng, radius);
      sales.push(...netSales);
    }

    if (source === "all" || source === "estatesalesorg") {
      const orgSales = await fetchEstateSalesOrg(place, lat, lng, radius);
      sales.push(...orgSales);
    }

    sales = removeDuplicates(sales)
      .filter((sale) => Number.isFinite(sale.latitude) && Number.isFinite(sale.longitude))
      .slice(0, 60);

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

// MARK: - Apify Scraper

async function fetchApifySales(place: any, lat: number, lng: number, radius: number) {
  if (!process.env.APIFY_TOKEN || !process.env.APIFY_ACTOR_ID) {
    return [];
  }

  try {
    const actorId = encodeURIComponent(process.env.APIFY_ACTOR_ID);

    const url =
      `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items` +
      `?token=${process.env.APIFY_TOKEN}&format=json`;

    const input = {
      zipCode: place.zip || "90026",
      city: place.city || "",
      state: place.state || "",
      maxResults: 25,
      proxyConfiguration: {
        useApifyProxy: true
      }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    });

    if (!response.ok) {
      return [];
    }

    const items = await response.json();

    if (!Array.isArray(items)) {
      return [];
    }

    return items.map((item: any, index: number) => {
      const itemLat = Number(
        item.latitude ||
        item.lat ||
        item.location?.lat ||
        item.geo?.lat
      );

      const itemLng = Number(
        item.longitude ||
        item.lng ||
        item.location?.lng ||
        item.geo?.lng
      );

      const coord = nearbyCoordinate(lat, lng, index, radius);

      return {
        id: String(item.id || item.url || item.link || `apify-${index}`),
        title: cleanText(
          item.title ||
          item.name ||
          item.saleTitle ||
          item.eventTitle ||
          `Estate Sale ${index + 1}`
        ),
        address: cleanText(
          item.address ||
          item.streetAddress ||
          item.location?.address ||
          item.fullAddress ||
          "Address on listing"
        ),
        city: cleanText(
          item.city ||
          item.location?.city ||
          place.city ||
          "Nearby"
        ),
        dateText: cleanText(
          item.dateText ||
          item.dates ||
          item.date ||
          item.startDate ||
          item.saleDate ||
          "See listing"
        ),
        distanceMiles: Number(item.distanceMiles || item.distance || index + 1),
        latitude: Number.isFinite(itemLat) ? itemLat : coord.latitude,
        longitude: Number.isFinite(itemLng) ? itemLng : coord.longitude,
        sourceName: "Live Scraper",
        sourceURLString: String(
          item.url ||
          item.link ||
          item.sourceURL ||
          "https://www.estatesales.net/"
        )
      };
    });
  } catch {
    return [];
  }
}

// MARK: - Public Source Fallbacks

async function fetchEstateSalesNet(place: any, lat: number, lng: number, radius: number) {
  try {
    const url = `https://www.estatesales.net/${place.state}/${place.citySlug}/${place.zip}`;
    const html = await fetchHTML(url);

    return parsePublicListings({
      html,
      sourceName: "EstateSales.NET",
      sourceURLString: url,
      city: place.city,
      baseLat: lat,
      baseLng: lng,
      radius
    });
  } catch {
    return [];
  }
}

async function fetchEstateSalesOrg(place: any, lat: number, lng: number, radius: number) {
  try {
    const url =
      `https://estatesales.org/estate-sales/` +
      `${String(place.state).toLowerCase()}/` +
      `${String(place.citySlug).toLowerCase()}/` +
      `${place.zip}`;

    const html = await fetchHTML(url);

    return parsePublicListings({
      html,
      sourceName: "EstateSales.org",
      sourceURLString: url,
      city: place.city,
      baseLat: lat,
      baseLng: lng,
      radius
    });
  } catch {
    return [];
  }
}

async function fetchHTML(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 EState/1.0",
      "Accept": "text/html"
    }
  });

  if (!response.ok) {
    throw new Error(`Fetch failed ${response.status}: ${url}`);
  }

  return await response.text();
}

function parsePublicListings(args: {
  html: string;
  sourceName: string;
  sourceURLString: string;
  city: string;
  baseLat: number;
  baseLng: number;
  radius: number;
}) {
  const {
    html,
    sourceName,
    sourceURLString,
    city,
    baseLat,
    baseLng,
    radius
  } = args;

  const plainText = stripHTML(html);

  const matches =
    plainText.match(/.{0,80}(estate sale|moving sale|garage sale|vintage|auction|sale).{0,180}/gi) || [];

  return matches
    .map((text) => cleanText(text))
    .filter((text) => text.length > 40)
    .filter((text) => !/cookie|privacy|terms|login|sign up|newsletter|javascript/i.test(text))
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

// MARK: - Location

async function reverseGeocodeSafely(lat: number, lng: number) {
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse` +
      `?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "EState/1.0"
      }
    });

    if (!response.ok) {
      throw new Error("Reverse geocode failed");
    }

    const json = await response.json();
    const address = json.address || {};

    const city =
      address.city ||
      address.town ||
      address.village ||
      address.suburb ||
      address.county ||
      "Los Angeles";

    const state =
      address.state_code ||
      stateNameToCode(address.state) ||
      "CA";

    const zip =
      address.postcode ||
      "90026";

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

// MARK: - Helpers

function makeTitle(text: string, sourceName: string, index: number) {
  let title = cleanText(text)
    .split(" ")
    .slice(0, 12)
    .join(" ")
    .trim();

  if (!/sale|auction|estate/i.test(title)) {
    title = `${sourceName} Listing ${index + 1}`;
  }

  return title.length > 90 ? title.slice(0, 87) + "..." : title;
}

function makeAddress(text: string) {
  const match = text.match(
    /\d{2,6}\s+[a-z0-9 .#-]+\s+(ave|avenue|st|street|blvd|boulevard|dr|drive|rd|road|ln|lane|way|ct|court|pl|place)/i
  );

  return match ? cleanText(match[0]) : "Address on source listing";
}

function makeDateText(text: string) {
  const match = text.match(
    /(today|tomorrow|friday|saturday|sunday|monday|tuesday|wednesday|thursday|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[^.!?]{0,80}/i
  );

  return match ? cleanText(match[0]) : "See listing for dates";
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

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function stripHTML(html: string) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: any) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
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
    Alabama: "AL",
    Alaska: "AK",
    Arizona: "AZ",
    Arkansas: "AR",
    California: "CA",
    Colorado: "CO",
    Connecticut: "CT",
    Delaware: "DE",
    Florida: "FL",
    Georgia: "GA",
    Hawaii: "HI",
    Idaho: "ID",
    Illinois: "IL",
    Indiana: "IN",
    Iowa: "IA",
    Kansas: "KS",
    Kentucky: "KY",
    Louisiana: "LA",
    Maine: "ME",
    Maryland: "MD",
    Massachusetts: "MA",
    Michigan: "MI",
    Minnesota: "MN",
    Mississippi: "MS",
    Missouri: "MO",
    Montana: "MT",
    Nebraska: "NE",
    Nevada: "NV",
    "New Hampshire": "NH",
    "New Jersey": "NJ",
    "New Mexico": "NM",
    "New York": "NY",
    "North Carolina": "NC",
    "North Dakota": "ND",
    Ohio: "OH",
    Oklahoma: "OK",
    Oregon: "OR",
    Pennsylvania: "PA",
    "Rhode Island": "RI",
    "South Carolina": "SC",
    "South Dakota": "SD",
    Tennessee: "TN",
    Texas: "TX",
    Utah: "UT",
    Vermont: "VT",
    Virginia: "VA",
    Washington: "WA",
    "West Virginia": "WV",
    Wisconsin: "WI",
    Wyoming: "WY"
  };

  return states[stateName] || "CA";
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
