import React, { useState, useEffect } from "react";

const LOG_PATH = "/logs/workflow.log";

function fmt(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Math.round(n).toLocaleString("en-US");
}

function pct(n) {
  if (n == null || Number.isNaN(Number(n))) return "—%";
  return (n * 100).toFixed(1) + "%";
}

const DEFAULT_BASINS = [
  { basinKey: "cagayan", name: "Cagayan", level: "ADM2", pcode: "PH02015" },
  { basinKey: "bicol", name: "Bicol", level: "ADM2", pcode: "PH05000" },
];

function parseCSV(text) {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.replace(/,/g, "").trim().length > 0); // Ignore blank comma rows

  if (lines.length <= 1) return [];

  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (cols[i] || "").trim();
    });
    return row;
  });
}

function buildBasins(rows) {
  const byKey = {};
  const order = [];

  rows.forEach((r) => {
    const key = r.basin_name?.trim().toLowerCase();
    if (!key) return; // Skip empty basin names

    if (!byKey[key]) {
      byKey[key] = {
        basinKey: key,
        name: r.name || key.charAt(0).toUpperCase() + key.slice(1),
        pcode: r.pcode || "",
        level: r.level || "ADM2",
        fireLead: parseFloat(r.fire_lead),
        probabilityAtFire: parseFloat(r.probability_at_fire),
        popAtFire: parseFloat(r.impact_population_at_fire),
        thresholds: [],
      };
      order.push(key);
    }

    if (r.severity_rp) {
      byKey[key].thresholds.push({
        rp: "RP" + r.severity_rp,
        probThreshold: parseFloat(r.p_threshold),
        popThreshold: parseFloat(r.impact_population_threshold),
        fired: r.fired?.trim().toUpperCase() === "TRUE",
      });
    }
  });

  // Ensure default basins (e.g. Bicol) always exist in the tab list
  DEFAULT_BASINS.forEach((def) => {
    if (!byKey[def.basinKey]) {
      byKey[def.basinKey] = {
        basinKey: def.basinKey,
        name: def.name,
        pcode: def.pcode,
        level: def.level,
        fireLead: null,
        probabilityAtFire: null,
        popAtFire: null,
        thresholds: [],
      };
      order.push(def.basinKey);
    }
  });

  return order.map((key) => byKey[key]);
}

function formatRunDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDuration(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins > 0) {
    return `${mins}m ${String(secs).padStart(2, "0")}s`;
  }
  return `${secs}s`;
}

function peakSignalLabel(leadMembers, totalMembers) {
  const leads = Object.keys(leadMembers).map(Number);
  if (leads.length === 0) return "No flood patches";
  const max = Math.max(...leads.map((l) => leadMembers[l]));
  if (max === 0) return "No flood patches";
  const hitLeads = leads.filter((l) => leadMembers[l] === max);
  const lo = Math.min(...hitLeads);
  const hi = Math.max(...hitLeads);
  const dayLabel = lo === hi ? `Lead Day ${lo}` : `Lead Day ${lo}\u2013${hi}`;
  return `${max}/${totalMembers} members (${dayLabel})`;
}

function actionTriggeredLabel(tierFires) {
  return tierFires > 0
    ? `Fired (${tierFires} tier fire${tierFires === 1 ? "" : "s"})`
    : "None (0 tier fires)";
}

