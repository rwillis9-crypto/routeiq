import { useState, useEffect, useRef, useCallback } from "react";
import L from "leaflet";
import {
  MapPin, Calendar, Sparkles, Save, History, Upload, Trash2,
  X, Check, Navigation, AlertCircle, Key, Settings, Pause, Play
} from "lucide-react";

// ─── Constants ───────────────────────────────────────────────────────────────
const CATEGORY_COLORS = [
  "#f59e0b", "#ef4444", "#3b82f6", "#10b981", "#a855f7",
  "#ec4899", "#f97316", "#06b6d4", "#84cc16", "#8b5cf6",
];

const fmtDate = (d) =>
  new Date(d + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric"
  });

const todayStr = () => new Date().toISOString().split("T")[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Storage wrapper (localStorage) ──────────────────────────────────────────
const storage = {
  get: (key) => {
    const v = localStorage.getItem("routeiq:" + key);
    return v ? { value: v } : null;
  },
  set: (key, value) => localStorage.setItem("routeiq:" + key, value),
  delete: (key) => localStorage.removeItem("routeiq:" + key),
};

// ─── KML Parser ──────────────────────────────────────────────────────────────
function parseKML(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const folders = doc.getElementsByTagName("Folder");
  const result = [];

  const grabPlacemarks = (el, folderName) => {
    const placemarks = el.getElementsByTagName("Placemark");
    for (const pm of placemarks) {
      let parent = pm.parentNode;
      let parentFolder = null;
      while (parent && parent !== el) {
        if (parent.tagName === "Folder") { parentFolder = parent; break; }
        parent = parent.parentNode;
      }
      if (parentFolder && parentFolder !== el) continue;

      const name = pm.getElementsByTagName("name")[0]?.textContent?.trim() || "Unknown";
      let address = pm.getElementsByTagName("address")[0]?.textContent?.trim() || "";

      const ext = {};
      for (const d of pm.getElementsByTagName("Data")) {
        const k = d.getAttribute("name");
        const v = d.getElementsByTagName("value")[0]?.textContent?.trim();
        if (k && v) ext[k] = v;
      }
      if (!address && ext.Street) {
        address = [ext.Street, ext.City, ext.State, ext.Zip].filter(Boolean).join(", ");
      }

      let lat = null, lng = null;
      const c = pm.getElementsByTagName("coordinates")[0];
      if (c?.textContent) {
        const p = c.textContent.trim().split(",");
        if (p.length >= 2) {
          const lo = parseFloat(p[0]);
          const la = parseFloat(p[1]);
          if (!isNaN(la) && !isNaN(lo) && (la !== 0 || lo !== 0)) { lat = la; lng = lo; }
        }
      }
      result.push({ id: "loc_" + result.length, name, address, category: folderName, lat, lng });
    }
  };

  if (folders.length > 0) {
    for (const f of folders) {
      const fn = f.getElementsByTagName("name")[0]?.textContent?.trim() || "Uncategorized";
      grabPlacemarks(f, fn);
    }
  } else {
    grabPlacemarks(doc, "All Locations");
  }
  return result;
}

// ─── Geocoding (Nominatim) ───────────────────────────────────────────────────
async function geocodeAddress(address) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`;
  try {
    const res = await fetch(url, { headers: { "Accept-Language": "en" } });
    const data = await res.json();
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch {}
  return null;
}

// ─── AI Trip Planning via Groq ──────────────────────────────────────────────
async function callGroqAI(apiKey, prompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: "You are a sales route optimization assistant. Always respond with valid JSON only, no markdown formatting, no code blocks." },
        { role: "user", content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: "json_object" },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "API error");
  const text = data.choices?.[0]?.message?.content || "";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ─── KML Diff / Sync ─────────────────────────────────────────────────────────
function diffKML(existingLocs, newLocs) {
  // Match by name + address (normalized) as the unique key
  const normalize = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const key = (loc) => `${normalize(loc.name)}||${normalize(loc.address)}`;

  const existingMap = new Map(existingLocs.map((l) => [key(l), l]));
  const newMap      = new Map(newLocs.map((l) => [key(l), l]));

  const added   = newLocs.filter((l) => !existingMap.has(key(l)));
  const removed = existingLocs.filter((l) => !newMap.has(key(l)));

  // Category changes for existing locations
  const changed = newLocs.filter((l) => {
    const existing = existingMap.get(key(l));
    return existing && existing.category !== l.category;
  }).map((l) => ({
    loc: l,
    oldCategory: existingMap.get(key(l)).category,
    newCategory: l.category,
    existingId: existingMap.get(key(l)).id,
    existingCoords: { lat: existingMap.get(key(l)).lat, lng: existingMap.get(key(l)).lng },
  }));

  // Merge: keep existing coords for unchanged, apply new category for changed, add new
  const merged = newLocs.map((l) => {
    const existing = existingMap.get(key(l));
    if (existing) {
      // Preserve existing id and coords, update category if changed
      return { ...existing, category: l.category, name: l.name };
    }
    return l; // new location, needs geocoding
  });

  return { added, removed, changed, merged };
}

// ─── Local Routing (Fallback - no API needed) ────────────────────────────────
function planTripLocally(pool, numStops, startCoord) {
  // Greedy nearest-neighbor algorithm
  const n = parseInt(numStops);
  const start = startCoord || { lat: 33.7490, lng: -84.3880 };

  const distance = (a, b) => {
    const dLat = a.lat - b.lat;
    const dLng = a.lng - b.lng;
    return Math.sqrt(dLat * dLat + dLng * dLng);
  };

  const available = [...pool].filter(l => l.lat && l.lng);
  const route = [];
  let current = start;

  for (let i = 0; i < n && available.length > 0; i++) {
    available.sort((a, b) => distance(current, a) - distance(current, b));
    const next = available.shift();
    route.push({
      id: next.id,
      name: next.name,
      address: next.address,
      note: i === 0 ? "Closest to start" : `Closest from previous stop`,
    });
    current = next;
  }

  return {
    reasoning: `Built a ${route.length}-stop route using nearest-neighbor algorithm starting from your origin. Stops are ordered to minimize total drive distance.`,
    route,
    tips: "This route was built locally without AI. Add your Groq API key for smarter routing that considers priority, time-of-day, and your notes.",
  };
}

// ─── Drive time estimation (straight-line × road factor ÷ avg speed) ─────────
// Returns estimated minutes between two lat/lng points
function estimateDriveMinutes(a, b, avgSpeedMph = 40, roadFactor = 1.35) {
  if (!a || !b || !a.lat || !b.lat) return 0;
  const R = 3958.8; // Earth radius miles
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const sin_dLat = Math.sin(dLat / 2);
  const sin_dLng = Math.sin(dLng / 2);
  const c = 2 * Math.asin(Math.sqrt(
    sin_dLat * sin_dLat +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sin_dLng * sin_dLng
  ));
  const distMiles = R * c * roadFactor;
  return Math.round((distMiles / avgSpeedMph) * 60);
}

function timeToMinutes(t) {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(m) {
  const h = Math.floor(m / 60) % 24;
  const min = m % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function formatTime12(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

// Build a timed schedule from a route, respecting pinned appointment times
function buildSchedule(route, locMap, startCoord, dayStartTime, mustHitTimes, mustHitDuration, visitDurationMin = 30) {
  let schedule = [];
  let currentTime = timeToMinutes(dayStartTime);
  let currentCoord = startCoord;

  // Sort route to respect pinned times — fixed appointments are anchors
  const pinnedStops = route
    .map((s, i) => ({ ...s, origIdx: i, pinnedTime: mustHitTimes[s.id] ? timeToMinutes(mustHitTimes[s.id]) : null }))
    .filter(s => s.pinnedTime !== null)
    .sort((a, b) => a.pinnedTime - b.pinnedTime);

  // Build ordered list: free stops → first anchor → free stops → second anchor → etc.
  const freeStops = route.filter(s => !mustHitTimes[s.id]);
  const anchors = route.filter(s => mustHitTimes[s.id])
    .sort((a, b) => timeToMinutes(mustHitTimes[a.id]) - timeToMinutes(mustHitTimes[b.id]));

  // Interleave: assign free stops to slots between anchors based on geography
  const orderedRoute = [];
  let freeIdx = 0;

  const getCoord = (locId) => {
    const loc = locMap[locId];
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  };

  for (let ai = 0; ai <= anchors.length; ai++) {
    const nextAnchor = anchors[ai];
    const nextAnchorTime = nextAnchor ? timeToMinutes(mustHitTimes[nextAnchor.id]) : Infinity;

    // Add free stops that fit before next anchor
    while (freeIdx < freeStops.length) {
      const stop = freeStops[freeIdx];
      const stopCoord = getCoord(stop.id);
      const driveToStop = estimateDriveMinutes(currentCoord, stopCoord);
      const stopDuration = mustHitDuration[stop.id] || visitDurationMin;
      const timeAfterStop = currentTime + driveToStop + stopDuration;

      // Check if we can fit this stop before the next anchor (with 15min buffer)
      if (nextAnchor) {
        const anchorCoord = getCoord(nextAnchor.id);
        const driveToAnchor = estimateDriveMinutes(stopCoord, anchorCoord);
        if (timeAfterStop + driveToAnchor + 15 > nextAnchorTime) break; // won't make it
      }

      orderedRoute.push(stop);
      freeIdx++;
      currentTime = timeAfterStop;
      currentCoord = stopCoord;
    }

    if (nextAnchor) orderedRoute.push(nextAnchor);
  }

  // Any remaining free stops go at the end
  while (freeIdx < freeStops.length) {
    orderedRoute.push(freeStops[freeIdx++]);
  }

  // Now compute arrival/departure times along the ordered route
  currentTime = timeToMinutes(dayStartTime);
  currentCoord = startCoord;

  for (const stop of orderedRoute) {
    const stopCoord = getCoord(stop.id);
    const driveMin = estimateDriveMinutes(currentCoord, stopCoord);
    let arrivalTime = currentTime + driveMin;

    // If this is a pinned appointment, we must arrive by its time
    const pinnedTime = mustHitTimes[stop.id] ? timeToMinutes(mustHitTimes[stop.id]) : null;
    const isPinned = pinnedTime !== null;

    // If we'd arrive too early for pinned, wait; if too late, flag warning
    let warning = null;
    if (isPinned) {
      if (arrivalTime > pinnedTime + 10) {
        warning = `⚠️ Running ~${arrivalTime - pinnedTime} min late`;
      } else if (arrivalTime < pinnedTime - 30) {
        arrivalTime = pinnedTime; // arrive right on time, no point showing up 45min early
      }
    }

    const duration = mustHitDuration[stop.id] || visitDurationMin;
    const departureTime = arrivalTime + duration;

    schedule.push({
      id: stop.id,
      name: stop.name,
      address: stop.address,
      note: stop.note,
      driveMin,
      arrivalTime: minutesToTime(arrivalTime),
      departureTime: minutesToTime(departureTime),
      duration,
      isPinned,
      pinnedTime: isPinned ? mustHitTimes[stop.id] : null,
      warning,
    });

    currentTime = departureTime;
    currentCoord = stopCoord;
  }

  const totalDriveMin = schedule.reduce((s, x) => s + x.driveMin, 0);
  const endTime = schedule.length > 0 ? schedule[schedule.length - 1].departureTime : dayStartTime;

  return { schedule, totalDriveMin, endTime };
}

// ─── App Component ───────────────────────────────────────────────────────────
export default function App() {
  // ─── State ──
  const [tab, setTab] = useState("locations");
  const [locs, setLocs] = useState([]);
  const [history, setHistory] = useState([]);
  const [selTrip, setSelTrip] = useState(null);
  const [categoryColors, setCategoryColors] = useState({});
  const [mapSel, setMapSel] = useState([]);
  const [mapFilter, setMapFilter] = useState("All");

  // Trip planner state
  const [tripDate, setTripDate] = useState(todayStr());
  const [startLoc, setStartLoc] = useState("Atlanta, GA");
  const [startCoord, setStartCoord] = useState(null);
  const [numStops, setNumStops] = useState("6");
  const [areaFocus, setAreaFocus] = useState("");
  const [notes, setNotes] = useState("");
  const [filterCat, setFilterCat] = useState("All");

  // Must-hit + fill-with structured planner
  const [mustHitIds, setMustHitIds] = useState([]);
  const [mustHitTimes, setMustHitTimes] = useState({}); // { locId: "10:00" }
  const [mustHitDuration, setMustHitDuration] = useState({}); // { locId: 30 } minutes
  const [fillRules, setFillRules] = useState([]);
  const [planMode, setPlanMode] = useState("smart");
  const [fillCatInput, setFillCatInput] = useState("");
  const [fillCountInput, setFillCountInput] = useState("2");
  const [dayStart, setDayStart] = useState("08:00");
  const [dayEnd, setDayEnd] = useState("17:00");
  const [scheduleResult, setScheduleResult] = useState(null); // timed schedule
  const [navApp, setNavApp] = useState(() => storage.get("navApp")?.value || "google");
  const [showNavPicker, setShowNavPicker] = useState(false);
  const [navPickerStop, setNavPickerStop] = useState(null); // { name, address, lat, lng }

  const [aiResult, setAiResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [geoProgress, setGeoProgress] = useState({ active: false, done: 0, total: 0, found: 0 });
  const [mapReady, setMapReady] = useState(false);
  const [apiKey, setApiKey] = useState("");

  // KML sync state
  const [syncPreview, setSyncPreview] = useState(null); // { added, removed, changed, merged }
  const [syncLoading, setSyncLoading] = useState(false);

  const geocodeStop = useRef(false);
  const mapDiv = useRef(null);
  const leafletMap = useRef(null);
  const markers = useRef({});
  const selRef = useRef(mapSel);
  selRef.current = mapSel;

  // ─── Helpers ──
  const showToast = (msg, kind = "ok") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2800);
  };

  const assignCategoryColors = (locations) => {
    const cats = [...new Set(locations.map((l) => l.category))];
    const colors = {};
    cats.forEach((c, i) => { colors[c] = CATEGORY_COLORS[i % CATEGORY_COLORS.length]; });
    setCategoryColors(colors);
  };

  // ─── Load saved data on mount ──
  useEffect(() => {
    try {
      const lr = storage.get("locations");
      if (lr) {
        const parsed = JSON.parse(lr.value);
        setLocs(parsed);
        assignCategoryColors(parsed);
        if (parsed.length > 0) setTab("map");
      }
    } catch {}
    try {
      const hr = storage.get("tripHistory");
      if (hr) setHistory(JSON.parse(hr.value));
    } catch {}
    const k = storage.get("groqKey");
    if (k) setApiKey(k.value);
  }, []);

  const persistLocs = (data) => {
    try {
      const json = JSON.stringify(data);
      if (json.length < 4500000) storage.set("locations", json);
      else showToast("Data too large for storage", "warn");
    } catch (e) { console.error(e); }
  };
  const persistHistory = (h) => storage.set("tripHistory", JSON.stringify(h));
  const saveApiKey = (k) => { setApiKey(k); storage.set("groqKey", k); };

  // ─── Navigation helpers ──
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = () => /Android/.test(navigator.userAgent);
  const isMobile = () => isIOS() || isAndroid();

  const NAV_APPS = [
    { id: "google", label: "Google Maps", icon: "🗺️", color: "#4285f4" },
    { id: "waze",   label: "Waze",        icon: "🚗", color: "#33ccff" },
    { id: "apple",  label: "Apple Maps",  icon: "🍎", color: "#555", iosOnly: true },
  ];

  const buildNavUrl = (app, stop, fullRoute = null) => {
    const enc = (s) => encodeURIComponent(s || "");
    if (app === "google") {
      if (fullRoute && fullRoute.length > 1) {
        // Multi-stop route: origin → waypoints → destination
        const origin = enc(fullRoute[0].address);
        const dest   = enc(fullRoute[fullRoute.length - 1].address);
        const waypts = fullRoute.slice(1, -1).map(s => enc(s.address)).join("|");
        return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}${waypts ? "&waypoints=" + waypts : ""}&travelmode=driving`;
      }
      // Single stop — use lat/lng if available for accuracy
      if (stop?.lat && stop?.lng) {
        return `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}&travelmode=driving`;
      }
      return `https://www.google.com/maps/dir/?api=1&destination=${enc(stop?.address)}&travelmode=driving`;
    }
    if (app === "waze") {
      if (fullRoute && fullRoute.length > 1) {
        // Waze doesn't natively support multi-stop, open to first stop and user adds rest
        const first = fullRoute[0];
        return first.lat
          ? `https://waze.com/ul?ll=${first.lat},${first.lng}&navigate=yes`
          : `https://waze.com/ul?q=${enc(first.address)}&navigate=yes`;
      }
      if (stop?.lat && stop?.lng) {
        return `https://waze.com/ul?ll=${stop.lat},${stop.lng}&navigate=yes`;
      }
      return `https://waze.com/ul?q=${enc(stop?.address)}&navigate=yes`;
    }
    if (app === "apple") {
      if (fullRoute && fullRoute.length > 1) {
        const dest = fullRoute[fullRoute.length - 1];
        return dest.lat
          ? `maps://maps.apple.com/?daddr=${dest.lat},${dest.lng}&dirflg=d`
          : `maps://maps.apple.com/?daddr=${enc(dest.address)}&dirflg=d`;
      }
      if (stop?.lat && stop?.lng) {
        return `maps://maps.apple.com/?daddr=${stop.lat},${stop.lng}&dirflg=d`;
      }
      return `maps://maps.apple.com/?daddr=${enc(stop?.address)}&dirflg=d`;
    }
    return "#";
  };

  const navigateTo = (stop, useFullRoute = false) => {
    const route = useFullRoute && scheduleResult?.schedule
      ? scheduleResult.schedule.map(s => {
          const loc = locs.find(l => l.id === s.id);
          return { address: s.address, lat: loc?.lat, lng: loc?.lng };
        })
      : null;
    const url = buildNavUrl(navApp, stop, route);
    window.open(url, "_blank");
  };

  const openNavPicker = (stop) => {
    setNavPickerStop(stop);
    setShowNavPicker(true);
  };

  const saveNavApp = (app) => {
    setNavApp(app);
    storage.set("navApp", app);
    setShowNavPicker(false);
    if (navPickerStop) navigateTo(navPickerStop);
  };

  // ─── Map init ──
  useEffect(() => {
    if (tab !== "map") return;
    let cancelled = false;

    const init = async () => {
      let attempts = 0;
      while (!mapDiv.current || mapDiv.current.offsetHeight === 0) {
        if (attempts++ > 50) return;
        await sleep(50);
        if (cancelled) return;
      }
      if (leafletMap.current) {
        leafletMap.current.invalidateSize();
        setMapReady(true);
        return;
      }
      const map = L.map(mapDiv.current, { zoomControl: true, preferCanvas: true })
        .setView([33.7490, -84.3880], 7);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        attribution: "© OpenStreetMap © CARTO",
        subdomains: "abcd",
        maxZoom: 19,
      }).addTo(map);
      leafletMap.current = map;

      setTimeout(() => {
        map.invalidateSize();
        if (locs.length > 0) {
          const pts = locs.filter((l) => l.lat && l.lng).map((l) => [l.lat, l.lng]);
          if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 11 });
        }
      }, 100);
      setMapReady(true);
      renderMarkers();
    };
    init();
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [tab]);

  // ─── Render markers ──
  const renderMarkers = useCallback(() => {
    if (!leafletMap.current) return;
    Object.values(markers.current).forEach((m) => leafletMap.current.removeLayer(m));
    markers.current = {};

    locs.filter((l) => l.lat && l.lng).forEach((loc) => {
      const col = categoryColors[loc.category] || "#888";
      const icon = L.divIcon({
        className: "",
        html: `<div data-loc-id="${loc.id}" style="width:24px;height:24px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:${col};border:2px solid rgba(0,0,0,.4);box-shadow:0 2px 6px rgba(0,0,0,.5);transition:transform .15s,box-shadow .15s"></div>`,
        iconSize: [24, 24], iconAnchor: [12, 24], popupAnchor: [0, -26],
      });
      const m = L.marker([loc.lat, loc.lng], { icon }).addTo(leafletMap.current);
      markers.current[loc.id] = m;

      const popHtml = () => {
        const isSel = selRef.current.includes(loc.id);
        return `
          <div style="padding:14px 16px;min-width:220px;max-width:280px">
            <div style="font-weight:700;font-size:14px;margin-bottom:3px;line-height:1.3;color:#111">${loc.name}</div>
            <div style="font-size:12px;color:#6b7280;margin-bottom:9px">${loc.address || "No address"}</div>
            <div style="display:flex;gap:5px;margin-bottom:11px;flex-wrap:wrap">
              <span style="padding:2px 8px;border-radius:20px;font-size:11px;background:${col}20;color:${col};border:1px solid ${col}40;font-weight:600">${loc.category}</span>
            </div>
            <button id="pbtn-${loc.id}" style="width:100%;padding:8px;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;background:${isSel ? '#10b981' : col};color:#fff">
              ${isSel ? "✓ Selected" : "+ Add to Trip"}
            </button>
          </div>`;
      };
      m.bindPopup(popHtml(), { maxWidth: 300 });
      m.on("popupopen", () => {
        setTimeout(() => {
          const btn = document.getElementById("pbtn-" + loc.id);
          if (!btn) return;
          btn.onclick = () => {
            setMapSel((prev) => {
              const next = prev.includes(loc.id) ? prev.filter((x) => x !== loc.id) : [...prev, loc.id];
              const b = document.getElementById("pbtn-" + loc.id);
              if (b) {
                b.textContent = next.includes(loc.id) ? "✓ Selected" : "+ Add to Trip";
                b.style.background = next.includes(loc.id) ? "#10b981" : col;
              }
              updateMarkerGlow(loc.id, next.includes(loc.id), col);
              return next;
            });
          };
        }, 40);
      });
    });
  }, [locs, categoryColors]);

  useEffect(() => { if (mapReady) renderMarkers(); }, [locs, categoryColors, mapReady, renderMarkers]);

  const updateMarkerGlow = (id, selected, col) => {
    const m = markers.current[id];
    if (!m) return;
    const el = m.getElement();
    const inner = el?.querySelector("div");
    if (inner) {
      inner.style.boxShadow = selected ? `0 0 0 3px #fff,0 0 0 5px ${col}` : "0 2px 6px rgba(0,0,0,.5)";
      inner.style.transform = selected ? "rotate(-45deg) scale(1.4)" : "rotate(-45deg)";
      inner.style.zIndex = selected ? "9999" : "1";
    }
  };

  useEffect(() => {
    if (!leafletMap.current) return;
    locs.forEach((loc) => {
      const m = markers.current[loc.id];
      if (!m) return;
      const show = mapFilter === "All" || loc.category === mapFilter;
      if (show && !leafletMap.current.hasLayer(m)) m.addTo(leafletMap.current);
      else if (!show && leafletMap.current.hasLayer(m)) leafletMap.current.removeLayer(m);
    });
  }, [mapFilter, locs]);

  useEffect(() => {
    locs.forEach((loc) => {
      const col = categoryColors[loc.category] || "#888";
      updateMarkerGlow(loc.id, mapSel.includes(loc.id), col);
    });
    // eslint-disable-next-line
  }, [mapSel]);

  const flyToRoute = useCallback((route) => {
    if (!leafletMap.current || !route?.length) return;
    const pts = route.map((s) => locs.find((l) => l.id === s.id))
      .filter(Boolean).filter((l) => l.lat && l.lng).map((l) => [l.lat, l.lng]);
    if (pts.length) leafletMap.current.fitBounds(L.latLngBounds(pts), { padding: [50, 50] });
    setTab("map");
  }, [locs]);

  // ─── KML upload — smart sync if existing data, fresh load if not ──
  const handleKMLUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseKML(text);
    if (parsed.length === 0) { showToast("No locations found in KML", "err"); return; }

    if (locs.length === 0) {
      // Fresh load — no existing data
      setLocs(parsed);
      assignCategoryColors(parsed);
      persistLocs(parsed);
      showToast(`Loaded ${parsed.length} locations ✓`);
    } else {
      // Existing data — show diff preview
      const diff = diffKML(locs, parsed);
      setSyncPreview(diff);
    }
  };

  // ─── Apply sync after user confirms ──
  const applySyncPreview = async () => {
    if (!syncPreview) return;
    setSyncLoading(true);
    const { merged, added } = syncPreview;

    // Assign colors for any new categories
    assignCategoryColors(merged);
    setLocs(merged);
    persistLocs(merged);
    setSyncPreview(null);
    setSyncLoading(false);

    if (added.length > 0) {
      showToast(`Sync applied! ${added.length} new location${added.length > 1 ? "s" : ""} need geocoding.`, "warn");
    } else {
      showToast("Map synced successfully ✓");
    }
  };

  const cancelSync = () => setSyncPreview(null);

  // ─── Geocoding ──
  const startGeocoding = async () => {
    geocodeStop.current = false;
    const todo = locs.filter((l) => !l.lat && l.address);
    if (todo.length === 0) { showToast("All locations have coordinates"); return; }
    setGeoProgress({ active: true, done: 0, total: todo.length, found: 0 });
    let working = [...locs];
    let found = 0;

    for (let i = 0; i < todo.length; i++) {
      if (geocodeStop.current) break;
      const loc = todo[i];
      const result = await geocodeAddress(loc.address);
      if (result) {
        const idx = working.findIndex((l) => l.id === loc.id);
        if (idx >= 0) {
          working[idx] = { ...working[idx], lat: result.lat, lng: result.lng };
          found++;
        }
      }
      setGeoProgress({ active: true, done: i + 1, total: todo.length, found });
      if ((i + 1) % 20 === 0) {
        setLocs([...working]);
        persistLocs(working);
      }
      await sleep(1100);
    }
    setLocs(working);
    persistLocs(working);
    setGeoProgress({ active: false, done: todo.length, total: todo.length, found });
    showToast(`Geocoded ${found}/${todo.length} ✓`);
  };
  const stopGeocoding = () => { geocodeStop.current = true; };

  // ─── Plan trip ──
  const filteredLocs = locs.filter((l) => {
    if (filterCat !== "All" && l.category !== filterCat) return false;
    return l.lat && l.lng;
  });

  const addFillRule = () => {
    if (!fillCatInput) return;
    const n = parseInt(fillCountInput);
    if (isNaN(n) || n < 1) return;
    setFillRules(prev => [...prev, { category: fillCatInput, count: n }]);
    setFillCatInput(""); setFillCountInput("2");
  };
  const removeFillRule = (i) => setFillRules(prev => prev.filter((_, idx) => idx !== i));
  const toggleMustHit = (id) => setMustHitIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const clearMustHits = () => setMustHitIds([]);

  const planTrip = useCallback(async () => {
    setLoading(true);
    setAiResult(null);

    // Build pools based on mode
    let mustHitLocs = [];
    let fillPool = [];
    let totalStops = parseInt(numStops);

    if (planMode === "structured") {
      mustHitLocs = locs.filter(l => mustHitIds.includes(l.id) && l.lat && l.lng);
      const fillCats = fillRules.map(r => r.category);
      fillPool = locs.filter(l => l.lat && l.lng && fillCats.includes(l.category) && !mustHitIds.includes(l.id));
      const fillTotal = fillRules.reduce((sum, r) => sum + r.count, 0);
      totalStops = mustHitLocs.length + fillTotal;
    } else {
      fillPool = mapSel.length > 0 ? locs.filter(l => mapSel.includes(l.id)) : filteredLocs;
    }

    const allPool = planMode === "structured" ? [...mustHitLocs, ...fillPool] : fillPool;

    if (allPool.length === 0) {
      showToast("No locations available", "err");
      setLoading(false);
      return;
    }

    if (apiKey) {
      try {
        const mustList = mustHitLocs.slice(0, 50).map(l =>
          `- [MUST HIT] ID:${l.id} | ${l.name} | ${l.address} | Cat:${l.category}`
        ).join("\n");

        let fillSection = "";
        if (planMode === "structured" && fillRules.length > 0) {
          fillSection = fillRules.map(r => {
            const pool = fillPool.filter(l => l.category === r.category).slice(0, 40);
            return `\nFill ${r.count} from ${r.category}:\n` +
              pool.map(l => `- ID:${l.id} | ${l.name} | ${l.address} | Cat:${l.category}`).join("\n");
          }).join("\n");
        } else {
          fillSection = "Available locations:\n" + allPool.slice(0, 80).map(l =>
            `- ID:${l.id} | ${l.name} | ${l.address} | Cat:${l.category}`
          ).join("\n");
        }

        // Build time constraints string for prompt
        const timedStops = Object.entries(mustHitTimes).map(([id, time]) => {
          const loc = locs.find(l => l.id === id);
          if (!loc) return null;
          const dur = mustHitDuration[id] || 30;
          return `  - "${loc.name}" — FIXED at ${formatTime12(time)} (${dur} min meeting)`;
        }).filter(Boolean).join("\n");

        const timeConstraints = timedStops ? `
TIME CONSTRAINTS — these appointments have fixed times and cannot move:
${timedStops}

Working hours: ${formatTime12(dayStart)} – ${formatTime12(dayEnd)}
Average visit duration (unless specified): 30 minutes
Drive time between stops: ~20-35 min average in Georgia

When ordering the route, ensure fill stops cluster near the fixed appointments geographically so the driver doesn't backtrack. Leave adequate buffer (15+ min) before fixed appointments.` : "";

        const structuredInstructions = planMode === "structured"
          ? `CRITICAL RULES:\n1. ALL [MUST HIT] locations MUST appear in the route — do not drop any.\n2. For each fill group, pick exactly the specified count, choosing locations geographically closest to the must-hits to minimize drive time.\n3. Total route = ${totalStops} stops.${timedStops ? "\n4. FIXED APPOINTMENTS must be respected — build the route around their times." : ""}`
          : `Pick the best ${totalStops} stops. Cluster geographically, minimize backtracking.`;

        const prompt = `You are a sales route optimizer.
Date: ${fmtDate(tripDate)}
Starting from: ${startLoc}
Area focus: ${areaFocus || "None"}
Notes: ${notes || "None"}
${timeConstraints}

${mustList ? "LOCKED STOPS (must include all):\n" + mustList + "\n" : ""}${fillSection}
${structuredInstructions}

Order the complete route as a logical drive from ${startLoc}.
Respond ONLY in JSON:
{"reasoning":"2-3 sentence strategy that references any fixed appointment times","route":[{"id":"id","name":"name","address":"address","note":"LOCKED+TIME or why chosen"}],"tips":"one practical tip about timing or routing"}`;

        const result = await callGroqAI(apiKey, prompt);
        setAiResult(result);

        // Build timed schedule
        const locMap = Object.fromEntries(locs.map(l => [l.id, l]));
        const sc = buildSchedule(
          result.route || [],
          locMap,
          startCoord || { lat: 33.749, lng: -84.388 },
          dayStart,
          mustHitTimes,
          mustHitDuration
        );
        setScheduleResult(sc);

      } catch (e) {
        showToast("AI failed, using local routing: " + e.message, "warn");
        const fallback = planTripLocally(allPool, totalStops, startCoord);
        setAiResult(fallback);
        const locMap = Object.fromEntries(locs.map(l => [l.id, l]));
        setScheduleResult(buildSchedule(fallback.route || [], locMap, startCoord || { lat: 33.749, lng: -84.388 }, dayStart, mustHitTimes, mustHitDuration));
      }
    } else {
      const fallback = planTripLocally(allPool, totalStops, startCoord);
      setAiResult(fallback);
      const locMap = Object.fromEntries(locs.map(l => [l.id, l]));
      setScheduleResult(buildSchedule(fallback.route || [], locMap, startCoord || { lat: 33.749, lng: -84.388 }, dayStart, mustHitTimes, mustHitDuration));
    }

    setLoading(false);
  }, [filteredLocs, locs, mapSel, mustHitIds, mustHitTimes, mustHitDuration, fillRules, planMode, dayStart, dayEnd, tripDate, startLoc, numStops, areaFocus, notes, apiKey, startCoord]);

  // ─── Save / delete trip ──
  const saveTrip = () => {
    if (!aiResult?.route?.length) return;
    const t = {
      id: Date.now().toString(),
      date: tripDate, startLoc, numStops, areaFocus, notes,
      route: aiResult.route, reasoning: aiResult.reasoning, tips: aiResult.tips,
      schedule: scheduleResult,
    };
    const u = [t, ...history];
    setHistory(u);
    persistHistory(u);
    showToast("Trip saved ✓");
  };

  const deleteTrip = (id, e) => {
    e.stopPropagation();
    const u = history.filter((t) => t.id !== id);
    setHistory(u);
    persistHistory(u);
    if (selTrip?.id === id) setSelTrip(null);
  };

  const clearAllData = () => {
    if (!confirm("Delete all locations and trip history?")) return;
    setLocs([]); setHistory([]); setMapSel([]);
    storage.delete("locations");
    storage.delete("tripHistory");
    showToast("Data cleared");
    setTab("locations");
  };

  // ─── Export / import data ──
  const exportData = () => {
    const blob = new Blob([JSON.stringify({ locations: locs, history }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `routeiq-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Backup downloaded ✓");
  };

  const importData = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.locations) {
        setLocs(data.locations);
        assignCategoryColors(data.locations);
        persistLocs(data.locations);
      }
      if (data.history) {
        setHistory(data.history);
        persistHistory(data.history);
      }
      showToast("Data imported ✓");
    } catch {
      showToast("Invalid backup file", "err");
    }
  };

  // ─── Derived ──
  const categories = [...new Set(locs.map((l) => l.category))];
  const geocodedCount = locs.filter((l) => l.lat && l.lng).length;
  const ungeocodedCount = locs.filter((l) => !l.lat && l.address).length;

  const TABS = [
    { id: "map", label: "Map", icon: MapPin },
    { id: "plan", label: "Plan", icon: Sparkles },
    { id: "history", label: "History", icon: History },
    { id: "locations", label: "Data", icon: Settings },
  ];

  // ═════════════════════ RENDER ═════════════════════
  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3 bg-slate-900 border-b border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center text-base">🗺️</div>
          <div>
            <h1 className="font-bold text-base tracking-tight">RouteIQ</h1>
            <div className="text-xs text-slate-400">AI Sales Trip Planner</div>
          </div>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="hidden md:flex gap-5">
            <div><span className="font-bold text-amber-500 mr-1">{locs.length}</span><span className="text-slate-400">Locations</span></div>
            <div><span className="font-bold text-amber-500 mr-1">{geocodedCount}</span><span className="text-slate-400">Mapped</span></div>
            <div><span className="font-bold text-amber-500 mr-1">{history.length}</span><span className="text-slate-400">Trips</span></div>
          </div>
          {/* Nav app preference pill — always visible */}
          <button
            onClick={() => { setNavPickerStop(null); setShowNavPicker(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 border border-slate-700 hover:border-blue-500 rounded-full text-xs font-semibold transition-colors">
            <span>{NAV_APPS.find(a => a.id === navApp)?.icon}</span>
            <span className="text-slate-300 hidden sm:inline">{NAV_APPS.find(a => a.id === navApp)?.label}</span>
          </button>
        </div>
      </header>

      {/* Tabs */}
      <nav className="flex bg-slate-900 border-b border-slate-800 px-2 md:px-5 flex-shrink-0 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex items-center gap-2 px-4 h-11 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              tab === id ? "text-amber-500 border-amber-500" : "text-slate-400 border-transparent hover:text-slate-200"
            }`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </nav>

      {/* MAP */}
      {tab === "map" && (
        <div className="flex-1 grid grid-cols-1 md:grid-cols-[1fr_340px] overflow-hidden">
          <div className="relative bg-slate-900 overflow-hidden">
            <div ref={mapDiv} className="absolute inset-0" />
            {!mapReady && (
              <div className="absolute inset-0 flex items-center justify-center z-50">
                <div className="text-center">
                  <div className="w-8 h-8 border-2 border-slate-700 border-t-amber-500 rounded-full animate-spin mx-auto mb-3" />
                  <div className="text-sm text-slate-400">Loading map…</div>
                </div>
              </div>
            )}
            {mapReady && locs.length > 0 && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] flex flex-wrap gap-2 max-w-[calc(100%-100px)] justify-center">
                <button onClick={() => setMapFilter("All")}
                  className={`px-3 py-1 rounded-full text-xs font-semibold border backdrop-blur transition-colors ${
                    mapFilter === "All" ? "bg-amber-500/20 border-amber-500 text-amber-400" : "bg-slate-900/90 border-slate-700 text-slate-400 hover:border-amber-500"
                  }`}>
                  All ({geocodedCount})
                </button>
                {categories.map((c) => (
                  <button key={c} onClick={() => setMapFilter(c)}
                    className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border backdrop-blur transition-colors whitespace-nowrap ${
                      mapFilter === c ? "bg-amber-500/20 border-amber-500 text-amber-400" : "bg-slate-900/90 border-slate-700 text-slate-400 hover:border-amber-500"
                    }`}>
                    <span className="w-2 h-2 rounded-full" style={{ background: categoryColors[c] }} />
                    {c} ({locs.filter((l) => l.category === c && l.lat).length})
                  </button>
                ))}
              </div>
            )}
            {geoProgress.active && (
              <div className="absolute top-16 right-4 z-[999] bg-slate-900/95 border border-amber-500 rounded-lg p-3 backdrop-blur min-w-[200px]">
                <div className="text-xs font-bold text-amber-500 mb-1 flex items-center gap-1.5"><MapPin size={12} />Geocoding…</div>
                <div className="text-xs text-slate-400">{geoProgress.done} / {geoProgress.total} · {geoProgress.found} found</div>
                <div className="h-1.5 bg-slate-700 rounded mt-2 overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-amber-500 to-orange-600 transition-all" style={{ width: `${(geoProgress.done / geoProgress.total) * 100}%` }} />
                </div>
                <button onClick={stopGeocoding} className="mt-2 w-full px-2 py-1 bg-slate-800 hover:border-red-500 text-red-400 border border-slate-700 rounded text-xs font-semibold flex items-center justify-center gap-1.5">
                  <Pause size={11} />Stop
                </button>
              </div>
            )}
            {mapSel.length > 0 && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[1000] bg-slate-900/95 backdrop-blur border border-amber-500 rounded-lg px-4 py-2.5 flex items-center gap-3 text-sm">
                <span><strong className="text-amber-500 font-bold">{mapSel.length}</strong> selected</span>
                <button onClick={() => setTab("plan")} className="bg-gradient-to-br from-amber-500 to-orange-600 text-black px-3 py-1.5 rounded text-xs font-bold">Plan with these →</button>
                <button onClick={() => setMapSel([])} className="bg-slate-800 text-red-400 border border-slate-700 hover:border-red-500 px-2 py-1.5 rounded text-xs"><X size={14} /></button>
              </div>
            )}
            {mapReady && locs.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center z-50">
                <div className="text-center">
                  <MapPin size={56} className="text-slate-600 mx-auto mb-3" />
                  <div className="text-slate-400 mb-4">No locations loaded yet</div>
                  <button onClick={() => setTab("locations")} className="px-4 py-2 bg-gradient-to-br from-amber-500 to-orange-600 text-black rounded font-bold text-sm">Upload KML →</button>
                </div>
              </div>
            )}
          </div>

          <div className="bg-slate-900 border-l border-slate-800 overflow-y-auto p-3.5 hidden md:block">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">📍 Locations ({geocodedCount})</div>
            <div className="text-xs text-slate-500 mb-2">
              {ungeocodedCount > 0 && <span className="text-amber-500">{ungeocodedCount} need geocoding · </span>}
              Click pin → Add to Trip
            </div>
            {locs.filter((l) => l.lat && l.lng && (mapFilter === "All" || l.category === mapFilter))
              .slice(0, 200).map((loc, i) => {
                const sel = mapSel.includes(loc.id);
                const col = categoryColors[loc.category];
                return (
                  <div key={loc.id}
                    onClick={() => { leafletMap.current?.setView([loc.lat, loc.lng], 14); markers.current[loc.id]?.openPopup(); }}
                    className={`flex items-start gap-2 p-2 rounded-lg cursor-pointer transition-colors mb-1 ${
                      sel ? "bg-amber-500/10 border border-amber-500/30" : "border border-transparent hover:bg-slate-800"
                    }`}>
                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                      style={sel ? { background: "#f59e0b", color: "#000" } : { background: col + "30", color: col }}>
                      {sel ? <Check size={12} /> : i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{loc.name}</div>
                      <div className="text-xs text-slate-500 truncate">{loc.address}</div>
                      <div className="mt-1">
                        <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase" style={{ background: col + "20", color: col }}>{loc.category}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* PLAN */}
      {tab === "plan" && (
        <div className="flex-1 grid grid-cols-1 md:grid-cols-[360px_1fr] overflow-hidden">
          <div className="bg-slate-900 border-r border-slate-800 overflow-y-auto p-3.5 space-y-2.5">
            {locs.length === 0 ? (
              <div className="text-center py-10 text-slate-500">
                <Upload size={48} className="mx-auto mb-3 text-slate-600" />
                <p className="text-sm">Upload your KML first.</p>
                <button onClick={() => setTab("locations")} className="mt-3 px-4 py-2 bg-gradient-to-br from-amber-500 to-orange-600 text-black rounded font-bold text-sm">Go to Data →</button>
              </div>
            ) : (
              <>
                {!apiKey && (
                  <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg px-3 py-2 text-xs text-blue-400 flex items-start gap-2">
                    <Key size={14} className="mt-0.5 flex-shrink-0" />
                    <span>Local routing mode. <button onClick={() => setTab("locations")} className="underline">Add Groq key</button> for smarter AI planning (free).</span>
                  </div>
                )}

                {/* ── Plan Mode Toggle ── */}
                <div className="bg-slate-800 border border-slate-700 rounded-lg p-1 flex gap-1">
                  <button onClick={() => setPlanMode("smart")}
                    className={`flex-1 py-2 rounded text-xs font-semibold transition-all ${planMode === "smart" ? "bg-amber-500 text-black" : "text-slate-400 hover:text-slate-200"}`}>
                    ⚡ Smart Mode
                  </button>
                  <button onClick={() => setPlanMode("structured")}
                    className={`flex-1 py-2 rounded text-xs font-semibold transition-all ${planMode === "structured" ? "bg-amber-500 text-black" : "text-slate-400 hover:text-slate-200"}`}>
                    🎯 Must-Hit + Fill
                  </button>
                </div>

                {planMode === "smart" && mapSel.length > 0 && (
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-xs text-amber-500 flex justify-between items-center">
                    <span>🗺️ {mapSel.length} from map</span>
                    <button onClick={() => setMapSel([])} className="text-slate-400 hover:text-slate-200"><X size={14} /></button>
                  </div>
                )}

                <div className="bg-slate-800 border border-slate-700 rounded-lg p-3.5">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5"><Calendar size={12} />Trip Details</div>
                  <div className="grid grid-cols-2 gap-2 mb-2.5">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Date</label>
                      <input type="date" value={tripDate} onChange={(e) => setTripDate(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm focus:border-amber-500 outline-none" />
                    </div>
                    {planMode === "smart" && (
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Stops</label>
                        <select value={numStops} onChange={(e) => setNumStops(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm focus:border-amber-500 outline-none">
                          {[3, 4, 5, 6, 7, 8, 10, 12].map((n) => <option key={n}>{n}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                  <div className="mb-2.5">
                    <label className="block text-xs text-slate-400 mb-1">Start From</label>
                    <input value={startLoc} onChange={(e) => setStartLoc(e.target.value)} placeholder="e.g. Atlanta, GA" className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm focus:border-amber-500 outline-none" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Area Focus</label>
                    <input value={areaFocus} onChange={(e) => setAreaFocus(e.target.value)} placeholder="e.g. North Atlanta…" className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm focus:border-amber-500 outline-none" />
                  </div>
                </div>

                {/* ── STRUCTURED MODE UI ── */}
                {planMode === "structured" && (
                  <>
                    {/* Must-Hit Selector */}
                    {/* Day hours */}
                    <div className="bg-slate-800 border border-slate-700 rounded-lg p-3.5">
                      <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">🕐 Working Hours</div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">Start time</label>
                          <input type="time" value={dayStart} onChange={e => setDayStart(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm focus:border-amber-500 outline-none" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-400 mb-1">End time</label>
                          <input type="time" value={dayEnd} onChange={e => setDayEnd(e.target.value)}
                            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm focus:border-amber-500 outline-none" />
                        </div>
                      </div>
                    </div>

                    <div className="bg-slate-800 border border-slate-700 rounded-lg p-3.5">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-xs font-bold uppercase tracking-wider text-red-400">🔒 Must-Hit Stops</div>
                        {mustHitIds.length > 0 && (
                          <button onClick={clearMustHits} className="text-xs text-slate-500 hover:text-red-400">Clear all</button>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 mb-2">Lock in required stops. Add a fixed time for appointments — AI schedules everything else around them.</div>
                      {mustHitIds.length > 0 && (
                        <div className="space-y-2 mb-2">
                          {locs.filter(l => mustHitIds.includes(l.id)).map((loc) => {
                            const col = categoryColors[loc.category];
                            const hasTime = !!mustHitTimes[loc.id];
                            return (
                              <div key={loc.id} className={`p-2 rounded border text-xs ${hasTime ? "bg-amber-500/5 border-amber-500/30" : "bg-red-500/5 border-red-500/20"}`}>
                                <div className="flex items-center gap-2 mb-1.5">
                                  <span className="font-bold flex-shrink-0">{hasTime ? "📅" : "🔒"}</span>
                                  <div className="flex-1 min-w-0">
                                    <div className="font-medium truncate">{loc.name}</div>
                                    <div className="text-slate-500 truncate">{loc.address}</div>
                                  </div>
                                  <span className="px-1.5 py-0.5 rounded text-[10px] flex-shrink-0" style={{ background: col + "20", color: col }}>{loc.category}</span>
                                  <button onClick={() => toggleMustHit(loc.id)} className="text-slate-500 hover:text-red-400 flex-shrink-0"><X size={12} /></button>
                                </div>
                                <div className="flex items-center gap-2 pl-5">
                                  <span className="text-slate-500 text-[10px]">Fixed time?</span>
                                  <input type="time"
                                    value={mustHitTimes[loc.id] || ""}
                                    onChange={e => setMustHitTimes(prev => e.target.value ? { ...prev, [loc.id]: e.target.value } : Object.fromEntries(Object.entries(prev).filter(([k]) => k !== loc.id)))}
                                    className="bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] focus:border-amber-500 outline-none w-24" />
                                  <span className="text-slate-500 text-[10px]">Duration</span>
                                  <select value={mustHitDuration[loc.id] || 30}
                                    onChange={e => setMustHitDuration(prev => ({ ...prev, [loc.id]: parseInt(e.target.value) }))}
                                    className="bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] focus:border-amber-500 outline-none">
                                    {[15, 20, 30, 45, 60, 90].map(m => <option key={m} value={m}>{m} min</option>)}
                                  </select>
                                </div>
                                {hasTime && (
                                  <div className="mt-1 pl-5 text-[10px] text-amber-400">
                                    📅 Appointment locked at {formatTime12(mustHitTimes[loc.id])} · AI schedules around this
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <div className="text-xs text-slate-400 mb-1.5">Add from categories:</div>
                      <div className="max-h-36 overflow-y-auto space-y-0.5">
                        {locs.filter(l => l.lat && l.lng && !mustHitIds.includes(l.id)).slice(0, 100).map((loc) => {
                          const col = categoryColors[loc.category];
                          return (
                            <button key={loc.id} onClick={() => toggleMustHit(loc.id)}
                              className="w-full flex items-center gap-2 p-1.5 rounded hover:bg-slate-700 text-left transition-colors">
                              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: col }} />
                              <span className="text-xs text-slate-300 flex-1 truncate">{loc.name}</span>
                              <span className="text-[10px] text-slate-500 flex-shrink-0">{loc.category}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Fill Rules */}
                    <div className="bg-slate-800 border border-slate-700 rounded-lg p-3.5">
                      <div className="text-xs font-bold uppercase tracking-wider text-amber-400 mb-2">🎯 Fill With</div>
                      <div className="text-xs text-slate-500 mb-2">AI picks the best stops from each category to fill out your day.</div>
                      {fillRules.length > 0 && (
                        <div className="space-y-1.5 mb-3">
                          {fillRules.map((rule, i) => {
                            const col = categoryColors[rule.category];
                            const available = locs.filter(l => l.lat && l.lng && l.category === rule.category && !mustHitIds.includes(l.id)).length;
                            return (
                              <div key={i} className="flex items-center gap-2 p-2 bg-amber-500/5 border border-amber-500/20 rounded">
                                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: col }} />
                                <span className="text-xs font-semibold text-slate-200 flex-1">{rule.count} × {rule.category}</span>
                                <span className="text-[10px] text-slate-500">{available} avail.</span>
                                <button onClick={() => removeFillRule(i)} className="text-slate-500 hover:text-red-400"><X size={12} /></button>
                              </div>
                            );
                          })}
                          <div className="text-xs text-slate-400 pt-1 border-t border-slate-700">
                            Total route: <span className="text-amber-400 font-bold">{mustHitIds.length} locked + {fillRules.reduce((s,r)=>s+r.count,0)} fills = {mustHitIds.length + fillRules.reduce((s,r)=>s+r.count,0)} stops</span>
                          </div>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <select value={fillCatInput} onChange={(e) => setFillCatInput(e.target.value)}
                          className="flex-1 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs focus:border-amber-500 outline-none">
                          <option value="">Select category…</option>
                          {categories.filter(c => !fillRules.find(r => r.category === c)).map(c => (
                            <option key={c} value={c}>{c} ({locs.filter(l=>l.category===c&&l.lat&&!mustHitIds.includes(l.id)).length} avail.)</option>
                          ))}
                        </select>
                        <input type="number" min="1" max="20" value={fillCountInput} onChange={(e) => setFillCountInput(e.target.value)}
                          className="w-14 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs focus:border-amber-500 outline-none text-center" />
                        <button onClick={addFillRule} disabled={!fillCatInput}
                          className="px-3 py-1.5 bg-amber-500/20 border border-amber-500/40 text-amber-400 rounded text-xs font-bold hover:bg-amber-500/30 disabled:opacity-40">
                          + Add
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {/* Smart mode filter pool */}
                {planMode === "smart" && mapSel.length === 0 && (
                  <div className="bg-slate-800 border border-slate-700 rounded-lg p-3.5">
                    <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">🔍 Filter Pool</div>
                    <label className="block text-xs text-slate-400 mb-1">Category</label>
                    <div className="flex flex-wrap gap-1.5">
                      <button onClick={() => setFilterCat("All")} className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${filterCat === "All" ? "bg-amber-500/10 border-amber-500 text-amber-500" : "bg-slate-900 border-slate-700 text-slate-400"}`}>All</button>
                      {categories.map((c) => (
                        <button key={c} onClick={() => setFilterCat(c)} className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border transition-colors ${filterCat === c ? "bg-amber-500/10 border-amber-500 text-amber-500" : "bg-slate-900 border-slate-700 text-slate-400"}`}>
                          <span className="w-2 h-2 rounded-full" style={{ background: categoryColors[c] }} />{c}
                        </button>
                      ))}
                    </div>
                    <div className="text-xs text-slate-500 mt-2">{filteredLocs.length} eligible</div>
                  </div>
                )}

                <div className="bg-slate-800 border border-slate-700 rounded-lg p-3.5">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">💬 Notes</div>
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Avoid I-285, prioritize hospital leads…" className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm focus:border-amber-500 outline-none min-h-[68px]" />
                </div>

                <button onClick={planTrip}
                  disabled={loading || (planMode === "smart" ? filteredLocs.length === 0 : mustHitIds.length === 0 && fillRules.length === 0)}
                  className="w-full bg-gradient-to-br from-amber-500 to-orange-600 text-black rounded font-bold py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-50">
                  {loading
                    ? <><div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />Planning…</>
                    : planMode === "structured"
                      ? <><Sparkles size={16} />Build {mustHitIds.length} Locked + {fillRules.reduce((s,r)=>s+r.count,0)} Fills</>
                      : <><Sparkles size={16} />Plan My Trip</>
                  }
                </button>

                {aiResult && !loading && (
                  <div className="bg-slate-800 border border-slate-700 rounded-lg p-3.5">
                    <div className="text-sm font-bold text-emerald-400 mb-2 flex items-center gap-2">
                      <Check size={14} /> Route Ready — {fmtDate(tripDate)}
                    </div>
                    <p className="text-xs text-slate-400 mb-3 leading-relaxed">{aiResult.reasoning}</p>

                    {/* Timed schedule view — shown when schedule exists */}
                    {scheduleResult?.schedule?.length > 0 ? (
                      <>
                        {/* Day summary strip */}
                        <div className="flex items-center gap-3 mb-3 p-2 bg-slate-900 rounded text-xs">
                          <div className="flex-1">
                            <span className="text-slate-400">Depart </span>
                            <span className="font-semibold">{formatTime12(dayStart)}</span>
                            <span className="text-slate-400 mx-2">→</span>
                            <span className="font-semibold">{formatTime12(scheduleResult.endTime)}</span>
                          </div>
                          <div className="text-slate-400">🚗 ~{Math.round(scheduleResult.totalDriveMin / 60)}h {scheduleResult.totalDriveMin % 60}m driving</div>
                          {scheduleResult.schedule.some(s => s.warning) && (
                            <div className="text-red-400 font-semibold">⚠️ Timing conflict</div>
                          )}
                        </div>

                        <ul className="space-y-1.5">
                          {scheduleResult.schedule.map((s, i) => (
                            <li key={i} className={`rounded-lg border text-xs overflow-hidden ${s.isPinned ? "border-amber-500/40 bg-amber-500/5" : "border-slate-700 bg-slate-900/50"}`}>
                              {/* Drive time row */}
                              {s.driveMin > 0 && (
                                <div className="flex items-center gap-2 px-3 py-1 border-b border-slate-700/50">
                                  <span className="text-slate-500">🚗</span>
                                  <span className="text-slate-500">~{s.driveMin} min drive</span>
                                </div>
                              )}
                              {/* Stop row */}
                              <div className="flex items-start gap-2 p-2.5">
                                <div className={`w-6 h-6 rounded-full font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5 ${s.isPinned ? "bg-amber-500 text-black" : "bg-slate-700 text-slate-200"}`}>
                                  {i + 1}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <span className="font-semibold">{s.name}</span>
                                    {s.isPinned && <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-400 font-bold">📅 APPT</span>}
                                  </div>
                                  <div className="text-slate-500 truncate mt-0.5">{s.address}</div>
                                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                                    <span className="text-emerald-400 font-semibold">{formatTime12(s.arrivalTime)}</span>
                                    <span className="text-slate-500">→</span>
                                    <span className="text-slate-400">{formatTime12(s.departureTime)}</span>
                                    <span className="text-slate-600">({s.duration} min)</span>
                                    {s.warning && <span className="text-red-400 font-semibold">{s.warning}</span>}
                                  </div>
                                  {s.isPinned && s.pinnedTime && (
                                    <div className="text-amber-500 text-[10px] mt-0.5">
                                      Fixed appointment: {formatTime12(s.pinnedTime)}
                                    </div>
                                  )}
                                </div>
                                {/* Navigate button */}
                                <button
                                  onClick={() => {
                                    const loc = locs.find(l => l.id === s.id);
                                    openNavPicker({ name: s.name, address: s.address, lat: loc?.lat, lng: loc?.lng });
                                  }}
                                  className="flex-shrink-0 self-center px-2.5 py-1.5 rounded-lg bg-blue-500/15 border border-blue-500/30 text-blue-400 text-[11px] font-semibold hover:bg-blue-500/25 transition-colors flex items-center gap-1">
                                  {NAV_APPS.find(a => a.id === navApp)?.icon} Go
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                        {/* Full route button */}
                        <button
                          onClick={() => {
                            const first = scheduleResult.schedule[0];
                            const loc = locs.find(l => l.id === first.id);
                            navigateTo({ name: first.name, address: first.address, lat: loc?.lat, lng: loc?.lng }, true);
                          }}
                          className="w-full mt-2 py-2.5 rounded-lg bg-blue-500 text-white text-xs font-bold flex items-center justify-center gap-2 hover:bg-blue-600 transition-colors">
                          {NAV_APPS.find(a => a.id === navApp)?.icon} Open Full Route in {NAV_APPS.find(a => a.id === navApp)?.label}
                          {navApp === "waze" && <span className="text-[10px] opacity-70">(1st stop — add rest in app)</span>}
                        </button>
                        <div className="mt-1.5 text-[10px] text-slate-500 text-center">Drive times are estimates · Allow extra buffer in traffic</div>
                      </>
                    ) : (
                      <ul className="space-y-1.5">
                        {aiResult.route?.map((s, i) => {
                          const loc = locs.find(l => l.id === s.id);
                          return (
                            <li key={i} className="flex items-start gap-2 py-1.5 border-b border-slate-700 last:border-0">
                              <div className="w-6 h-6 rounded-full bg-amber-500 text-black font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</div>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium">{s.name}</div>
                                <div className="text-xs text-slate-500">{s.address}</div>
                                {s.note && <div className="text-xs text-slate-600 italic mt-0.5">{s.note}</div>}
                              </div>
                              <button
                                onClick={() => openNavPicker({ name: s.name, address: s.address, lat: loc?.lat, lng: loc?.lng })}
                                className="flex-shrink-0 self-center px-2 py-1 rounded bg-blue-500/15 border border-blue-500/30 text-blue-400 text-[11px] font-semibold hover:bg-blue-500/25 transition-colors">
                                {NAV_APPS.find(a => a.id === navApp)?.icon}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {aiResult.tips && <div className="mt-3 px-3 py-2 bg-amber-500/10 rounded text-xs text-amber-400">💡 {aiResult.tips}</div>}
                    <div className="flex gap-2 mt-3">
                      <button onClick={saveTrip} className="flex-1 bg-slate-900 border border-slate-700 hover:border-amber-500 hover:text-amber-500 rounded py-2 text-xs font-semibold flex items-center justify-center gap-1.5"><Save size={13} />Save</button>
                      <button onClick={() => flyToRoute(aiResult.route)} className="flex-1 bg-slate-900 border border-slate-700 hover:border-amber-500 hover:text-amber-500 rounded py-2 text-xs font-semibold flex items-center justify-center gap-1.5"><MapPin size={13} />Map</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="bg-slate-900 border-l border-slate-800 overflow-y-auto p-3.5 hidden md:block">
            <div className="flex justify-between items-center mb-2">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400">{mapSel.length > 0 ? "🗺️ Map Selected" : "📍 Eligible"}</div>
              <span className="text-xs text-slate-500">{mapSel.length > 0 ? mapSel.length : filteredLocs.length}</span>
            </div>
            {(mapSel.length > 0 ? locs.filter((l) => mapSel.includes(l.id)) : filteredLocs).slice(0, 100).map((loc, i) => {
              const ir = aiResult?.route?.findIndex((r) => r.id === loc.id) ?? -1;
              const col = categoryColors[loc.category];
              return (
                <div key={loc.id} className={`flex items-start gap-2 p-2 rounded-lg mb-1 ${ir >= 0 ? "bg-emerald-500/5 border border-emerald-500/25" : "border border-transparent"}`}>
                  <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0" style={ir >= 0 ? { background: "#10b981", color: "#000" } : { background: col + "30", color: col }}>{ir >= 0 ? ir + 1 : i + 1}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{loc.name}</div>
                    <div className="text-xs text-slate-500 truncate">{loc.address}</div>
                    <div className="mt-1 flex gap-1.5 flex-wrap">
                      <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase" style={{ background: col + "20", color: col }}>{loc.category}</span>
                      {ir >= 0 && <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-emerald-500/20 text-emerald-400">Stop {ir + 1}</span>}
                      {ir >= 0 && mustHitIds.includes(loc.id) && <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-500/20 text-red-400">🔒 Locked</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* HISTORY */}
      {tab === "history" && (
        <div className="flex-1 grid grid-cols-1 md:grid-cols-[360px_1fr] overflow-hidden">
          <div className="bg-slate-900 border-r border-slate-800 overflow-y-auto p-3.5 space-y-2">
            <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">📋 Saved Trips ({history.length})</div>
            {history.length === 0 && (
              <div className="text-center py-10 text-slate-500">
                <Calendar size={48} className="mx-auto mb-3 text-slate-600" />
                <p className="text-sm">No trips saved yet.</p>
              </div>
            )}
            {history.map((trip) => (
              <div key={trip.id} onClick={() => setSelTrip(selTrip?.id === trip.id ? null : trip)}
                className={`bg-slate-800 border rounded-lg p-3 cursor-pointer transition-all ${selTrip?.id === trip.id ? "border-amber-500" : "border-slate-700 hover:border-amber-500"}`}>
                <div className="flex justify-between items-start mb-1">
                  <div>
                    <div className="font-bold text-sm">{fmtDate(trip.date)}</div>
                    <div className="text-xs text-slate-400 mt-0.5">📍 {trip.route?.length} stops · {trip.startLoc}</div>
                  </div>
                  <button onClick={(e) => deleteTrip(trip.id, e)} className="bg-slate-900 border border-slate-700 hover:border-red-500 text-red-400 rounded px-2 py-1"><Trash2 size={12} /></button>
                </div>
                {trip.notes && <div className="text-xs text-slate-500 italic mt-1 border-l-2 border-slate-700 pl-2">"{trip.notes}"</div>}
                <div className="flex flex-wrap gap-1 mt-2">
                  {trip.route?.map((s, i) => (
                    <span key={i} className={`text-[10px] px-2 py-0.5 rounded ${i === 0 ? "bg-amber-500/15 text-amber-400" : "bg-slate-900 text-slate-400"}`}>
                      {i + 1}. {s.name.split(" ").slice(0, 3).join(" ")}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="bg-slate-900 border-l border-slate-800 overflow-y-auto p-3.5 hidden md:block">
            {!selTrip ? (
              <div className="text-center py-12 text-slate-500">
                <Navigation size={48} className="mx-auto mb-3 text-slate-600" />
                <p className="text-sm">Select a trip to see details.</p>
              </div>
            ) : (
              <>
                <div className="mb-3">
                  <div className="font-bold text-base">{fmtDate(selTrip.date)}</div>
                  <div className="text-xs text-slate-400 mt-1">From {selTrip.startLoc} · {selTrip.route?.length} stops</div>
                </div>
                {selTrip.reasoning && <div className="bg-slate-800 rounded p-3 mb-3 text-xs text-slate-400 leading-relaxed">{selTrip.reasoning}</div>}
                <ul className="space-y-1.5">
                  {selTrip.route?.map((s, i) => {
                    const loc = locs.find(l => l.id === s.id);
                    const sc = selTrip.schedule?.schedule?.[i];
                    return (
                      <li key={i} className="flex items-start gap-2 py-1.5 border-b border-slate-800 last:border-0">
                        <div className="w-6 h-6 rounded-full bg-amber-500 text-black font-bold text-xs flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{s.name}</div>
                          <div className="text-xs text-slate-500">{s.address}</div>
                          {sc && <div className="text-xs text-emerald-400 mt-0.5">{formatTime12(sc.arrivalTime)} → {formatTime12(sc.departureTime)}</div>}
                          {s.note && <div className="text-xs text-slate-600 italic mt-0.5">{s.note}</div>}
                        </div>
                        <button
                          onClick={() => openNavPicker({ name: s.name, address: s.address, lat: loc?.lat, lng: loc?.lng })}
                          className="flex-shrink-0 self-center px-2 py-1 rounded bg-blue-500/15 border border-blue-500/30 text-blue-400 text-[11px] font-semibold hover:bg-blue-500/25">
                          {NAV_APPS.find(a => a.id === navApp)?.icon}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {selTrip.tips && <div className="mt-3 px-3 py-2 bg-amber-500/10 rounded text-xs text-amber-400">💡 {selTrip.tips}</div>}
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => {
                      const first = selTrip.route?.[0];
                      const loc = locs.find(l => l.id === first?.id);
                      navigateTo({ name: first?.name, address: first?.address, lat: loc?.lat, lng: loc?.lng }, true);
                    }}
                    className="flex-1 bg-blue-500/15 border border-blue-500/30 text-blue-400 hover:bg-blue-500/25 rounded py-2 text-xs font-semibold flex items-center justify-center gap-1.5">
                    {NAV_APPS.find(a => a.id === navApp)?.icon} Navigate
                  </button>
                  <button onClick={() => flyToRoute(selTrip.route)} className="flex-1 bg-slate-800 border border-slate-700 hover:border-amber-500 hover:text-amber-500 rounded py-2 text-xs font-semibold flex items-center justify-center gap-1.5"><MapPin size={13} />Map</button>
                  <button onClick={() => { setTripDate(selTrip.date); setStartLoc(selTrip.startLoc); setNotes(selTrip.notes || ""); setNumStops(selTrip.numStops || "5"); setTab("plan"); }}
                    className="flex-1 bg-slate-800 border border-slate-700 hover:border-amber-500 hover:text-amber-500 rounded py-2 text-xs font-semibold">↩ Re-plan</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* DATA / SETTINGS */}
      {tab === "locations" && (
        <div className="flex-1 overflow-y-auto p-5">
          <div className="max-w-3xl mx-auto space-y-3">
            <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3 flex items-center gap-1.5">
                <Upload size={12} />
                {locs.length > 0 ? "Sync Updated KML from Google Maps" : "Upload Google My Maps KML"}
              </div>
              {locs.length > 0 && (
                <div className="text-xs text-slate-400 mb-3 bg-blue-500/10 border border-blue-500/20 rounded p-2.5 leading-relaxed">
                  ℹ️ You have <strong className="text-slate-200">{locs.length} locations</strong> loaded. Uploading a new KML will show a <strong className="text-amber-400">sync preview</strong> — new locations, removed locations, and category changes — before anything is updated. Only new addresses will be geocoded.
                </div>
              )}
              <label htmlFor="kml-input" className="block">
                <div className="border-2 border-dashed border-slate-700 hover:border-amber-500 hover:bg-amber-500/5 rounded-lg p-8 text-center cursor-pointer transition-colors bg-slate-900">
                  <Upload size={40} className="mx-auto mb-3 text-slate-500" />
                  <div className="font-bold text-sm mb-1">
                    {locs.length > 0 ? "Click to upload updated KML for sync" : "Click to upload your KML file"}
                  </div>
                  <div className="text-xs text-slate-400 leading-relaxed">
                    Export from Google My Maps:<br />Menu → Export to KML → check "Export as KML" → Download
                  </div>
                </div>
              </label>
              <input id="kml-input" type="file" accept=".kml,.kmz" onChange={handleKMLUpload} className="hidden" />
            </div>

            <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center gap-1.5"><Key size={12} />Groq API Key (Optional - Free)</div>
              <div className="text-xs text-slate-400 mb-2 leading-relaxed">
                Get free at <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" className="text-amber-500 underline">console.groq.com/keys</a> for AI-powered trip planning. Without a key, the app uses local nearest-neighbor routing. Stored only on your device.
              </div>
              <input type="password" value={apiKey} onChange={(e) => saveApiKey(e.target.value)} placeholder="gsk_..." className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm focus:border-amber-500 outline-none font-mono" />
              {apiKey && <div className="text-xs text-emerald-400 mt-2 flex items-center gap-1"><Check size={12} />Key saved · AI routing enabled</div>}
            </div>

            {locs.length > 0 && (
              <>
                <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">📊 Loaded Data</div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
                    {[
                      { val: locs.length, label: "Total", color: "text-amber-500" },
                      { val: geocodedCount, label: "Mapped", color: "text-emerald-400" },
                      { val: categories.length, label: "Categories", color: "text-blue-400" },
                      { val: ungeocodedCount, label: "To Geocode", color: ungeocodedCount > 0 ? "text-red-400" : "text-emerald-400" },
                    ].map((s, i) => (
                      <div key={i} className="bg-slate-900 rounded p-3 text-center">
                        <div className={`font-bold text-2xl ${s.color}`}>{s.val}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{s.label}</div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3.5">
                    <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Categories</div>
                    <div className="flex flex-wrap gap-1.5">
                      {categories.map((c) => (
                        <span key={c} className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border" style={{ borderColor: categoryColors[c] + "60", color: categoryColors[c] }}>
                          <span className="w-2 h-2 rounded-full" style={{ background: categoryColors[c] }} />
                          {c} ({locs.filter((l) => l.category === c).length})
                        </span>
                      ))}
                    </div>
                  </div>

                  {ungeocodedCount > 0 && !geoProgress.active && (
                    <button onClick={startGeocoding} className="w-full mt-3.5 bg-gradient-to-br from-amber-500 to-orange-600 text-black rounded py-2.5 font-bold text-sm">
                      📍 Geocode {ungeocodedCount} Addresses (~{Math.ceil(ungeocodedCount / 60)} min)
                    </button>
                  )}

                  {geoProgress.active && (
                    <div className="mt-3.5 p-3 bg-slate-900 rounded">
                      <div className="text-xs font-bold text-amber-500 mb-1 flex items-center gap-1.5"><MapPin size={12} />Geocoding in progress…</div>
                      <div className="text-xs text-slate-400">{geoProgress.done} / {geoProgress.total} · {geoProgress.found} found</div>
                      <div className="h-1.5 bg-slate-700 rounded mt-2 overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-amber-500 to-orange-600 transition-all" style={{ width: `${(geoProgress.done / geoProgress.total) * 100}%` }} />
                      </div>
                      <button onClick={stopGeocoding} className="w-full mt-2 px-2 py-1.5 bg-slate-800 hover:border-red-500 text-red-400 border border-slate-700 rounded text-xs font-semibold flex items-center justify-center gap-1.5">
                        <Pause size={11} />Pause
                      </button>
                    </div>
                  )}

                  {geocodedCount > 0 && (
                    <button onClick={() => setTab("map")} className="w-full mt-2 bg-slate-900 border border-slate-700 hover:border-amber-500 hover:text-amber-500 rounded py-2 text-sm font-semibold">
                      🗺️ View on Map
                    </button>
                  )}
                </div>

                <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">💾 Backup & Restore</div>
                  <div className="text-xs text-slate-400 mb-2 leading-relaxed">
                    Export your geocoded locations and trip history as a JSON file. Import on another device to skip re-geocoding.
                  </div>
                  <div className="flex gap-2">
                    <button onClick={exportData} className="flex-1 bg-slate-900 border border-slate-700 hover:border-amber-500 hover:text-amber-500 rounded py-2 text-xs font-semibold">
                      📤 Export Backup
                    </button>
                    <label className="flex-1 cursor-pointer">
                      <div className="bg-slate-900 border border-slate-700 hover:border-amber-500 hover:text-amber-500 rounded py-2 text-xs font-semibold text-center text-slate-400">
                        📥 Import Backup
                      </div>
                      <input type="file" accept=".json" onChange={importData} className="hidden" />
                    </label>
                  </div>
                </div>

                <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">⚠️ Reset</div>
                  <button onClick={clearAllData} className="w-full bg-slate-900 border border-slate-700 hover:border-red-500 text-red-400 rounded py-2 text-sm font-semibold flex items-center justify-center gap-2">
                    <Trash2 size={14} />Clear All Data
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* NAV APP PICKER MODAL */}
      {showNavPicker && (
        <div className="fixed inset-0 z-[9997] bg-black/60 flex items-end md:items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <div>
                <h2 className="font-bold text-sm">Open in Maps</h2>
                {navPickerStop && <div className="text-xs text-slate-400 mt-0.5 truncate max-w-[240px]">{navPickerStop.name}</div>}
              </div>
              <button onClick={() => setShowNavPicker(false)} className="text-slate-400 hover:text-slate-200"><X size={18} /></button>
            </div>

            <div className="p-4 space-y-2">
              {NAV_APPS.filter(app => !app.iosOnly || isIOS()).map(app => (
                <button key={app.id} onClick={() => saveNavApp(app.id)}
                  className={`w-full flex items-center gap-3 p-3.5 rounded-xl border transition-all ${
                    navApp === app.id
                      ? "border-amber-500 bg-amber-500/10"
                      : "border-slate-700 bg-slate-800 hover:border-slate-600"
                  }`}>
                  <span className="text-2xl">{app.icon}</span>
                  <div className="flex-1 text-left">
                    <div className="font-semibold text-sm">{app.label}</div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {app.id === "google" && "Best for multi-stop routes"}
                      {app.id === "waze" && "Best for traffic & longer trips"}
                      {app.id === "apple" && "Native iOS maps"}
                    </div>
                  </div>
                  {navApp === app.id && <Check size={16} className="text-amber-500 flex-shrink-0" />}
                </button>
              ))}
            </div>

            <div className="px-4 pb-4 pt-1">
              <div className="text-[11px] text-slate-500 text-center mb-3">Your preference is saved for next time</div>
              <button
                onClick={() => {
                  const url = buildNavUrl(navApp, navPickerStop);
                  window.open(url, "_blank");
                  setShowNavPicker(false);
                }}
                className="w-full py-3 bg-gradient-to-br from-amber-500 to-orange-600 text-black rounded-xl font-bold text-sm">
                Navigate with {NAV_APPS.find(a => a.id === navApp)?.label} →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SYNC PREVIEW MODAL */}
      {syncPreview && (
        <div className="fixed inset-0 z-[9998] bg-black/70 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 flex-shrink-0">
              <div>
                <h2 className="font-bold text-base">🔄 KML Sync Preview</h2>
                <div className="text-xs text-slate-400 mt-0.5">Review changes before applying</div>
              </div>
              <button onClick={cancelSync} className="text-slate-400 hover:text-slate-200"><X size={18} /></button>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-3 gap-3 p-4 flex-shrink-0">
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-emerald-400">{syncPreview.added.length}</div>
                <div className="text-xs text-emerald-400 mt-0.5">New</div>
              </div>
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-red-400">{syncPreview.removed.length}</div>
                <div className="text-xs text-red-400 mt-0.5">Removed</div>
              </div>
              <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-blue-400">{syncPreview.changed.length}</div>
                <div className="text-xs text-blue-400 mt-0.5">Category Changed</div>
              </div>
            </div>

            {/* Detail lists */}
            <div className="overflow-y-auto flex-1 px-4 pb-2 space-y-3">
              {syncPreview.added.length > 0 && (
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-emerald-400 mb-2">
                    ✅ New Locations ({syncPreview.added.length})
                    {syncPreview.added.some(l => !l.lat) && (
                      <span className="text-amber-400 ml-2 normal-case font-normal">· {syncPreview.added.filter(l => !l.lat).length} need geocoding</span>
                    )}
                  </div>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {syncPreview.added.map((l, i) => (
                      <div key={i} className="flex items-start gap-2 p-2 bg-emerald-500/5 border border-emerald-500/20 rounded text-xs">
                        <span className="text-emerald-400 font-bold flex-shrink-0">+</span>
                        <div className="min-w-0">
                          <div className="font-medium truncate">{l.name}</div>
                          <div className="text-slate-500 truncate">{l.address}</div>
                          <span className="inline-block px-1.5 py-0.5 rounded text-[10px] mt-0.5"
                            style={{ background: (categoryColors[l.category] || "#888") + "20", color: categoryColors[l.category] || "#888" }}>
                            {l.category}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {syncPreview.removed.length > 0 && (
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-red-400 mb-2">
                    🗑️ Removed Locations ({syncPreview.removed.length})
                  </div>
                  <div className="space-y-1 max-h-36 overflow-y-auto">
                    {syncPreview.removed.map((l, i) => (
                      <div key={i} className="flex items-start gap-2 p-2 bg-red-500/5 border border-red-500/20 rounded text-xs">
                        <span className="text-red-400 font-bold flex-shrink-0">−</span>
                        <div className="min-w-0">
                          <div className="font-medium truncate line-through text-slate-400">{l.name}</div>
                          <div className="text-slate-500 truncate">{l.address}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {syncPreview.changed.length > 0 && (
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-blue-400 mb-2">
                    ✏️ Category Changes ({syncPreview.changed.length})
                  </div>
                  <div className="space-y-1 max-h-36 overflow-y-auto">
                    {syncPreview.changed.map((item, i) => (
                      <div key={i} className="flex items-start gap-2 p-2 bg-blue-500/5 border border-blue-500/20 rounded text-xs">
                        <span className="text-blue-400 font-bold flex-shrink-0">~</span>
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">{item.loc.name}</div>
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-700 text-slate-400 line-through">{item.oldCategory}</span>
                            <span className="text-slate-400">→</span>
                            <span className="px-1.5 py-0.5 rounded text-[10px]"
                              style={{ background: (categoryColors[item.newCategory] || "#888") + "20", color: categoryColors[item.newCategory] || "#888" }}>
                              {item.newCategory}
                            </span>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {syncPreview.added.length === 0 && syncPreview.removed.length === 0 && syncPreview.changed.length === 0 && (
                <div className="text-center py-6 text-slate-400">
                  <Check size={32} className="mx-auto mb-2 text-emerald-400" />
                  <div className="font-semibold text-emerald-400">No changes detected</div>
                  <div className="text-xs mt-1">Your map is already up to date.</div>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="px-4 py-4 border-t border-slate-800 flex gap-3 flex-shrink-0">
              <button onClick={cancelSync} className="flex-1 bg-slate-800 border border-slate-700 hover:border-slate-500 text-slate-300 rounded py-2.5 text-sm font-semibold">
                Cancel
              </button>
              <button onClick={applySyncPreview} disabled={syncLoading}
                className="flex-1 bg-gradient-to-br from-amber-500 to-orange-600 text-black rounded py-2.5 text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-50">
                {syncLoading
                  ? <><div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />Applying…</>
                  : <>
                      <Check size={15} />
                      Apply Sync
                      {syncPreview.added.filter(l => !l.lat).length > 0 &&
                        <span className="text-[10px] bg-black/20 px-1.5 py-0.5 rounded-full">
                          + geocode {syncPreview.added.filter(l => !l.lat).length} new
                        </span>
                      }
                    </>
                }
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className={`fixed bottom-5 right-5 px-4 py-2 rounded font-semibold text-sm z-[9999] max-w-xs shadow-lg ${
          toast.kind === "warn" ? "bg-amber-500 text-black" : toast.kind === "err" ? "bg-red-500 text-white" : "bg-emerald-500 text-black"
        }`}>{toast.msg}</div>
      )}
    </div>
  );
}
