import React, { useState, useEffect } from "react";

const CSV_PATH = "/data/activation_2026-08-02_20260802T112020Z.csv";
const LOG_PATH = "/logs/process.log";
const MAP_PATH = (basinKey) => `/maps/${basinKey}_population_exposed_map.png`;

function fmt(n) {
  return Math.round(n).toLocaleString("en-US");
}

function pct(n) {
  return (n * 100).toFixed(1) + "%";
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
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

// The CSV's issue_date has shown up as both ISO ("2026-08-02") and US-style
// ("8/2/2026") depending on how it was exported, so normalize to ISO before
// using it for date math or comparisons anywhere else in this file.
function normalizeDateStr(raw) {
  if (!raw) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return raw;
}

function buildBasins(rows) {
  const byKey = {};
  const order = [];
  rows.forEach((r) => {
    const key = r.basin_name;
    if (!byKey[key]) {
      byKey[key] = {
        basinKey: key,
        name: r.name,
        pcode: r.pcode,
        level: r.level,
        issueDate: normalizeDateStr(r.issue_date),
        issueTime: r.issue_time,
        fireLead: parseFloat(r.fire_lead),
        probabilityAtFire: parseFloat(r.probability_at_fire),
        popAtFire: parseFloat(r.impact_population_at_fire),
        thresholds: [],
      };
      order.push(key);
    }
    byKey[key].thresholds.push({
      rp: "RP" + r.severity_rp,
      probThreshold: parseFloat(r.p_threshold),
      popThreshold: parseFloat(r.impact_population_threshold),
      fired: r.fired.trim().toUpperCase() === "TRUE",
    });
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
        closeSegment(ts.instant); // seal the previous basin's segment here
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

export default function FloodDashboard() {
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
        const csvRes = await fetch(CSV_PATH);
        if (!csvRes.ok) {
          throw new Error(`Could not load ${CSV_PATH} (${csvRes.status})`);
        }
        const csvText = await csvRes.text();
        const parsedBasins = buildBasins(parseCSV(csvText));

        let parsedLogRows = [];
        try {
          const logRes = await fetch(LOG_PATH);
          if (logRes.ok) parsedLogRows = parseProcessLog(await logRes.text());
        } catch (_) {
          // process log is optional — section just stays empty if missing
        }

        if (!cancelled) {
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
            Check that <code>{CSV_PATH}</code> exists under your project's <code>public/</code>{" "}
            directory.
          </p>
        </div>
      </div>
    );
  }

  const basin = basins.find((b) => b.basinKey === activeBasin);
  if (!basin) {
    return (
      <div style={pageStyle}>
        <div style={{ maxWidth: 760, margin: "0 auto", color: "#fbead1", fontSize: 14 }}>
          No basins found in {CSV_PATH}.
        </div>
      </div>
    );
  }

  const expectedDate = expectedActivationDate();
  const isCurrent = basin.issueDate === expectedDate;

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
            {basin.name.toUpperCase()} · {basin.level}
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

        {isCurrent ? (
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
            margin: "0 auto 30px",
            textAlign: "center",
          }}
        >
          Anticipatory action fired at a{" "}
          <strong style={{ color: "#f0e9dd", fontWeight: 500 }}>{basin.fireLead}-day</strong> lead
          time. {basin.thresholds.filter((t) => t.fired).length} of {basin.thresholds.length}{" "}
          severity levels ({basin.thresholds.map((t) => t.rp).join(", ")}) cleared their trigger
          conditions.
        </p>

        {/* hero */}
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
          
          

          {/* Row 3: Activation Status */}
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 36,
              background: "#b8320f",
              padding: "15px 20px",
              whiteSpace: "nowrap",
              marginTop: 4,
            }}
          >
            ACTIVATED
          </div>
        </div>

        {/* stat row */}
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
          <div style={{ fontSize: 15, color: "#fbead1", lineHeight: 1.4, marginBottom: 32}}>
            people projected to be exposed to flooding at the {basin.fireLead}-day forecast lead
          </div>
        {/* map */}
        <section style={{ marginBottom: 34 }}>
          <h2 style={{ fontFamily: "Georgia, serif", fontWeight: 500, fontSize: 19, paddingTop: "25px", borderTop: "1px solid #11823b", }}>
            Extent
          </h2>
          <p style={{ fontSize: 14, color: "#fbead1", margin: "0 0 18px"}}>
            Modelled population exposed by municipality at the {basin.fireLead}-day lead.
          </p>
          {!mapFailed ? (
            <>
              <div style={{ border: "1px solid #11823b", background: "#fffdf8", padding: 6 }}>
                <img
                  key={basin.basinKey}
                  src={MAP_PATH(basin.basinKey)}
                  alt={`Map of ${basin.name} showing population exposed at lead day ${basin.fireLead}, by municipality`}
                  style={{ display: "block", width: "100%", height: "auto" }}
                  onError={() => setMapFailed(true)}
                />
              </div>
              <p style={{ fontSize: 13, color: "#fbead1", marginTop: 10 }}>
                Population exposed at lead day {basin.fireLead} — municipality level, {basin.name}{" "}
                basin.
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
              No exposure map on file yet for {basin.name}.
            </div>
          )}
        </section>

        {/* thresholds */}
        <section style={{ marginBottom: 40 }}>
          <h2 style={{ fontFamily: "Georgia, serif", fontWeight: 500, fontSize: 19, margin: "0 0 4px" }}>
            Trigger thresholds
          </h2>
          <p style={{ fontSize: 14, color: "#fbead1", margin: "0 0 20px"}}>
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
              {basin.thresholds.map((t) => {
                const isActive = activeRp === t.rp;
                return (
                  <tr
                    key={t.rp}
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
          {activeRp && (
            <p style={{ fontSize: 13.5, color: "#48bf53", marginTop: 14 }}>
              {(() => {
                const t = basin.thresholds.find((x) => x.rp === activeRp);
                const diff = basin.popAtFire - t.popThreshold;
                return `${fmt(basin.popAtFire)} ${diff >= 0 ? "exceeds" : "falls short of"} the ${
                  activeRp
                } population threshold of ${fmt(t.popThreshold)} by ${fmt(Math.abs(diff))} people.`;
              })()}
            </p>
          )}
        </section>
          </>
        ) : (
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
              The flood model did not activate {basin.name} during the <br />{formatRunDate(expectedDate)}{" "}
              monitoring run.
            </p>
          </div>
        )}

        {/* process log — summarized to one row per day, filtered to the active basin */}
        <section style={{ marginBottom: 40 }}>
          {(() => {
            // Rows without a parsed basin (older log formats) are kept visible
            // regardless of which tab is active, rather than silently dropped.
            const filteredLogRows = logRows.filter(
              (r) => r.basinKey == null || r.basinKey === activeBasin
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
                    <p style={{ fontSize: 14, color: "#fbead1", margin: "4px 0 16px", textAlign: "left",}}>
                      Daily execution summary for {basin.name} — one row per monitoring run: when
                      this basin's segment started, how long it ran within the shared job, the
                      strongest flood-ensemble signal seen across the
                      5 forecast lead days, and whether that run fired a trigger tier.
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
                                    textAlign: "left",
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
        >
          {/*Source: {CSV_PATH}, {basins.map((b) => b.name).join(" and ")} basins. RP = return period,
          the severity band a forecast is measured against; population thresholds and exposure
          figures are model estimates, not confirmed ground counts. */}
        </footer>
      </div>
    </div>
  );
}