function parseProcessLog(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];

  let runDate = null;
  let segment = null;

  function timestampOf(line) {
    const m = line.match(/(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return {
      instant: new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}`),
      hhmm: `${m[2]}:${m[3]}`,
    };
  }

  function closeSegment(endInstant) {
    if (!segment) return;
    const elapsedSeconds = Math.max(
      0,
      Math.round((endInstant.getTime() - segment.startInstant.getTime()) / 1000)
    );
    rows.push({
      rawDate: runDate,
      date: formatRunDate(runDate),
      startTime: segment.startTimeLabel,
      cpuTime: formatDuration(elapsedSeconds),
      peakSignal: peakSignalLabel(segment.leadMembers, segment.totalMembers),
      actionTriggered: actionTriggeredLabel(segment.tierFires),
      basinKey: segment.basinKey,
    });
    segment = null;
  }

  for (const line of lines) {
    if (line.includes("run_daily_monitoring started")) {
      const ts = timestampOf(line);
      if (ts) {
        runDate = ts.instant.toISOString().slice(0, 10);
        segment = null;
      }
      continue;
    }
    if (!runDate) continue;

    const basinMatch = line.match(/Processing basin '([^']+)'/);
    if (basinMatch) {
      const ts = timestampOf(line);
      if (ts) {
        closeSegment(ts.instant);
        segment = {
          basinKey: basinMatch[1],
          startInstant: ts.instant,
          startTimeLabel: ts.hhmm,
          leadMembers: {},
          totalMembers: 51,
          tierFires: 0,
        };
      }
      continue;
    }

    if (segment) {
      const leadMatch = line.match(/Lead\s+(\d+)d:\s+(\d+)\/(\d+) flood members/);
      if (leadMatch) {
        segment.leadMembers[Number(leadMatch[1])] = Number(leadMatch[2]);
        segment.totalMembers = Number(leadMatch[3]);
      }

      const tierMatch = line.match(/Tier evaluation complete:.*?(\d+) tier decisions fired/);
      if (tierMatch) {
        segment.tierFires = Number(tierMatch[1]);
      }
    }

    if (line.includes("run_daily_monitoring complete")) {
      const ts = timestampOf(line);
      if (ts) closeSegment(ts.instant);
      runDate = null;
    }
  }

  return rows;
}

function getManilaDateAndHour() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const map = {};
  parts.forEach((p) => {
    map[p.type] = p.value;
  });
  return { dateStr: `${map.year}-${map.month}-${map.day}`, hour: Number(map.hour) };
}

function expectedActivationDate() {
  const { dateStr, hour } = getManilaDateAndHour();
  if (hour >= 18) return dateStr;
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function formatLogDateRange(rows) {
  if (rows.length === 0) return null;
  const dates = rows.map((r) => new Date(r.rawDate + "T00:00:00")).sort((a, b) => a - b);
  const start = dates[0];
  const end = dates[dates.length - 1];
  const startMonth = start.toLocaleDateString("en-US", { month: "short" });
  const endMonth = end.toLocaleDateString("en-US", { month: "short" });
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();

  if (start.getTime() === end.getTime()) {
    return `${startMonth} ${start.getDate()}, ${startYear}`;
  }
  if (startYear === endYear && startMonth === endMonth) {
    return `${startMonth} ${start.getDate()}\u2013${end.getDate()}, ${startYear}`;
  }
  if (startYear === endYear) {
    return `${startMonth} ${start.getDate()} \u2013 ${endMonth} ${end.getDate()}, ${startYear}`;
  }
  return `${startMonth} ${start.getDate()}, ${startYear} \u2013 ${endMonth} ${end.getDate()}, ${endYear}`;
}

async function findCsvPath() {
  const modules = import.meta.glob('/src/assets/data/*.csv', {
    eager: true,
    query: '?raw',
    import: 'default',
  });
  const fileKeys = Object.keys(modules).sort(); // Sort alphabetically/chronologically
 
  if (fileKeys.length === 0) {
    throw new Error("No CSV file found inside src/assets/data/");
  }
  const latestKey = fileKeys.pop(); // Guarantees selecting the latest file name
  return {
    fileName: latestKey.split("/").pop(),
    text: modules[latestKey], // raw CSV text, already loaded (eager: true)
  };
}

function getActivatedMapPath(basinKey, isActivated) {
  if (!isActivated || !basinKey) return null;

  const lowerBasin = basinKey.toLowerCase();

  try {
    // Eagerly glob images inside /src/assets/maps/
    const mapModules = import.meta.glob('/src/assets/maps/*.{png,jpg,jpeg,svg,webp}', {
      eager: true,
      import: 'default',
    });

    const mapKeys = Object.keys(mapModules);

    // Locate any file path containing the basin key
    const matchedKey = mapKeys.find((key) => key.toLowerCase().includes(lowerBasin));

    if (matchedKey) {
      const resolvedUrl = mapModules[matchedKey]; // Actual bundled URL
      const fileName = matchedKey.split("/").pop();
      console.log(
        `%c[Map Located] Found map for '${basinKey}': ${fileName}`,
        "color: #48bf53; font-weight: bold;"
      );
      return { url: resolvedUrl, fileName };
    }

    console.warn(
      `[Map Not Located] No image containing '${lowerBasin}' in /src/assets/maps/. Available files:`,
      mapKeys
    );
  } catch (err) {
    console.error("[Map Search Error] Failed to scan /src/assets/maps/:", err);
  }

  return null;
}

export default function FloodDashboard() {
  const [csvPath, setCsvPath] = useState(null);
  const [csvFileDate, setCsvFileDate] = useState(null);
  const [csvFileStamp, setCsvFileStamp] = useState(null);
  
  const [basins, setBasins] = useState([]);
  const [logRows, setLogRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [activeBasin, setActiveBasin] = useState(null);
  const [activeRp, setActiveRp] = useState(null);
  const [logOpen, setLogOpen] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        const { fileName, text: csvText } = await findCsvPath();
        const extractedDate = (fileName.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
        const extractedStamp = (fileName.match(/(\d{8}T\d{6}Z)/) || [])[1] || null;
 
        const parsedBasins = buildBasins(parseCSV(csvText));
 
        let parsedLogRows = [];
        try {
          const logRes = await fetch(LOG_PATH);
          if (logRes.ok) parsedLogRows = parseProcessLog(await logRes.text());
        } catch (_) {}
 
        if (!cancelled) {
          setCsvPath(fileName);
          setCsvFileDate(extractedDate);
          setCsvFileStamp(extractedStamp);
          setBasins(parsedBasins);
          setActiveBasin(parsedBasins[0]?.basinKey ?? null);
          setLogRows(parsedLogRows);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err.message);
          setLoading(false);
        }
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, []);

  function selectBasin(key) {
    setActiveBasin(key);
    setActiveRp(null);
    setMapFailed(false);
  }

  const pageStyle = {
    minHeight: "100vh",
    background: "#232e28",
    color: "#f0e9dd",
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
    padding: "48px 20px 72px",
  };

  if (loading) {
    return (
      <div style={pageStyle}>
        <div style={{ maxWidth: 760, margin: "0 auto", color: "#fbead1", fontSize: 14 }}>
          Loading activation data…
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div style={pageStyle}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <p style={{ color: "#48bf53", fontSize: 14, marginBottom: 8 }}>
            Couldn't load the activation data.
          </p>
          <p style={{ color: "#fbead1", fontSize: 13, fontFamily: "'IBM Plex Mono', monospace" }}>
            {loadError}
          </p>
          <p style={{ color: "#fbead1", fontSize: 13, marginTop: 12 }}>
            Check that a <code>.csv</code> file exists under your project's <code>public/data/</code>{" "}
            directory.
          </p>
        </div>
      </div>
    );
  }
  const basin = basins.find((b) => b.basinKey === activeBasin);
  if (!basin) return null;

  const isBasinActivated = basin.thresholds.length > 0 && basin.thresholds.some((t) => t.fired);
  const activeMap = getActivatedMapPath(basin.basinKey, isBasinActivated);
  const activeMapPath = activeMap?.url ?? null;
  const activeMapFileName = activeMap?.fileName ?? null;

  const expectedDate = expectedActivationDate();
  const isCurrent = csvFileDate === expectedDate;

  const showActivationView = isCurrent && isBasinActivated;

  return (
    <div style={pageStyle}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        {/* system line */}
        <div
          style={{
            fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
            fontSize: 12.5,
            color: "#fbead1",
            display: "flex",
            justifyContent: "space-between",
            borderBottom: "1px solid #11823b",
            paddingBottom: 10,
            marginBottom: 22,
            flexWrap: "wrap",
            gap: 6,
          }}
        >
          <span>
            {basin.name.toUpperCase()} RIVER BASIN
          </span>
        </div>

        {/* basin tabs */}
        <div
          style={{
            display: "flex",
            gap: 2,
            marginBottom: 30,
            background: "#11823b",
            padding: 2,
          }}
        >
          {basins.map((b) => {
            const isActive = b.basinKey === activeBasin;
            return (
              <button
                key={b.basinKey}
                onClick={() => selectBasin(b.basinKey)}
                style={{
                  flex: 1,
                  border: "none",
                  cursor: "pointer",
                  padding: "10px 14px",
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 13,
                  background: isActive ? "transparent" : "#232e28",
                }}
              >
                {b.name}
              </button>
            );
          })}
        </div>

        {showActivationView ? (
          <>
            {/* headline */}
            <h1
              style={{
                fontFamily: "Georgia, 'Times New Roman', serif",
                fontWeight: 500,
                fontSize: 38,
                lineHeight: 1.15,
                margin: "0 0 6px",
              }}
            >
              Flood activation - {basin.name} River Basin
            </h1>
            <p
              style={{
                color: "#fbead1",
                fontSize: 15,
                margin: "0 auto 10px",
                textAlign: "center",
              }}
            >
              Anticipatory action fired at a{" "}
              <strong style={{ color: "#f0e9dd", fontWeight: 500 }}>{basin.fireLead}-day</strong> lead
              time. <br />{basin.thresholds.filter((t) => t.fired).length} of {basin.thresholds.length}{" "}
              severity levels ({basin.thresholds.map((t) => t.rp).join(", ")}) cleared their trigger
              conditions.
            </p>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                textAlign: "center",
                gap: 12,
                borderBottom: "1px solid #11823b",
                padding: "28px 0",
                marginBottom: 10,
              }}
            >
              <div
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 40,
                  background: "#b8320f",
                  padding: "20px 30px",
                  whiteSpace: "nowrap",
                }}
              >
                ACTIVATED
              </div>
            </div>

            {/* Row: Probability and lead days */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 1,
                marginBottom: 24,
              }}
            >
              <div style={{ background: "#232e28", padding: "18px 12px 0 0" }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 36, color: "#48bf53" }}>
                  {pct(basin.probabilityAtFire)}
                </div>
                <div style={{ fontSize: 15, color: "#fbead1", marginTop: 4 }}>
                  forecast probability at trigger
                </div>
              </div>
              <div style={{ background: "#232e28", padding: "18px 0 0 12px" }}>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 36, color: "#48bf53" }}>
                  {basin.fireLead} days
                </div>
                <div style={{ fontSize: 15, color: "#fbead1", marginTop: 4 }}>
                  lead time before impact
                </div>
              </div>
            </div>

            {/* Row: Population figure */}
            <div
              style={{
                fontFamily: "Georgia, serif",
                fontSize: 32,
                fontWeight: 500,
                lineHeight: 1,
                marginBottom: 14,
              }}
            >
              {fmt(basin.popAtFire)}
            </div>

            {/* Row 2: Phrase */}
            <div style={{ fontSize: 15, color: "#fbead1", lineHeight: 1.4, marginBottom: 8}}>
              people projected to be exposed to flooding at the {basin.fireLead}-day forecast lead
            </div>
            <div
              style={{
                fontFamily: "'IBM Plex Mono', monospace",
                fontSize: 10,
                color: "#fbead1",
                opacity: 0.75,
                marginBottom: 32,
                fontStyle: "italic",
              }}
            >
            <p
              style={{
                fontSize: 11,
                color: "#fbead1",
                opacity: 0.65,
                margin: "14px auto 0",
                fontStyle: "italic",
              }}
            >
              Note: {formatRunDate(expectedDate)} reflects a daily 6:00 PM Manila cutoff, aligned with global forecast update schedules (~10:00 UTC).
              Source: {csvPath}
            </p>
            </div>
            {/* map */}
            <section style={{ marginBottom: 34 }}>
              <h2
                style={{
                  fontFamily: "Georgia, serif",
                  fontWeight: 500,
                  fontSize: 19,
                  paddingTop: "25px",
                  borderTop: "1px solid #11823b",
                }}
              >
                Extent
              </h2>

              {isBasinActivated && activeMapPath && !mapFailed ? (
                <>
                  <p style={{ fontSize: 14, color: "#fbead1", margin: "0 0 18px" }}>
                    Modelled population exposed by municipality at the {basin.fireLead}-day lead.
                  </p>
                  <div style={{ border: "1px solid #11823b", background: "#fffdf8", padding: 6 }}>
                    <img
                      key={activeMapPath}
                      src={activeMapPath}
                      alt={`Map of ${basin.name} showing population exposed at lead day ${basin.fireLead}`}
                      style={{ display: "block", width: "100%", height: "auto" }}
                      onError={() => {
                        console.error(`[Map Load Error] Failed to load image asset at path: ${activeMapPath}`);
                        setMapFailed(true);
                      }}
                    />
                  </div>
                  <p style={{ fontSize: 13, color: "#fbead1", marginTop: 10 }}>
                    Population exposed at lead day {basin.fireLead} for {basin.name} basin.
                  </p>
                  <p
                    style={{
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: 10,
                      color: "#fbead1",
                      opacity: 0.75,
                      marginTop: 4,
                      fontStyle: "italic",
                    }}
                  >
                    Source: {activeMapFileName}
                  </p>
                </>
              ) : (
                <div
                  style={{
                    border: "1px dashed #11823b",
                    padding: "40px 20px",
                    textAlign: "center",
                    color: "#fbead1",
                    fontSize: 13.5,
                  }}
                >
                  {!isBasinActivated
                    ? `No activation triggered for ${basin.name} River Basin.`
                    : `No exposure map found in /maps/ for ${basin.name}.`}
                </div>
              )}
            </section>

            {/* thresholds */}
            <section style={{ marginBottom: 40 }}>
              <h2 style={{ fontFamily: "Georgia, serif", fontWeight: 500, fontSize: 19, margin: "0 0 4px" }}>
                Trigger thresholds
              </h2>
              <p style={{ fontSize: 14, color: "#fbead1", margin: "0 0 20px" }}>
                A severity level fires when both the forecast probability and the projected exposed
                population clear its threshold. Select a row to compare it against the{" "}
                {fmt(basin.popAtFire)} figure above.
              </p>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14.5 }}>
                <thead>
                  <tr>
                    {["Severity", "Probability threshold", "Population threshold", "Result"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          fontWeight: 500,
                          color: "#fbead1",
                          fontSize: 12.5,
                          padding: "0 10px 8px 0",
                          borderBottom: "1px solid #11823b",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {basin.thresholds.map((t, idx) => {
                    const isActive = activeRp === t.rp;
                    return (
                      <tr
                        key={`${t.rp}-${idx}`}
                        onClick={() => setActiveRp(isActive ? null : t.rp)}
                        style={{
                          cursor: "pointer",
                          background: isActive ? "#221e17" : "transparent",
                        }}
                      >
                        <td
                          style={{
                            fontFamily: "'IBM Plex Mono', monospace",
                            color: "#fbead1",
                            padding: "13px 10px 13px 0",
                            borderBottom: "1px solid #11823b",
                          }}
                        >
                          {t.rp}
                        </td>
                        <td
                          style={{
                            fontFamily: "'IBM Plex Mono', monospace",
                            fontSize: 14,
                            padding: "13px 10px 13px 0",
                            borderBottom: "1px solid #11823b",
                          }}
                        >
                          {pct(t.probThreshold)}
                        </td>
                        <td
                          style={{
                            fontFamily: "'IBM Plex Mono', monospace",
                            fontSize: 14,
                            padding: "13px 10px 13px 0",
                            borderBottom: "1px solid #11823b",
                            color: isActive ? "#48bf53" : "#f0e9dd",
                          }}
                        >
                          {fmt(t.popThreshold)}
                        </td>
                        <td style={{ padding: "13px 10px 13px 0", borderBottom: "1px solid #11823b" }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: 7,
                              fontFamily: "'IBM Plex Mono', monospace",
                              fontSize: 12.5,
                              color: "#fbead1",
                            }}
                          >
                            <span
                              style={{
                                width: 7,
                                height: 7,
                                background: t.fired ? "#b8320f" : "#5a5548",
                                display: "inline-block",
                              }}
                            />
                            {t.fired ? "fired" : "not fired"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {activeRp && (() => {
                const t = basin.thresholds.find((x) => x.rp === activeRp);
                if (!t) return null; // Guard against undefined lookup
                const diff = basin.popAtFire - t.popThreshold;
                return (
                  <p style={{ fontSize: 13.5, color: "#48bf53", marginTop: 14 }}>
                    {`${fmt(basin.popAtFire)} ${diff >= 0 ? "exceeds" : "falls short of"} the ${
                      activeRp
                    } population threshold of ${fmt(t.popThreshold)} by ${fmt(Math.abs(diff))} people.`}
                  </p>
                );
              })()}
            </section>
          </>
        ) : (
          /* No activation fallback card */
          <div
            style={{
              border: "1px dashed #11823b",
              padding: "48px 24px",
              textAlign: "center",
              marginBottom: 46,
            }}
          >
            <p
              style={{
                fontFamily: "Georgia, serif",
                fontWeight: 500,
                fontSize: 22,
                margin: "0 0 10px",
                color: "#f0e9dd",
              }}
            >
              No activation - {basin.name} River Basin
            </p>
            <p style={{ fontSize: 14.5, color: "#fbead1", maxWidth: "48ch", margin: "0 auto" }}>
              The flood model did not activate the {basin.name} River Basin during the {formatRunDate(expectedDate)}{" "}
              monitoring run.
            </p>
            <p
              style={{
                fontSize: 11,
                color: "#fbead1",
                opacity: 0.65,
                margin: "14px auto 0",
                fontStyle: "italic",
              }}
            >
              Note: {formatRunDate(expectedDate)} reflects a daily 6:00 PM Manila cutoff, aligned with global forecast update schedules (~10:00 UTC).
            </p>
          </div>
        )}

        {/* process log */}
        <section style={{ marginBottom: 40 }}>
          {(() => {
            const filteredLogRows = logRows.filter(
              (r) => r.basinKey == null || r.basinKey?.toLowerCase() === activeBasin?.toLowerCase()
            );
            return (
              <>
                <div
                  style={{ display: "flex", alignItems: "baseline", flexWrap: "wrap", gap: "6px 12px" }}
                >
                  <button
                    onClick={() => setLogOpen(!logOpen)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: 0,
                      fontFamily: "Georgia, serif",
                      fontWeight: 500,
                      fontSize: 19,
                      color: "#f0e9dd",
                      margin: "0 0 4px",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "'IBM Plex Mono', monospace",
                        fontSize: 14,
                        color: "#fbead1",
                        display: "inline-block",
                        transform: logOpen ? "rotate(90deg)" : "none",
                        transition: "transform 0.15s ease",
                      }}
                    >
                      ▸
                    </span>
                    Process log
                  </button>
                  {filteredLogRows.length > 0 && (
                    <span
                      style={{
                        fontFamily: "'IBM Plex Mono', monospace",
                        fontSize: 12.5,
                        color: "#fbead1",
                        opacity: 0.75,
                      }}
                    >
                      {formatLogDateRange(filteredLogRows)} · {filteredLogRows.length} run
                      {filteredLogRows.length === 1 ? "" : "s"} · {basin.name}
                    </span>
                  )}
                </div>
                {logOpen && (
                  <>
                    <p style={{ fontSize: 14, color: "#fbead1", margin: "4px 0 16px", textAlign: "center" }}>
                      Daily execution summary for {basin.name} River Basin: one row per monitoring run
                    </p>
                    {filteredLogRows.length === 0 ? (
                      <p style={{ fontSize: 13, color: "#fbead1", fontStyle: "italic" }}>
                        {logRows.length === 0
                          ? `No process log found at ${LOG_PATH}.`
                          : `No process log entries found for ${basin.name}.`}
                      </p>
                    ) : (
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
                          <thead>
                            <tr>
                              {["Date", "Start Time", "Run Time", "Peak Flood Ensemble Signal", "Action Triggered"].map(
                                (h) => (
                                  <th
                                    key={h}
                                    style={{
                                      textAlign: "left",
                                      fontWeight: 500,
                                      color: "#fbead1",
                                      fontSize: 12,
                                      padding: "0 12px 8px 0",
                                      borderBottom: "1px solid #11823b",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {h}
                                  </th>
                                )
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {filteredLogRows.map((row, i) => (
                              <tr key={i}>
                                <td
                                  style={{
                                    fontFamily: "'IBM Plex Mono', monospace",
                                    color: "#fbead1",
                                    padding: "10px 12px 10px 0",
                                    borderBottom: "1px solid #11823b",
                                    whiteSpace: "nowrap",
                                    textAlign: "left",
                                  }}
                                >
                                  {row.date}
                                </td>
                                <td
                                  style={{
                                    fontFamily: "'IBM Plex Mono', monospace",
                                    fontSize: 13,
                                    padding: "10px 12px 10px 0",
                                    borderBottom: "1px solid #11823b",
                                    whiteSpace: "nowrap",
                                    textAlign: "left",
                                  }}
                                >
                                  {row.startTime}
                                </td>
                                <td
                                  style={{
                                    fontFamily: "'IBM Plex Mono', monospace",
                                    fontSize: 13,
                                    padding: "10px 12px 10px 0",
                                    borderBottom: "1px solid #11823b",
                                    whiteSpace: "nowrap",
                                    textAlign: "left",
                                  }}
                                >
                                  {row.cpuTime}
                                </td>
                                <td
                                  style={{
                                    fontSize: 13.5,
                                    padding: "10px 12px 10px 0",
                                    borderBottom: "1px solid #11823b",
                                    whiteSpace: "nowrap",
                                    textAlign: "left",
                                  }}
                                >
                                  {row.peakSignal}
                                </td>
                                <td
                                  style={{
                                    fontSize: 13.5,
                                    padding: "10px 12px 10px 0",
                                    borderBottom: "1px solid #11823b",
                                    whiteSpace: "nowrap",
                                    textAlign: "left",
                                  }}
                                >
                                  {row.actionTriggered}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </>
            );
          })()}
        </section>

        <footer
          style={{
            borderTop: "1px solid #11823b",
            paddingTop: 18,
            fontSize: 12.5,
            color: "#fbead1",
            lineHeight: 1.6,
          }}
        />
      </div>
    </div>
  );
}