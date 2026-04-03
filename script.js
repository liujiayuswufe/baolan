const DEFAULT_BENCHMARK_OPTIONS = [
  { code: "000300", symbol: "000300.SH", name: "沪深300" },
  { code: "000001", symbol: "000001.SH", name: "上证指数" },
  { code: "000852", symbol: "000852.CSI", name: "中证1000" },
];

const BENCHMARK_STYLES = {
  "000300": {
    borderColor: "#f59e0b",
    backgroundColor: "rgba(245, 158, 11, 0.10)",
  },
  "000001": {
    borderColor: "#14b8a6",
    backgroundColor: "rgba(20, 184, 166, 0.10)",
  },
  "000852": {
    borderColor: "#16a34a",
    backgroundColor: "rgba(22, 163, 74, 0.10)",
  },
};

const RISK_FREE_RATE = 0.03;
const TRADING_DAYS = 252;
const AUTO_REFRESH_MS = 60000;

const state = {
  apiBase: "",
  fundList: [],
  benchmarkOptions: DEFAULT_BENCHMARK_OPTIONS.slice(),
  currentBenchmark: DEFAULT_BENCHMARK_OPTIONS[0].code,
  currentFund: "",
  range: "all",
  viewStart: 0,
  viewEnd: 0,
  publicShareMode: false,
  rangeData: null,
  fundChart: null,
  drawdownChart: null,
  chartLibraryUnavailable: false,
};

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();

  try {
    state.apiBase = await resolveApiBase();
    await initPage();
    startAutoRefresh();
  } catch (error) {
    resetPage();
    showStatus(error.message, "error", true);
  }
});

function bindEvents() {
  document.getElementById("fundSelector").addEventListener("change", async (event) => {
    const shortName = event.target.value;
    state.currentFund = shortName;

    if (!shortName) {
      resetPage();
      return;
    }

    await loadFundData(shortName);
  });

  document.getElementById("refreshBtn").addEventListener("click", async () => {
    await initPage(true);
  });

  document.getElementById("crawlBtn").addEventListener("click", async () => {
    await crawlRecentData(3);
  });

  document.getElementById("benchmarkBtn").addEventListener("click", async () => {
    await crawlBenchmarkData();
  });

  document.getElementById("benchmarkSelector").addEventListener("change", async (event) => {
    state.currentBenchmark = event.target.value;
    if (state.currentFund) {
      await loadFundData(state.currentFund);
    }
  });

  document.querySelectorAll(".tab-item").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  document.querySelectorAll(".range-chip").forEach((button) => {
    button.addEventListener("click", () => {
      state.range = button.dataset.range;
      applyRangePreset(button.dataset.range);
    });
  });

  document.querySelectorAll('[data-timeline-role="start"]').forEach((input) => {
    input.addEventListener("input", (event) => {
      updateTimelineBoundary("start", Number(event.target.value));
    });
  });

  document.querySelectorAll('[data-timeline-role="end"]').forEach((input) => {
    input.addEventListener("input", (event) => {
      updateTimelineBoundary("end", Number(event.target.value));
    });
  });
}

function configureAdminActions() {
  const refreshBtn = document.getElementById("refreshBtn");
  const benchmarkBtn = document.getElementById("benchmarkBtn");
  const crawlBtn = document.getElementById("crawlBtn");
  const shouldShow = !state.publicShareMode;

  if (refreshBtn) {
    refreshBtn.style.display = shouldShow ? "" : "none";
  }

  if (benchmarkBtn) {
    benchmarkBtn.style.display = shouldShow ? "" : "none";
  }

  if (crawlBtn) {
    crawlBtn.style.display = shouldShow ? "" : "none";
  }
}

function getApiCandidates() {
  const candidates = [];
  const configuredBase = (
    window.PUBLIC_API_BASE
    || document.querySelector('meta[name="public-api-base"]')?.content
    || ""
  ).trim().replace(/\/$/, "");

  if (configuredBase && !configuredBase.includes("your-public-api-domain.com")) {
    candidates.push(configuredBase);
  }

  if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
    candidates.push(window.location.origin);
  }

  return [...new Set(candidates)];
}

async function resolveApiBase() {
  for (const candidate of getApiCandidates()) {
    try {
      const response = await fetch(`${candidate}/api/public-dashboard`, { cache: "no-store" });
      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      if (payload?.status === "success") {
        return candidate;
      }
    } catch (error) {
      continue;
    }
  }

  throw new Error("未找到可用后端，请先运行 python server.py，然后从 http://127.0.0.1:5000/ 打开页面。");
}

function buildApiUrl(path) {
  if (!state.apiBase) {
    throw new Error("后端尚未连接，请先运行 python server.py。");
  }

  return `${state.apiBase}${path}`;
}

function setActiveRangeChip(range) {
  document.querySelectorAll(".range-chip").forEach((button) => {
    button.classList.toggle("active", button.dataset.range === range);
  });
}

function resetTimelineUI() {
  document.querySelectorAll('[data-timeline-role="start"]').forEach((input) => {
    input.min = "0";
    input.max = "0";
    input.value = "0";
  });

  document.querySelectorAll('[data-timeline-role="end"]').forEach((input) => {
    input.min = "0";
    input.max = "0";
    input.value = "0";
  });

  document.querySelectorAll('[data-timeline-role="start-label"]').forEach((node) => {
    node.textContent = "--";
  });
  document.querySelectorAll('[data-timeline-role="end-label"]').forEach((node) => {
    node.textContent = "--";
  });
  document.querySelectorAll('[data-timeline-role="range-label"]').forEach((node) => {
    node.textContent = "Timeline";
  });
  syncTimelineAxis(0, 0, 0);
}

function syncTimelineAxis(start, end, maxIndex) {
  const safeMax = Math.max(0, maxIndex);
  const startPercent = safeMax > 0 ? (start / safeMax) * 100 : 0;
  const endPercent = safeMax > 0 ? (end / safeMax) * 100 : 100;

  document.querySelectorAll('[data-timeline-role="axis"]').forEach((node) => {
    node.style.setProperty("--range-start", `${startPercent}%`);
    node.style.setProperty("--range-end", `${endPercent}%`);
  });
}

function syncTimelineUI() {
  const data = state.rangeData;
  if (!data || !Array.isArray(data.dates) || !data.dates.length) {
    resetTimelineUI();
    return;
  }

  const maxIndex = data.dates.length - 1;
  const start = Math.max(0, Math.min(state.viewStart, maxIndex));
  const end = Math.max(start, Math.min(state.viewEnd, maxIndex));

  document.querySelectorAll('[data-timeline-role="start"]').forEach((input) => {
    input.min = "0";
    input.max = String(maxIndex);
    input.value = String(start);
  });

  document.querySelectorAll('[data-timeline-role="end"]').forEach((input) => {
    input.min = "0";
    input.max = String(maxIndex);
    input.value = String(end);
  });

  const startLabel = data.dates[start] || "--";
  const endLabel = data.dates[end] || "--";
  const rangeLabel = `${startLabel} -> ${endLabel}`;

  document.querySelectorAll('[data-timeline-role="start-label"]').forEach((node) => {
    node.textContent = startLabel;
  });
  document.querySelectorAll('[data-timeline-role="end-label"]').forEach((node) => {
    node.textContent = endLabel;
  });
  document.querySelectorAll('[data-timeline-role="range-label"]').forEach((node) => {
    node.textContent = rangeLabel;
  });
  syncTimelineAxis(start, end, maxIndex);
}

function initializeTimeline() {
  const data = state.rangeData;
  if (!data || !Array.isArray(data.dates) || !data.dates.length) {
    state.viewStart = 0;
    state.viewEnd = 0;
    resetTimelineUI();
    return;
  }

  state.viewStart = 0;
  state.viewEnd = data.dates.length - 1;
  applyRangePreset(state.range || "all");
}

function applyRangePreset(range) {
  const data = state.rangeData;
  if (!data || !Array.isArray(data.dates) || !data.dates.length) {
    return;
  }

  const total = data.dates.length;
  const lastIndex = total - 1;
  let start = 0;

  if (range !== "all") {
    const size = Number(range);
    if (Number.isFinite(size) && size > 0) {
      start = Math.max(0, total - size);
    }
  }

  state.range = range;
  state.viewStart = start;
  state.viewEnd = lastIndex;
  setActiveRangeChip(range);
  syncTimelineUI();
  updateCharts();
}

function updateTimelineBoundary(boundary, value) {
  const data = state.rangeData;
  if (!data || !Array.isArray(data.dates) || !data.dates.length) {
    return;
  }

  const maxIndex = data.dates.length - 1;
  const nextValue = Math.max(0, Math.min(value, maxIndex));

  if (boundary === "start") {
    state.viewStart = Math.min(nextValue, state.viewEnd);
  } else {
    state.viewEnd = Math.max(nextValue, state.viewStart);
  }

  document.querySelectorAll(".range-chip").forEach((button) => button.classList.remove("active"));
  syncTimelineUI();
  updateCharts();
}

async function initPage(keepSelection = false) {
  showStatus("正在加载基金列表...", "info");

  try {
    const [fundResult, statusResult] = await Promise.all([
      fetchJSON(buildApiUrl("/get-fund-list")),
      fetchJSON(buildApiUrl("/api/status")),
    ]);

    state.fundList = fundResult.data || [];
    state.publicShareMode = Boolean(statusResult?.public_share_mode);
    state.benchmarkOptions = Array.isArray(statusResult?.benchmarks) && statusResult.benchmarks.length
      ? statusResult.benchmarks
      : DEFAULT_BENCHMARK_OPTIONS.slice();
    configureAdminActions();
    renderBenchmarkSelector(state.benchmarkOptions);
    renderFundSelector(state.fundList);

    if (!state.fundList.length) {
      resetPage();
      showStatus("当前数据库还没有基金净值，请先点击“抓取近 3 天邮件”或运行 initial_crawl.py。", "warning");
      return;
    }

    let nextFund = state.currentFund;
    if (!keepSelection || !state.fundList.some((item) => item.short_name === nextFund)) {
      nextFund = state.fundList[0].short_name;
    }

    document.getElementById("fundSelector").value = nextFund;
    state.currentFund = nextFund;
    await loadFundData(nextFund);
    showStatus(`已加载 ${state.fundList.length} 只基金。`, "success");
  } catch (error) {
    resetPage();
    showStatus(`加载基金列表失败：${error.message}`, "error", true);
  }
}

function renderFundSelector(funds) {
  const selector = document.getElementById("fundSelector");
  selector.innerHTML = '<option value="">请选择基金</option>';

  funds.forEach((fund) => {
    const option = document.createElement("option");
    option.value = fund.short_name;
    option.textContent = `${fund.short_name} · ${fund.latest_date}`;
    selector.appendChild(option);
  });
}

function renderBenchmarkSelector(options) {
  const selector = document.getElementById("benchmarkSelector");
  const benchmarkOptions = Array.isArray(options) && options.length
    ? options
    : DEFAULT_BENCHMARK_OPTIONS;

  if (!benchmarkOptions.some((item) => item.code === state.currentBenchmark)) {
    state.currentBenchmark = benchmarkOptions[0].code;
  }

  selector.innerHTML = benchmarkOptions.map((item) => (
    `<option value="${item.code}">${item.name}</option>`
  )).join("");
  selector.value = state.currentBenchmark;
}

function getBenchmarkOptions(data = state.rangeData) {
  if (Array.isArray(data?.benchmark_options) && data.benchmark_options.length) {
    return data.benchmark_options;
  }
  if (Array.isArray(state.benchmarkOptions) && state.benchmarkOptions.length) {
    return state.benchmarkOptions;
  }
  return DEFAULT_BENCHMARK_OPTIONS;
}

function getBenchmarkByCode(code, data = state.rangeData) {
  return getBenchmarkOptions(data).find((item) => item.code === code) || null;
}

function getSelectedBenchmarkData(data = state.rangeData) {
  if (!data?.benchmarks) {
    return null;
  }
  return data.benchmarks[state.currentBenchmark]
    || data.benchmarks[data.selected_benchmark_code]
    || null;
}

async function loadFundData(shortName) {
  showStatus(`正在加载 ${shortName} 的净值数据...`, "info");

  try {
    const benchmarkQuery = `?benchmark_code=${encodeURIComponent(state.currentBenchmark)}`;
    const [rangeResult, performanceResult, returnResult, riskResult, netListResult] = await Promise.all([
      fetchJSON(buildApiUrl(`/get-fund-range-data/${encodeURIComponent(shortName)}${benchmarkQuery}`)),
      fetchJSON(buildApiUrl(`/get-fund-performance/${encodeURIComponent(shortName)}`)),
      fetchJSON(buildApiUrl(`/get-fund-return-indicators/${encodeURIComponent(shortName)}${benchmarkQuery}`)),
      fetchJSON(buildApiUrl(`/get-fund-risk-indicators/${encodeURIComponent(shortName)}${benchmarkQuery}`)),
      fetchJSON(buildApiUrl(`/get-fund-net-value-list/${encodeURIComponent(shortName)}`)),
    ]);

    state.rangeData = rangeResult.data || null;
    state.benchmarkOptions = getBenchmarkOptions(rangeResult.data);
    renderBenchmarkSelector(state.benchmarkOptions);

    renderSummary(rangeResult.data);
    renderTopIndicators(rangeResult.data);
    renderRiskIndicators(rangeResult.data);
    renderPerformanceTable(performanceResult.data || []);
    renderIndicatorTable("returnBody", returnResult.data || []);
    renderIndicatorTable("riskBody", riskResult.data || []);
    renderNetValueTable(netListResult.data || []);
    initializeTimeline();

    showStatus(`已加载 ${shortName} 的可视化数据。`, "success");
  } catch (error) {
    resetPage();
    showStatus(`加载基金数据失败：${error.message}`, "error", true);
  }
}

function renderSummary(data) {
  setText("cardName", data?.fund_name_short || "--");
  setText("cardDate", data?.latest_date || "--");
  setText("cardUnitNav", formatValue(data?.latest_unit_net, 4));
  setText("cardAccumNav", formatValue(data?.latest_accum_net, 4));
}

function renderTopIndicators(data) {
  const selectedBenchmark = getSelectedBenchmarkData(data);
  const benchmarkName = selectedBenchmark?.name
    || data?.selected_benchmark_name
    || getBenchmarkByCode(state.currentBenchmark, data)?.name
    || "主基准";

  setText("benchmarkReturnLabel", `${benchmarkName}累计收益`);
  setText("alphaLabel", `Alpha（${benchmarkName}）`);
  setText("betaLabel", `Beta（${benchmarkName}）`);
  setText("cumReturn", formatPercent(data?.cumulative_return));
  setText("annualReturn", formatPercent(data?.annualized_return));
  setText("benchmarkReturn", formatPercent(selectedBenchmark?.period_return ?? data?.benchmark_cumulative_return));
  setText("alpha", formatValue(selectedBenchmark?.alpha ?? data?.alpha, 4));
  setText("beta", formatValue(selectedBenchmark?.beta ?? data?.beta, 4));
  setText("sharpe", formatValue(data?.sharpe_ratio, 4));
  setText("winRate", formatPercent(data?.win_rate));
  setText("profitLossRatio", formatValue(data?.profit_loss_ratio, 4));
  setText("volatility", formatPercent(data?.return_volatility));
  setText("maxDrawdown", formatPercent(data?.max_drawdown));
  renderBenchmarkSummary(data);
}

function renderRiskIndicators(data) {
  setText("riskAnnualVol", formatPercent(data?.annual_volatility));
  setText("downsideRisk", formatPercent(data?.downside_risk));
  setText("recoveryDays", data?.max_drawdown_recovery_days ?? "--");
  setText("maxSingleDrop", formatPercent(data?.max_single_drop));
  setText("maxConsecLoss", data?.max_consecutive_loss_days ?? "--");
  setText("lossRatio", formatPercent(data?.loss_period_ratio));
  setText("drawdownStart", data?.max_drawdown_start_date || "--");
  setText("drawdownEnd", data?.max_drawdown_end_date || "--");
}

function renderBenchmarkSummary(data) {
  const container = document.getElementById("benchmarkSummaryGrid");
  const options = getBenchmarkOptions(data);

  if (!options.length) {
    container.innerHTML = `
      <article class="metric-card benchmark-card-empty">
        <span>基准收益对比</span>
        <strong>--</strong>
      </article>
    `;
    return;
  }

  container.innerHTML = options.map((item) => {
    const benchmark = data?.benchmarks?.[item.code];
    const activeClass = item.code === state.currentBenchmark ? " benchmark-card-active" : "";
    return `
      <article class="metric-card${activeClass}">
        <span>${item.name}累计收益</span>
        <strong>${formatPercent(benchmark?.period_return)}</strong>
      </article>
    `;
  }).join("");
}

function renderPerformanceTable(rows) {
  const body = document.getElementById("performanceBody");

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="2" class="empty-row">暂无阶段收益数据</td></tr>';
    return;
  }

  body.innerHTML = rows.map((item) => {
    const value = item.return == null ? "--" : `${Number(item.return).toFixed(2)}%`;
    const className = item.return == null ? "" : item.return >= 0 ? "up" : "down";
    return `<tr><td>${item.period}</td><td class="${className}">${value}</td></tr>`;
  }).join("");
}

function renderIndicatorTable(bodyId, rows) {
  const body = document.getElementById(bodyId);

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-row">暂无指标数据</td></tr>';
    return;
  }

  body.innerHTML = rows.map((item) => `
    <tr>
      <td>${item.indicator}</td>
      <td>${item.week ?? "--"}</td>
      <td>${item.month ?? "--"}</td>
      <td>${item.quarter ?? "--"}</td>
      <td>${item.half_year ?? "--"}</td>
    </tr>
  `).join("");
}

function renderNetValueTable(rows) {
  const body = document.getElementById("netlistBody");

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty-row">暂无净值明细</td></tr>';
    return;
  }

  body.innerHTML = rows.map((item) => {
    const change = item.net_change == null ? "--" : `${Number(item.net_change).toFixed(2)}%`;
    const className = item.net_change == null ? "" : item.net_change >= 0 ? "up" : "down";

    return `
      <tr>
        <td>${item.net_date}</td>
        <td>${formatValue(item.unit_net, 4)}</td>
        <td>${formatValue(item.accum_net, 4)}</td>
        <td class="${className}">${change}</td>
      </tr>
    `;
  }).join("");
}

function getChartWindow(dataLength) {
  if (!dataLength) {
    return { start: 0, end: 0 };
  }

  const start = Math.max(0, Math.min(state.viewStart, dataLength - 1));
  const end = Math.max(start + 1, Math.min(state.viewEnd + 1, dataLength));
  return { start, end };
}

function computeDrawdownSeries(values) {
  if (!Array.isArray(values) || !values.length) {
    return [];
  }

  let runningMax = null;

  return values.map((value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return 0;
    }

    runningMax = runningMax == null ? numeric : Math.max(runningMax, numeric);
    return Number((((runningMax - numeric) / runningMax) * 100).toFixed(6));
  });
}

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function sampleMean(values) {
  if (!Array.isArray(values) || !values.length) {
    return null;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values) {
  if (!Array.isArray(values) || values.length < 2) {
    return null;
  }

  const mean = sampleMean(values);
  const squaredDiffSum = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0);
  return squaredDiffSum / (values.length - 1);
}

function sampleStd(values) {
  const variance = sampleVariance(values);
  return variance == null ? null : Math.sqrt(variance);
}

function sampleCovariance(seriesA, seriesB) {
  if (!Array.isArray(seriesA) || !Array.isArray(seriesB) || seriesA.length !== seriesB.length || seriesA.length < 2) {
    return null;
  }

  const meanA = sampleMean(seriesA);
  const meanB = sampleMean(seriesB);
  let total = 0;

  for (let index = 0; index < seriesA.length; index += 1) {
    total += (seriesA[index] - meanA) * (seriesB[index] - meanB);
  }

  return total / (seriesA.length - 1);
}

function parseDateOnly(value) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function diffDays(startDate, endDate) {
  if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
    return null;
  }

  const milliseconds = endDate.getTime() - startDate.getTime();
  if (!Number.isFinite(milliseconds)) {
    return null;
  }

  return Math.round(milliseconds / (24 * 60 * 60 * 1000));
}

function findFirstValidIndex(values, requirePositive = true) {
  for (let index = 0; index < values.length; index += 1) {
    const numeric = toFiniteNumber(values[index]);
    if (numeric == null) {
      continue;
    }
    if (!requirePositive || numeric > 0) {
      return index;
    }
  }

  return -1;
}

function findLastValidIndex(values, requirePositive = true) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const numeric = toFiniteNumber(values[index]);
    if (numeric == null) {
      continue;
    }
    if (!requirePositive || numeric > 0) {
      return index;
    }
  }

  return -1;
}

function calculateSeriesPeriodReturn(values) {
  if (!Array.isArray(values) || values.length < 2) {
    return null;
  }

  const startIndex = findFirstValidIndex(values, true);
  const endIndex = findLastValidIndex(values, true);
  if (startIndex < 0 || endIndex <= startIndex) {
    return null;
  }

  const startValue = toFiniteNumber(values[startIndex]);
  const endValue = toFiniteNumber(values[endIndex]);
  if (startValue == null || endValue == null || startValue === 0) {
    return null;
  }

  return ((endValue / startValue) - 1) * 100;
}

function calculateAnnualizedReturn(values, dates) {
  if (!Array.isArray(values) || !Array.isArray(dates) || values.length < 2 || dates.length < 2) {
    return null;
  }

  const startIndex = findFirstValidIndex(values, true);
  const endIndex = findLastValidIndex(values, true);
  if (startIndex < 0 || endIndex <= startIndex) {
    return null;
  }

  const startValue = toFiniteNumber(values[startIndex]);
  const endValue = toFiniteNumber(values[endIndex]);
  const startDate = parseDateOnly(dates[startIndex]);
  const endDate = parseDateOnly(dates[endIndex]);
  const days = diffDays(startDate, endDate);

  if (startValue == null || endValue == null || startValue === 0 || days == null || days <= 0) {
    return null;
  }

  return (((endValue / startValue) ** (365 / days)) - 1) * 100;
}

function computeDailyReturnSeries(values) {
  if (!Array.isArray(values) || values.length < 2) {
    return [];
  }

  const returns = [];
  for (let index = 1; index < values.length; index += 1) {
    const prevValue = toFiniteNumber(values[index - 1]);
    const currentValue = toFiniteNumber(values[index]);
    if (prevValue == null || currentValue == null || prevValue === 0) {
      continue;
    }
    returns.push((currentValue / prevValue) - 1);
  }

  return returns;
}

function computeAlignedReturnPairs(fundValues, benchmarkValues) {
  if (!Array.isArray(fundValues) || !Array.isArray(benchmarkValues)) {
    return [];
  }

  const pairs = [];
  const length = Math.min(fundValues.length, benchmarkValues.length);
  for (let index = 1; index < length; index += 1) {
    const prevFund = toFiniteNumber(fundValues[index - 1]);
    const currentFund = toFiniteNumber(fundValues[index]);
    const prevBenchmark = toFiniteNumber(benchmarkValues[index - 1]);
    const currentBenchmark = toFiniteNumber(benchmarkValues[index]);

    if (
      prevFund == null
      || currentFund == null
      || prevBenchmark == null
      || currentBenchmark == null
      || prevFund === 0
      || prevBenchmark === 0
    ) {
      continue;
    }

    pairs.push({
      fundReturn: (currentFund / prevFund) - 1,
      benchmarkReturn: (currentBenchmark / prevBenchmark) - 1,
    });
  }

  return pairs;
}

function calculateSharpeRatio(returns) {
  const volatility = sampleStd(returns);
  if (volatility == null || volatility === 0) {
    return null;
  }

  const dailyRf = RISK_FREE_RATE / TRADING_DAYS;
  const meanReturn = sampleMean(returns);
  if (meanReturn == null) {
    return null;
  }

  return ((meanReturn - dailyRf) / volatility) * Math.sqrt(TRADING_DAYS);
}

function calculateAnnualVolatility(returns) {
  const volatility = sampleStd(returns);
  return volatility == null ? null : volatility * Math.sqrt(TRADING_DAYS) * 100;
}

function calculateDownsideRisk(returns) {
  const downside = returns.filter((value) => value < 0);
  const downsideStd = sampleStd(downside);
  return downsideStd == null ? null : downsideStd * Math.sqrt(TRADING_DAYS) * 100;
}

function calculateWinRate(returns) {
  if (!Array.isArray(returns) || !returns.length) {
    return null;
  }

  return (returns.filter((value) => value > 0).length / returns.length) * 100;
}

function calculateProfitLossRatio(returns) {
  const positive = returns.filter((value) => value > 0);
  const negative = returns.filter((value) => value < 0);
  if (!positive.length || !negative.length) {
    return null;
  }

  const positiveMean = sampleMean(positive);
  const negativeMean = sampleMean(negative);
  if (positiveMean == null || negativeMean == null || negativeMean === 0) {
    return null;
  }

  return positiveMean / Math.abs(negativeMean);
}

function calculateReturnVolatility(returns) {
  const volatility = sampleStd(returns);
  return volatility == null ? null : volatility * 100;
}

function calculateAlphaBeta(fundValues, benchmarkValues) {
  const pairs = computeAlignedReturnPairs(fundValues, benchmarkValues);
  if (pairs.length < 2) {
    return { alpha: null, beta: null };
  }

  const fundReturns = pairs.map((item) => item.fundReturn);
  const benchmarkReturns = pairs.map((item) => item.benchmarkReturn);
  const benchmarkVariance = sampleVariance(benchmarkReturns);
  const covariance = sampleCovariance(fundReturns, benchmarkReturns);
  if (benchmarkVariance == null || covariance == null || benchmarkVariance === 0) {
    return { alpha: null, beta: null };
  }

  const beta = covariance / benchmarkVariance;
  const dailyRf = RISK_FREE_RATE / TRADING_DAYS;
  const fundMean = sampleMean(fundReturns);
  const benchmarkMean = sampleMean(benchmarkReturns);
  if (fundMean == null || benchmarkMean == null) {
    return { alpha: null, beta: null };
  }

  const alphaDaily = (fundMean - dailyRf) - (beta * (benchmarkMean - dailyRf));
  return {
    alpha: alphaDaily * TRADING_DAYS,
    beta,
  };
}

function calculateMaxSingleDrop(returns) {
  if (!Array.isArray(returns) || !returns.length) {
    return null;
  }

  const negativeReturns = returns.filter((value) => value < 0);
  if (!negativeReturns.length) {
    return 0;
  }

  return Math.abs(Math.min(...negativeReturns)) * 100;
}

function calculateMaxConsecutiveLossDays(returns) {
  if (!Array.isArray(returns) || !returns.length) {
    return null;
  }

  let maxStreak = 0;
  let current = 0;
  returns.forEach((value) => {
    if (value < 0) {
      current += 1;
      maxStreak = Math.max(maxStreak, current);
    } else {
      current = 0;
    }
  });
  return maxStreak;
}

function calculateLossPeriodRatio(returns) {
  if (!Array.isArray(returns) || !returns.length) {
    return null;
  }

  return (returns.filter((value) => value < 0).length / returns.length) * 100;
}

function calculateDrawdownProfile(values, dates) {
  if (!Array.isArray(values) || !values.length) {
    return {
      maxDrawdown: null,
      startDate: null,
      endDate: null,
      recoveryDays: null,
    };
  }

  const drawdownSeries = computeDrawdownSeries(values);
  if (!drawdownSeries.length) {
    return {
      maxDrawdown: null,
      startDate: null,
      endDate: null,
      recoveryDays: null,
    };
  }

  let endPos = 0;
  for (let index = 1; index < drawdownSeries.length; index += 1) {
    if (drawdownSeries[index] > drawdownSeries[endPos]) {
      endPos = index;
    }
  }

  const maxDrawdown = drawdownSeries[endPos];
  let peakValue = -Infinity;
  let startPos = 0;
  for (let index = 0; index <= endPos; index += 1) {
    const numeric = toFiniteNumber(values[index]);
    if (numeric == null) {
      continue;
    }
    if (numeric >= peakValue) {
      peakValue = numeric;
      startPos = index;
    }
  }

  let recoveryDays = null;
  if (Number.isFinite(peakValue)) {
    for (let index = endPos + 1; index < values.length; index += 1) {
      const numeric = toFiniteNumber(values[index]);
      if (numeric != null && numeric >= peakValue) {
        recoveryDays = diffDays(parseDateOnly(dates[endPos]), parseDateOnly(dates[index]));
        break;
      }
    }
  }

  return {
    maxDrawdown,
    startDate: dates[startPos] || null,
    endDate: dates[endPos] || null,
    recoveryDays,
  };
}

function calculateWindowMetrics(data, start, end) {
  const dates = Array.isArray(data?.dates) ? data.dates.slice(start, end) : [];
  const unitNet = Array.isArray(data?.unit_net) ? data.unit_net.slice(start, end) : [];
  const accumNet = Array.isArray(data?.accum_net) ? data.accum_net.slice(start, end) : [];
  const fundReturns = computeDailyReturnSeries(unitNet);
  const drawdownProfile = calculateDrawdownProfile(unitNet, dates);
  const benchmarkMetrics = {};

  getBenchmarkOptions(data).forEach((option) => {
    const benchmark = data?.benchmarks?.[option.code];
    const closePrice = Array.isArray(benchmark?.close_price)
      ? benchmark.close_price.slice(start, end)
      : [];
    const regression = calculateAlphaBeta(unitNet, closePrice);

    benchmarkMetrics[option.code] = {
      code: option.code,
      name: benchmark?.name || option.name,
      periodReturn: calculateSeriesPeriodReturn(closePrice),
      alpha: regression.alpha,
      beta: regression.beta,
    };
  });

  const selectedCode = state.currentBenchmark || data?.selected_benchmark_code;
  const selectedBenchmark = benchmarkMetrics[selectedCode] || null;
  const lastIndex = dates.length - 1;

  return {
    latestDate: lastIndex >= 0 ? dates[lastIndex] : null,
    latestUnitNet: lastIndex >= 0 ? unitNet[lastIndex] : null,
    latestAccumNet: lastIndex >= 0 ? accumNet[lastIndex] : null,
    cumulativeReturn: calculateSeriesPeriodReturn(unitNet),
    annualizedReturn: calculateAnnualizedReturn(unitNet, dates),
    sharpeRatio: calculateSharpeRatio(fundReturns),
    winRate: calculateWinRate(fundReturns),
    profitLossRatio: calculateProfitLossRatio(fundReturns),
    returnVolatility: calculateReturnVolatility(fundReturns),
    maxDrawdown: drawdownProfile.maxDrawdown,
    annualVolatility: calculateAnnualVolatility(fundReturns),
    downsideRisk: calculateDownsideRisk(fundReturns),
    maxDrawdownRecoveryDays: drawdownProfile.recoveryDays,
    maxSingleDrop: calculateMaxSingleDrop(fundReturns),
    maxConsecutiveLossDays: calculateMaxConsecutiveLossDays(fundReturns),
    lossPeriodRatio: calculateLossPeriodRatio(fundReturns),
    maxDrawdownStartDate: drawdownProfile.startDate,
    maxDrawdownEndDate: drawdownProfile.endDate,
    selectedBenchmarkName: selectedBenchmark?.name || getBenchmarkByCode(selectedCode, data)?.name || "主基准",
    benchmarkReturn: selectedBenchmark?.periodReturn ?? null,
    alpha: selectedBenchmark?.alpha ?? null,
    beta: selectedBenchmark?.beta ?? null,
    benchmarkMetrics,
  };
}

function renderWindowBenchmarkSummary(data, metrics) {
  const container = document.getElementById("benchmarkSummaryGrid");
  const options = getBenchmarkOptions(data);

  if (!options.length) {
    container.innerHTML = `
      <article class="metric-card benchmark-card-empty">
        <span>基准收益对比</span>
        <strong>--</strong>
      </article>
    `;
    return;
  }

  container.innerHTML = options.map((item) => {
    const benchmarkMetric = metrics?.benchmarkMetrics?.[item.code];
    const activeClass = item.code === state.currentBenchmark ? " benchmark-card-active" : "";
    return `
      <article class="metric-card${activeClass}">
        <span>${item.name}累计收益</span>
        <strong>${formatPercent(benchmarkMetric?.periodReturn)}</strong>
      </article>
    `;
  }).join("");
}

function updateWindowMetrics(data, start, end) {
  const metrics = calculateWindowMetrics(data, start, end);
  const benchmarkName = metrics.selectedBenchmarkName || "主基准";

  setText("cardName", data?.fund_name_short || "--");
  setText("cardDate", metrics.latestDate || "--");
  setText("cardUnitNav", formatValue(metrics.latestUnitNet, 4));
  setText("cardAccumNav", formatValue(metrics.latestAccumNet, 4));

  setText("benchmarkReturnLabel", `${benchmarkName}累计收益`);
  setText("alphaLabel", `Alpha（${benchmarkName}）`);
  setText("betaLabel", `Beta（${benchmarkName}）`);
  setText("cumReturn", formatPercent(metrics.cumulativeReturn));
  setText("annualReturn", formatPercent(metrics.annualizedReturn));
  setText("benchmarkReturn", formatPercent(metrics.benchmarkReturn));
  setText("alpha", formatValue(metrics.alpha, 4));
  setText("beta", formatValue(metrics.beta, 4));
  setText("sharpe", formatValue(metrics.sharpeRatio, 4));
  setText("winRate", formatPercent(metrics.winRate));
  setText("profitLossRatio", formatValue(metrics.profitLossRatio, 4));
  setText("volatility", formatPercent(metrics.returnVolatility));
  setText("maxDrawdown", formatPercent(metrics.maxDrawdown));

  setText("riskAnnualVol", formatPercent(metrics.annualVolatility));
  setText("downsideRisk", formatPercent(metrics.downsideRisk));
  setText("recoveryDays", metrics.maxDrawdownRecoveryDays ?? "--");
  setText("maxSingleDrop", formatPercent(metrics.maxSingleDrop));
  setText("maxConsecLoss", metrics.maxConsecutiveLossDays ?? "--");
  setText("lossRatio", formatPercent(metrics.lossPeriodRatio));
  setText("drawdownStart", metrics.maxDrawdownStartDate || "--");
  setText("drawdownEnd", metrics.maxDrawdownEndDate || "--");

  renderWindowBenchmarkSummary(data, metrics);
}

function getBenchmarkWindowSeries(data, start, end) {
  const selectedCode = state.currentBenchmark || data?.selected_benchmark_code;
  const selectedOption = getBenchmarkByCode(selectedCode, data);
  if (!selectedOption) {
    return [];
  }

  const benchmark = data?.benchmarks?.[selectedOption.code];
  const closePrice = Array.isArray(benchmark?.close_price)
    ? benchmark.close_price.slice(start, end)
    : [];
  // Recalculate drawdown inside the current window so the visible range
  // always starts from the window's local high-water mark.
  const drawdown = computeDrawdownSeries(closePrice);
  const hasPriceData = closePrice.some((value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0;
  });

  if (!hasPriceData) {
    return [];
  }

  return [{
    code: selectedOption.code,
    name: benchmark?.name || selectedOption.name,
    drawdown,
    hasPriceData: true,
    active: true,
  }];
}

function updateCharts() {
  const data = state.rangeData;
  if (!data || !Array.isArray(data.dates) || !data.dates.length) {
    destroyCharts();
    return;
  }

  const { start, end } = getChartWindow(data.dates.length);
  const labels = data.dates.slice(start, end);
  const unitNet = data.unit_net.slice(start, end);
  const accumNet = data.accum_net.slice(start, end);
  const fundDrawdown = computeDrawdownSeries(unitNet);
  const benchmarkSeries = getBenchmarkWindowSeries(data, start, end);

  updateWindowMetrics(data, start, end);

  if (typeof window.Chart !== "function") {
    state.chartLibraryUnavailable = true;
    destroyCharts();
    console.warn("Chart.js 未加载，跳过图表渲染，但其余数据会继续显示。");
    return;
  }

  try {
    state.chartLibraryUnavailable = false;
    renderFundChart(labels, unitNet, accumNet);
    renderDrawdownChart(labels, fundDrawdown, benchmarkSeries);
  } catch (error) {
    destroyCharts();
    console.error("图表渲染失败:", error);
  }
}

function renderFundChart(labels, unitNet, accumNet) {
  const ctx = document.getElementById("fundChart").getContext("2d");
  if (state.fundChart) {
    state.fundChart.destroy();
  }

  state.fundChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "单位净值",
          data: unitNet,
          borderColor: "#db5b45",
          backgroundColor: "rgba(219, 91, 69, 0.10)",
          borderWidth: 2.5,
          fill: true,
          tension: 0.18,
          pointRadius: 0,
          pointHoverRadius: 4,
        },
        {
          label: "累计净值",
          data: accumNet,
          borderColor: "#1f5eff",
          backgroundColor: "rgba(31, 94, 255, 0.08)",
          borderWidth: 2.5,
          fill: true,
          tension: 0.18,
          pointRadius: 0,
          pointHoverRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", align: "start" },
        tooltip: {
          callbacks: {
            label(context) {
              if (context.raw == null || Number.isNaN(Number(context.raw))) {
                return `${context.dataset.label}: --`;
              }
              return `${context.dataset.label}: ${Number(context.raw).toFixed(4)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 10, color: "#5f6b7a" },
          grid: { color: "rgba(79, 98, 148, 0.08)" },
        },
        y: {
          ticks: {
            color: "#5f6b7a",
            callback(value) {
              return Number(value).toFixed(3);
            },
          },
          grid: { color: "rgba(79, 98, 148, 0.08)" },
        },
      },
    },
  });
}

function renderDrawdownChart(labels, fundDrawdown, benchmarkSeries = []) {
  const ctx = document.getElementById("drawdownChart").getContext("2d");
  if (state.drawdownChart) {
    state.drawdownChart.destroy();
  }

  const benchmarkDatasets = benchmarkSeries.map((item) => {
    const style = BENCHMARK_STYLES[item.code] || BENCHMARK_STYLES["000300"];
    return {
      label: `${item.name}回撤`,
      data: item.drawdown,
      borderColor: style.borderColor,
      backgroundColor: style.backgroundColor,
      borderWidth: item.active ? 2.5 : 2,
      fill: false,
      tension: 0.18,
      pointRadius: 0,
      pointHoverRadius: 4,
      borderDash: item.active ? [] : [6, 4],
      spanGaps: true,
    };
  });

  state.drawdownChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "基金回撤",
          data: fundDrawdown,
          borderColor: "#101828",
          backgroundColor: "rgba(16, 24, 40, 0.10)",
          borderWidth: 2.5,
          fill: true,
          tension: 0.18,
          pointRadius: 0,
          pointHoverRadius: 4,
        },
        ...benchmarkDatasets,
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", align: "start" },
        tooltip: {
          callbacks: {
            label(context) {
              if (context.raw == null || Number.isNaN(Number(context.raw))) {
                return `${context.dataset.label}: --`;
              }
              return `${context.dataset.label}: ${Number(context.raw).toFixed(2)}%`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 10, color: "#5f6b7a" },
          grid: { color: "rgba(79, 98, 148, 0.08)" },
        },
        y: {
          reverse: true,
          ticks: {
            color: "#5f6b7a",
            callback(value) {
              return `${Number(value).toFixed(1)}%`;
            },
          },
          grid: { color: "rgba(79, 98, 148, 0.08)" },
        },
      },
    },
  });
}

async function crawlRecentData(days) {
  if (state.publicShareMode) {
    showStatus("当前公开链接为只读模式，已禁用邮件抓取。", "warning", true);
    return;
  }

  const button = document.getElementById("crawlBtn");
  button.disabled = true;
  button.textContent = "抓取中...";
  showStatus(`正在抓取最近 ${days} 天邮件，请稍候...`, "info", true);

  try {
    const result = await fetchJSON(buildApiUrl(`/crawl-email?days=${days}`));
    showStatus(result.message || "抓取完成。", result.status === "success" ? "success" : "warning");
    await initPage(true);
  } catch (error) {
    showStatus(`抓取失败：${error.message}`, "error", true);
  } finally {
    button.disabled = false;
    button.textContent = "抓取近 3 天邮件";
  }
}

async function crawlBenchmarkData() {
  if (state.publicShareMode) {
    showStatus("当前公开链接为只读模式，已禁用基准同步。", "warning", true);
    return;
  }

  const button = document.getElementById("benchmarkBtn");
  button.disabled = true;
  button.textContent = "同步中...";
  showStatus("正在同步沪深300、上证指数和中证1000，请稍候...", "info", true);

  try {
    const result = await fetchJSON(buildApiUrl("/crawl-benchmark"));
    const message = result.message || "基准指数同步完成。";

    if (state.currentFund) {
      await loadFundData(state.currentFund);
    } else {
      await initPage(true);
    }

    showStatus(message, result.status === "warning" ? "warning" : "success");
  } catch (error) {
    showStatus(`同步基准指数失败：${error.message}`, "error", true);
  } finally {
    button.disabled = false;
    button.textContent = "同步基准指数";
  }
}

function switchTab(tabName) {
  document.querySelectorAll(".tab-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-content").forEach((content) => {
    content.classList.toggle("active", content.id === `${tabName}Tab`);
  });
}

function resetPage() {
  state.rangeData = null;
  state.viewStart = 0;
  state.viewEnd = 0;
  state.range = "all";
  destroyCharts();
  resetTimelineUI();
  setActiveRangeChip("all");

  [
    "cardName", "cardDate", "cardUnitNav", "cardAccumNav", "cumReturn", "annualReturn",
    "benchmarkReturn", "alpha", "beta", "sharpe", "winRate", "profitLossRatio",
    "volatility", "maxDrawdown", "riskAnnualVol", "downsideRisk", "recoveryDays",
    "maxSingleDrop", "maxConsecLoss", "lossRatio", "drawdownStart", "drawdownEnd",
  ].forEach((id) => setText(id, "--"));
  setText("benchmarkReturnLabel", "主基准累计收益");
  setText("alphaLabel", "Alpha");
  setText("betaLabel", "Beta");
  document.getElementById("benchmarkSummaryGrid").innerHTML = `
    <article class="metric-card benchmark-card-empty">
      <span>基准收益对比</span>
      <strong>--</strong>
    </article>
  `;

  document.getElementById("performanceBody").innerHTML = '<tr><td colspan="2" class="empty-row">请选择基金后查看</td></tr>';
  document.getElementById("returnBody").innerHTML = '<tr><td colspan="5" class="empty-row">请选择基金后查看</td></tr>';
  document.getElementById("riskBody").innerHTML = '<tr><td colspan="5" class="empty-row">请选择基金后查看</td></tr>';
  document.getElementById("netlistBody").innerHTML = '<tr><td colspan="4" class="empty-row">请选择基金后查看</td></tr>';
}

function destroyCharts() {
  if (state.fundChart) {
    state.fundChart.destroy();
    state.fundChart = null;
  }

  if (state.drawdownChart) {
    state.drawdownChart.destroy();
    state.drawdownChart = null;
  }
}

async function fetchJSON(url) {
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    const preview = text.trim().slice(0, 80).replace(/\s+/g, " ");
    throw new Error(`接口返回了非 JSON 内容，请从 http://127.0.0.1:5000/ 打开页面。返回片段：${preview}`);
  }

  if (!response.ok || payload.status === "error") {
    throw new Error(payload.message || `请求失败：${response.status}`);
  }

  return payload;
}

function getApiCandidates() {
  return ["supabase-direct"];
}

async function resolveApiBase() {
  getSupabaseConfig();
  return "supabase-direct";
}

function buildApiUrl(path) {
  return path;
}

function startAutoRefresh() {
  if (startAutoRefresh.timer) {
    window.clearInterval(startAutoRefresh.timer);
  }

  startAutoRefresh.timer = window.setInterval(async () => {
    try {
      await initPage(true);
    } catch (error) {
      showStatus(`自动刷新失败：${error.message}`, "warning", true);
    }
  }, AUTO_REFRESH_MS);
}

async function initPage(keepSelection = false) {
  showStatus("正在从 Supabase 加载基金列表...", "info");

  try {
    const snapshot = await fetchSupabaseSnapshot();
    state.supabaseFundRows = snapshot.fundRows;
    state.supabaseBenchmarkRows = snapshot.benchmarkRows;
    state.fundList = buildFundListFromRows(snapshot.fundRows);
    state.publicShareMode = true;
    state.benchmarkOptions = DIRECT_SUPABASE_BENCHMARK_OPTIONS.slice();

    configureAdminActions();
    renderBenchmarkSelector(state.benchmarkOptions);
    renderFundSelector(state.fundList);

    if (!state.fundList.length) {
      resetPage();
      showStatus("Supabase 中还没有可展示的基金净值数据。", "warning", true);
      return;
    }

    let nextFund = state.currentFund;
    if (!keepSelection || !state.fundList.some((item) => item.short_name === nextFund)) {
      nextFund = state.fundList[0].short_name;
    }

    document.getElementById("fundSelector").value = nextFund;
    state.currentFund = nextFund;
    await loadFundData(nextFund);

    showStatus(`数据更新时间：${formatDateTimeValue()}`, "success");
  } catch (error) {
    resetPage();
    showStatus(`加载 Supabase 数据失败：${error.message}`, "error", true);
  }
}

async function loadFundData(shortName) {
  showStatus(`正在加载 ${shortName} 的净值数据...`, "info");

  try {
    const fundRows = (state.supabaseFundRows || []).filter((row) => row.fund_name_short === shortName);
    if (!fundRows.length) {
      throw new Error(`未找到基金 ${shortName} 的数据。`);
    }

    const fundPayload = buildFundPayloadFromRows(
      fundRows,
      state.supabaseBenchmarkRows || [],
      state.currentBenchmark,
    );

    if (!fundPayload) {
      throw new Error(`基金 ${shortName} 的可视化数据构建失败。`);
    }

    state.rangeData = fundPayload.range_data || null;
    state.benchmarkOptions = DIRECT_SUPABASE_BENCHMARK_OPTIONS.slice();

    renderBenchmarkSelector(state.benchmarkOptions);
    renderSummary(state.rangeData);
    renderTopIndicators(state.rangeData);
    renderRiskIndicators(state.rangeData);
    renderPerformanceTable(fundPayload.performance_data || []);
    renderIndicatorTable("returnBody", fundPayload.return_indicators || []);
    renderIndicatorTable("riskBody", fundPayload.risk_indicators || []);
    renderNetValueTable(fundPayload.net_value_list || []);
    initializeTimeline();

    showStatus(`已加载 ${shortName} 的 Supabase 数据。`, "success");
  } catch (error) {
    resetPage();
    showStatus(`加载基金数据失败：${error.message}`, "error", true);
  }
}

async function fetchJSON() {
  throw new Error("GitHub Pages 版本已改为直连 Supabase，不再调用 Flask 接口。");
}

// Final override for GitHub Pages readonly mode:
// always read directly from Supabase and never probe Flask endpoints.
function getApiCandidates() {
  return ["supabase-direct"];
}

async function resolveApiBase() {
  getSupabaseConfig();
  return "supabase-direct";
}

function buildApiUrl(path) {
  return path;
}

function startAutoRefresh() {
  if (startAutoRefresh.timer) {
    window.clearInterval(startAutoRefresh.timer);
  }

  startAutoRefresh.timer = window.setInterval(async () => {
    try {
      await initPage(true);
    } catch (error) {
      showStatus(`自动刷新失败：${error.message}`, "warning", true);
    }
  }, AUTO_REFRESH_MS);
}

async function initPage(keepSelection = false) {
  showStatus("正在从 Supabase 加载基金列表...", "info");

  try {
    const snapshot = await fetchSupabaseSnapshot();
    state.supabaseFundRows = snapshot.fundRows;
    state.supabaseBenchmarkRows = snapshot.benchmarkRows;
    state.fundList = buildFundListFromRows(snapshot.fundRows);
    state.publicShareMode = true;
    state.benchmarkOptions = DIRECT_SUPABASE_BENCHMARK_OPTIONS.slice();

    configureAdminActions();
    renderBenchmarkSelector(state.benchmarkOptions);
    renderFundSelector(state.fundList);

    if (!state.fundList.length) {
      resetPage();
      showStatus("Supabase 中还没有可展示的基金净值数据。", "warning", true);
      return;
    }

    let nextFund = state.currentFund;
    if (!keepSelection || !state.fundList.some((item) => item.short_name === nextFund)) {
      nextFund = state.fundList[0].short_name;
    }

    document.getElementById("fundSelector").value = nextFund;
    state.currentFund = nextFund;
    await loadFundData(nextFund);

    showStatus(`数据更新时间：${formatDateTimeValue()}`, "success");
  } catch (error) {
    resetPage();
    showStatus(`加载 Supabase 数据失败：${error.message}`, "error", true);
  }
}

async function loadFundData(shortName) {
  showStatus(`正在加载 ${shortName} 的净值数据...`, "info");

  try {
    const fundRows = (state.supabaseFundRows || []).filter((row) => row.fund_name_short === shortName);
    if (!fundRows.length) {
      throw new Error(`未找到基金 ${shortName} 的数据。`);
    }

    const fundPayload = buildFundPayloadFromRows(
      fundRows,
      state.supabaseBenchmarkRows || [],
      state.currentBenchmark,
    );

    if (!fundPayload) {
      throw new Error(`基金 ${shortName} 的可视化数据构建失败。`);
    }

    state.rangeData = fundPayload.range_data || null;
    state.benchmarkOptions = DIRECT_SUPABASE_BENCHMARK_OPTIONS.slice();

    renderBenchmarkSelector(state.benchmarkOptions);
    renderSummary(state.rangeData);
    renderTopIndicators(state.rangeData);
    renderRiskIndicators(state.rangeData);
    renderPerformanceTable(fundPayload.performance_data || []);
    renderIndicatorTable("returnBody", fundPayload.return_indicators || []);
    renderIndicatorTable("riskBody", fundPayload.risk_indicators || []);
    renderNetValueTable(fundPayload.net_value_list || []);
    initializeTimeline();

    showStatus(`已加载 ${shortName} 的 Supabase 数据。`, "success");
  } catch (error) {
    resetPage();
    showStatus(`加载基金数据失败：${error.message}`, "error", true);
  }
}

async function fetchJSON() {
  throw new Error("当前 GitHub Pages 版本已改为直连 Supabase，不再调用 Flask 接口。");
}

const DIRECT_SUPABASE_BENCHMARK_OPTIONS = [
  { code: "000300", symbol: "000300.SH", name: "沪深300" },
  { code: "000001", symbol: "000001.SH", name: "上证指数" },
  { code: "000852", symbol: "000852.CSI", name: "中证1000" },
];

const SUPABASE_DEFAULT_URL = "https://dkosimntffdhjkxukikk.supabase.co";
const SUPABASE_DEFAULT_PUBLISHABLE_KEY = "sb_publishable_qdVPMQlLDm95_3oGYb72Bw_VX6zzFM1";
const SUPABASE_PAGE_SIZE = 1000;

function getSupabaseConfig() {
  const url = (
    window.SUPABASE_URL
    || document.querySelector('meta[name="supabase-url"]')?.content
    || SUPABASE_DEFAULT_URL
    || ""
  ).trim().replace(/\/$/, "");
  const key = (
    window.SUPABASE_PUBLISHABLE_KEY
    || window.SUPABASE_API_KEY
    || document.querySelector('meta[name="supabase-publishable-key"]')?.content
    || SUPABASE_DEFAULT_PUBLISHABLE_KEY
    || ""
  ).trim();

  if (!url) {
    throw new Error("未配置 Supabase URL。");
  }

  if (!key) {
    throw new Error("未配置 Supabase publishable key。");
  }

  return { url, key };
}

function buildQueryString(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") {
      return;
    }
    search.set(key, String(value));
  });
  return search.toString();
}

function getErrorMessage(payload, fallback) {
  if (payload && typeof payload === "object") {
    return payload.message || payload.error_description || payload.details || payload.hint || fallback;
  }
  return fallback;
}

async function fetchSupabasePage(tableName, params = {}) {
  const { url, key } = getSupabaseConfig();
  const query = buildQueryString(params);
  const response = await fetch(`${url}/rest/v1/${tableName}?${query}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const text = await response.text();
  let payload = [];
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`Supabase 返回了非 JSON 内容：${text.trim().slice(0, 120)}`);
    }
  }

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, `Supabase 请求失败：${response.status}`));
  }

  return payload;
}

async function fetchSupabaseAll(tableName, params = {}) {
  const rows = [];
  for (let offset = 0; ; offset += SUPABASE_PAGE_SIZE) {
    const batch = await fetchSupabasePage(tableName, {
      ...params,
      limit: SUPABASE_PAGE_SIZE,
      offset,
    });

    if (!Array.isArray(batch) || !batch.length) {
      break;
    }

    rows.push(...batch);
    if (batch.length < SUPABASE_PAGE_SIZE) {
      break;
    }
  }

  return rows;
}

function formatDateOnlyValue(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    const match = value.match(/\d{4}-\d{2}-\d{2}/);
    if (match) {
      return match[0];
    }
  }

  const date = parseDateOnly(value);
  if (!date) {
    return null;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateTimeValue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function normalizeFundRows(rows) {
  const deduped = new Map();

  rows.forEach((row) => {
    const fundNameShort = (row?.fund_name_short || "").trim();
    const netDate = formatDateOnlyValue(row?.net_date);
    if (!fundNameShort || !netDate) {
      return;
    }

    const normalized = {
      fund_name: row?.fund_name || fundNameShort,
      fund_name_short: fundNameShort,
      net_date: netDate,
      unit_net: toFiniteNumber(row?.unit_net),
      accum_net: toFiniteNumber(row?.accum_net),
      net_change: toFiniteNumber(row?.net_change),
      update_time: row?.update_time || "",
    };

    const key = `${fundNameShort}__${netDate}`;
    const existing = deduped.get(key);
    if (!existing || String(normalized.update_time) >= String(existing.update_time)) {
      deduped.set(key, normalized);
    }
  });

  const normalizedRows = [...deduped.values()].sort((a, b) => {
    if (a.fund_name_short !== b.fund_name_short) {
      return a.fund_name_short.localeCompare(b.fund_name_short, "zh-CN");
    }
    if (a.net_date !== b.net_date) {
      return a.net_date.localeCompare(b.net_date);
    }
    return String(a.update_time || "").localeCompare(String(b.update_time || ""));
  });

  const previousByFund = new Map();
  normalizedRows.forEach((row) => {
    const previousUnitNet = previousByFund.get(row.fund_name_short);
    if ((row.net_change == null || Number.isNaN(row.net_change)) && previousUnitNet != null && previousUnitNet !== 0 && row.unit_net != null) {
      row.net_change = ((row.unit_net / previousUnitNet) - 1) * 100;
    }
    if (row.unit_net != null) {
      previousByFund.set(row.fund_name_short, row.unit_net);
    }
  });

  return normalizedRows;
}

function normalizeBenchmarkRows(rows) {
  const deduped = new Map();

  rows.forEach((row) => {
    const indexCode = (row?.index_code || "").trim();
    const tradeDate = formatDateOnlyValue(row?.trade_date);
    if (!indexCode || !tradeDate) {
      return;
    }

    deduped.set(`${indexCode}__${tradeDate}`, {
      index_code: indexCode,
      trade_date: tradeDate,
      close_price: toFiniteNumber(row?.close_price),
      cumulative_return: toFiniteNumber(row?.cumulative_return),
      source: row?.source || "",
    });
  });

  return [...deduped.values()].sort((a, b) => {
    if (a.index_code !== b.index_code) {
      return a.index_code.localeCompare(b.index_code);
    }
    return a.trade_date.localeCompare(b.trade_date);
  });
}

function buildFundListFromRows(fundRows) {
  const latestByFund = new Map();
  fundRows.forEach((row) => {
    latestByFund.set(row.fund_name_short, row);
  });

  return [...latestByFund.values()]
    .sort((a, b) => a.fund_name_short.localeCompare(b.fund_name_short, "zh-CN"))
    .map((row) => ({
      short_name: row.fund_name_short,
      full_name: row.fund_name,
      latest_date: row.net_date,
      latest_unit_net: row.unit_net,
      latest_accum_net: row.accum_net,
    }));
}

function buildBenchmarkSummariesFromRows(benchmarkRows) {
  const summaries = {};
  DIRECT_SUPABASE_BENCHMARK_OPTIONS.forEach((item) => {
    const rows = benchmarkRows.filter((row) => row.index_code === item.code);
    summaries[item.code] = {
      index_code: item.code,
      row_count: rows.length,
      min_date: rows.length ? rows[0].trade_date : null,
      max_date: rows.length ? rows[rows.length - 1].trade_date : null,
    };
  });
  return summaries;
}

function buildSitePayloadFromRows(fundRows, benchmarkRows) {
  return {
    status: "ok",
    generated_at: formatDateTimeValue(),
    database: "Supabase",
    database_backend: "supabase",
    fund_count: new Set(fundRows.map((row) => row.fund_name_short)).size,
    record_count: fundRows.length,
    latest_net_date: fundRows.length ? fundRows[fundRows.length - 1].net_date : null,
    benchmarks: DIRECT_SUPABASE_BENCHMARK_OPTIONS.slice(),
    benchmark_summaries: buildBenchmarkSummariesFromRows(benchmarkRows),
    public_share_mode: true,
  };
}

function groupBenchmarkRowsByCode(benchmarkRows) {
  const grouped = {};
  DIRECT_SUPABASE_BENCHMARK_OPTIONS.forEach((item) => {
    grouped[item.code] = [];
  });

  benchmarkRows.forEach((row) => {
    if (!grouped[row.index_code]) {
      grouped[row.index_code] = [];
    }
    grouped[row.index_code].push(row);
  });

  return grouped;
}

function deriveCumulativeReturnSeries(closePrice, currentSeries = []) {
  const derived = [];
  const basePrice = closePrice.find((value) => value != null && value !== 0);

  closePrice.forEach((value, index) => {
    const existing = toFiniteNumber(currentSeries[index]);
    if (existing != null) {
      derived.push(existing);
      return;
    }

    if (basePrice == null || value == null) {
      derived.push(null);
      return;
    }

    derived.push(((value / basePrice) - 1) * 100);
  });

  return derived;
}

function alignBenchmarkSeriesToFundDates(fundDates, benchmarkRows) {
  const closePrice = [];
  const cumulativeReturn = [];
  const rows = Array.isArray(benchmarkRows) ? benchmarkRows.slice() : [];

  let pointer = 0;
  let lastRow = null;

  fundDates.forEach((fundDate) => {
    while (pointer < rows.length && rows[pointer].trade_date <= fundDate) {
      lastRow = rows[pointer];
      pointer += 1;
    }

    closePrice.push(lastRow ? toFiniteNumber(lastRow.close_price) : null);
    cumulativeReturn.push(lastRow ? toFiniteNumber(lastRow.cumulative_return) : null);
  });

  return {
    close_price: closePrice,
    cumulative_return_series: deriveCumulativeReturnSeries(closePrice, cumulativeReturn),
  };
}

function buildRangeDataFromRows(fundRows, benchmarkRows, benchmarkCode = state.currentBenchmark) {
  const orderedFundRows = fundRows
    .slice()
    .sort((a, b) => a.net_date.localeCompare(b.net_date));

  if (!orderedFundRows.length) {
    return null;
  }

  const dates = orderedFundRows.map((row) => row.net_date);
  const unitNet = orderedFundRows.map((row) => row.unit_net);
  const accumNet = orderedFundRows.map((row) => row.accum_net);
  const fundDrawdown = computeDrawdownSeries(unitNet);
  const groupedBenchmarkRows = groupBenchmarkRowsByCode(benchmarkRows);
  const benchmarks = {};

  DIRECT_SUPABASE_BENCHMARK_OPTIONS.forEach((option) => {
    const aligned = alignBenchmarkSeriesToFundDates(dates, groupedBenchmarkRows[option.code] || []);
    const regression = calculateAlphaBeta(unitNet, aligned.close_price);

    benchmarks[option.code] = {
      code: option.code,
      symbol: option.symbol,
      name: option.name,
      close_price: aligned.close_price,
      cumulative_return_series: aligned.cumulative_return_series,
      drawdown: computeDrawdownSeries(aligned.close_price),
      period_return: calculateSeriesPeriodReturn(aligned.close_price),
      alpha: regression.alpha,
      beta: regression.beta,
    };
  });

  const selectedCode = DIRECT_SUPABASE_BENCHMARK_OPTIONS.some((item) => item.code === benchmarkCode)
    ? benchmarkCode
    : DIRECT_SUPABASE_BENCHMARK_OPTIONS[0].code;
  const selectedBenchmark = benchmarks[selectedCode];
  const latestRow = orderedFundRows[orderedFundRows.length - 1];
  const fundReturns = computeDailyReturnSeries(unitNet);
  const drawdownProfile = calculateDrawdownProfile(unitNet, dates);
  const selectedRegression = calculateAlphaBeta(unitNet, selectedBenchmark?.close_price || []);

  return {
    fund_name: latestRow.fund_name,
    fund_name_short: latestRow.fund_name_short,
    latest_date: latestRow.net_date,
    latest_unit_net: latestRow.unit_net,
    latest_accum_net: latestRow.accum_net,
    cumulative_return: calculateSeriesPeriodReturn(unitNet),
    annualized_return: calculateAnnualizedReturn(unitNet, dates),
    benchmark_options: DIRECT_SUPABASE_BENCHMARK_OPTIONS.slice(),
    selected_benchmark_code: selectedCode,
    selected_benchmark_name: selectedBenchmark?.name || "沪深300",
    benchmarks,
    benchmark_cumulative_return: selectedBenchmark?.period_return ?? null,
    alpha: selectedRegression.alpha,
    beta: selectedRegression.beta,
    sharpe_ratio: calculateSharpeRatio(fundReturns),
    win_rate: calculateWinRate(fundReturns),
    profit_loss_ratio: calculateProfitLossRatio(fundReturns),
    return_volatility: calculateReturnVolatility(fundReturns),
    max_drawdown: drawdownProfile.maxDrawdown,
    annual_volatility: calculateAnnualVolatility(fundReturns),
    downside_risk: calculateDownsideRisk(fundReturns),
    max_drawdown_recovery_days: drawdownProfile.recoveryDays,
    max_single_drop: calculateMaxSingleDrop(fundReturns),
    max_consecutive_loss_days: calculateMaxConsecutiveLossDays(fundReturns),
    loss_period_ratio: calculateLossPeriodRatio(fundReturns),
    max_drawdown_start_date: drawdownProfile.startDate,
    max_drawdown_end_date: drawdownProfile.endDate,
    dates,
    unit_net: unitNet,
    accum_net: accumNet,
    benchmark_close_price: selectedBenchmark?.close_price || [],
    fund_drawdown: fundDrawdown,
    benchmark_drawdown: selectedBenchmark?.drawdown || [],
  };
}

function getWindowStartIndex(dates, days) {
  if (!Array.isArray(dates) || !dates.length || !days) {
    return 0;
  }

  const endDate = parseDateOnly(dates[dates.length - 1]);
  if (!endDate) {
    return 0;
  }

  const startDate = new Date(endDate.getTime());
  startDate.setDate(startDate.getDate() - days);

  const index = dates.findIndex((value) => {
    const date = parseDateOnly(value);
    return date && date >= startDate;
  });

  return index === -1 ? 0 : index;
}

function sliceMetricWindow(data, days, benchmarkCode = state.currentBenchmark) {
  const dates = Array.isArray(data?.dates) ? data.dates : [];
  const start = getWindowStartIndex(dates, days);
  const selectedCode = benchmarkCode || data?.selected_benchmark_code || DIRECT_SUPABASE_BENCHMARK_OPTIONS[0].code;
  const benchmark = data?.benchmarks?.[selectedCode] || null;

  return {
    dates: dates.slice(start),
    unitNet: Array.isArray(data?.unit_net) ? data.unit_net.slice(start) : [],
    benchmarkClose: Array.isArray(benchmark?.close_price) ? benchmark.close_price.slice(start) : [],
    benchmarkName: benchmark?.name || getBenchmarkByCode(selectedCode, data)?.name || "主基准",
  };
}

function buildPerformanceRowsFromRangeData(data) {
  const periods = [
    ["近1周", 7],
    ["近1月", 30],
    ["近3月", 90],
    ["近半年", 180],
    ["近1年", 365],
    ["成立以来", null],
  ];

  return periods.map(([label, days]) => {
    const windowData = sliceMetricWindow(data, days, state.currentBenchmark);
    return {
      period: label,
      days: days ?? 36500,
      return: calculateSeriesPeriodReturn(windowData.unitNet),
    };
  });
}

function buildReturnIndicatorRowsFromRangeData(data, benchmarkCode = state.currentBenchmark) {
  const selectedCode = benchmarkCode || data?.selected_benchmark_code || DIRECT_SUPABASE_BENCHMARK_OPTIONS[0].code;
  const benchmarkName = data?.benchmarks?.[selectedCode]?.name || getBenchmarkByCode(selectedCode, data)?.name || "主基准";
  const periods = {
    week: 7,
    month: 30,
    quarter: 90,
    half_year: 180,
  };

  function buildRow(indicator, formatter, calculator) {
    const row = { indicator };
    Object.entries(periods).forEach(([key, days]) => {
      const windowData = sliceMetricWindow(data, days, selectedCode);
      row[key] = formatter(calculator(windowData));
    });
    return row;
  }

  return [
    buildRow("累计收益率", formatPercent, (windowData) => calculateSeriesPeriodReturn(windowData.unitNet)),
    buildRow("年化收益率", formatPercent, (windowData) => calculateAnnualizedReturn(windowData.unitNet, windowData.dates)),
    buildRow(`${benchmarkName}累计收益`, formatPercent, (windowData) => calculateSeriesPeriodReturn(windowData.benchmarkClose)),
    buildRow(`Alpha（${benchmarkName}）`, (value) => formatValue(value, 4), (windowData) => calculateAlphaBeta(windowData.unitNet, windowData.benchmarkClose).alpha),
    buildRow("夏普比率", (value) => formatValue(value, 4), (windowData) => calculateSharpeRatio(computeDailyReturnSeries(windowData.unitNet))),
  ];
}

function buildRiskIndicatorRowsFromRangeData(data, benchmarkCode = state.currentBenchmark) {
  const selectedCode = benchmarkCode || data?.selected_benchmark_code || DIRECT_SUPABASE_BENCHMARK_OPTIONS[0].code;
  const benchmarkName = data?.benchmarks?.[selectedCode]?.name || getBenchmarkByCode(selectedCode, data)?.name || "主基准";
  const periods = {
    week: 7,
    month: 30,
    quarter: 90,
    half_year: 180,
  };

  function buildRow(indicator, formatter, calculator) {
    const row = { indicator };
    Object.entries(periods).forEach(([key, days]) => {
      const windowData = sliceMetricWindow(data, days, selectedCode);
      row[key] = formatter(calculator(windowData));
    });
    return row;
  }

  return [
    buildRow("年化波动率", formatPercent, (windowData) => calculateAnnualVolatility(computeDailyReturnSeries(windowData.unitNet))),
    buildRow("下行风险", formatPercent, (windowData) => calculateDownsideRisk(computeDailyReturnSeries(windowData.unitNet))),
    buildRow("最大回撤", formatPercent, (windowData) => calculateDrawdownProfile(windowData.unitNet, windowData.dates).maxDrawdown),
    buildRow(`Beta（${benchmarkName}）`, (value) => formatValue(value, 4), (windowData) => calculateAlphaBeta(windowData.unitNet, windowData.benchmarkClose).beta),
    buildRow("胜率", formatPercent, (windowData) => calculateWinRate(computeDailyReturnSeries(windowData.unitNet))),
  ];
}

function buildNetValueListFromRows(fundRows) {
  return fundRows
    .slice()
    .sort((a, b) => b.net_date.localeCompare(a.net_date))
    .map((row) => ({
      net_date: row.net_date,
      unit_net: row.unit_net,
      accum_net: row.accum_net,
      net_change: row.net_change,
    }));
}

function buildFundPayloadFromRows(fundRows, benchmarkRows, benchmarkCode = state.currentBenchmark) {
  const rangeData = buildRangeDataFromRows(fundRows, benchmarkRows, benchmarkCode);
  if (!rangeData) {
    return null;
  }

  return {
    range_data: rangeData,
    performance_data: buildPerformanceRowsFromRangeData(rangeData),
    return_indicators: buildReturnIndicatorRowsFromRangeData(rangeData, benchmarkCode),
    risk_indicators: buildRiskIndicatorRowsFromRangeData(rangeData, benchmarkCode),
    net_value_list: buildNetValueListFromRows(fundRows),
  };
}

async function fetchSupabaseSnapshot() {
  const [fundRows, benchmarkRows] = await Promise.all([
    fetchSupabaseAll("fund_net_value", {
      select: "fund_name,fund_name_short,net_date,unit_net,accum_net,net_change,update_time",
      order: "fund_name_short.asc,net_date.asc,update_time.asc",
    }),
    fetchSupabaseAll("benchmark_price", {
      select: "index_code,trade_date,close_price,cumulative_return,source",
      order: "index_code.asc,trade_date.asc",
    }),
  ]);

  return {
    fundRows: normalizeFundRows(fundRows),
    benchmarkRows: normalizeBenchmarkRows(benchmarkRows),
  };
}

async function resolveApiBase() {
  getSupabaseConfig();
  return "supabase-direct";
}

function buildApiUrl(path) {
  return path;
}

function startAutoRefresh() {
  if (startAutoRefresh.timer) {
    window.clearInterval(startAutoRefresh.timer);
  }

  startAutoRefresh.timer = window.setInterval(async () => {
    try {
      await initPage(true);
    } catch (error) {
      showStatus(`自动刷新失败：${error.message}`, "warning", true);
    }
  }, AUTO_REFRESH_MS);
}

async function initPage(keepSelection = false) {
  showStatus("正在从 Supabase 加载基金列表...", "info");

  try {
    const snapshot = await fetchSupabaseSnapshot();
    state.supabaseFundRows = snapshot.fundRows;
    state.supabaseBenchmarkRows = snapshot.benchmarkRows;
    state.fundList = buildFundListFromRows(snapshot.fundRows);
    state.publicShareMode = true;
    state.benchmarkOptions = DIRECT_SUPABASE_BENCHMARK_OPTIONS.slice();

    configureAdminActions();
    renderBenchmarkSelector(state.benchmarkOptions);
    renderFundSelector(state.fundList);

    if (!state.fundList.length) {
      resetPage();
      showStatus("Supabase 中还没有可展示的基金净值数据。", "warning", true);
      return;
    }

    let nextFund = state.currentFund;
    if (!keepSelection || !state.fundList.some((item) => item.short_name === nextFund)) {
      nextFund = state.fundList[0].short_name;
    }

    document.getElementById("fundSelector").value = nextFund;
    state.currentFund = nextFund;
    await loadFundData(nextFund);

    showStatus(`数据更新时间：${formatDateTimeValue()}`, "success");
  } catch (error) {
    resetPage();
    showStatus(`加载 Supabase 数据失败：${error.message}`, "error", true);
  }
}

async function loadFundData(shortName) {
  showStatus(`正在加载 ${shortName} 的净值数据...`, "info");

  try {
    const fundRows = (state.supabaseFundRows || []).filter((row) => row.fund_name_short === shortName);
    if (!fundRows.length) {
      throw new Error(`未找到基金 ${shortName} 的数据。`);
    }

    const fundPayload = buildFundPayloadFromRows(
      fundRows,
      state.supabaseBenchmarkRows || [],
      state.currentBenchmark,
    );

    if (!fundPayload) {
      throw new Error(`基金 ${shortName} 的可视化数据构建失败。`);
    }

    state.rangeData = fundPayload.range_data || null;
    state.benchmarkOptions = DIRECT_SUPABASE_BENCHMARK_OPTIONS.slice();

    renderBenchmarkSelector(state.benchmarkOptions);
    renderSummary(state.rangeData);
    renderTopIndicators(state.rangeData);
    renderRiskIndicators(state.rangeData);
    renderPerformanceTable(fundPayload.performance_data || []);
    renderIndicatorTable("returnBody", fundPayload.return_indicators || []);
    renderIndicatorTable("riskBody", fundPayload.risk_indicators || []);
    renderNetValueTable(fundPayload.net_value_list || []);
    initializeTimeline();

    showStatus(`已加载 ${shortName} 的 Supabase 数据。`, "success");
  } catch (error) {
    resetPage();
    showStatus(`加载基金数据失败：${error.message}`, "error", true);
  }
}

async function crawlRecentData() {
  showStatus("GitHub 公开页为只读展示，请在本地管理版执行抓取邮件。", "warning", true);
}

async function crawlBenchmarkData() {
  showStatus("GitHub 公开页为只读展示，请在本地管理版执行基准同步。", "warning", true);
}

function setText(id, value) {
  document.getElementById(id).textContent = value;
}

function formatValue(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) {
    return "--";
  }

  return Number(value).toFixed(digits);
}

function formatPercent(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) {
    return "--";
  }

  return `${Number(value).toFixed(digits)}%`;
}

function showStatus(message, type = "info", keep = false) {
  const statusBar = document.getElementById("statusBar");
  statusBar.textContent = message;
  statusBar.className = `status-bar ${type} visible`;

  if (!keep && (type === "success" || type === "info")) {
    window.clearTimeout(showStatus.timer);
    showStatus.timer = window.setTimeout(() => {
      statusBar.className = "status-bar";
      statusBar.textContent = "";
    }, 3500);
  }
}

function getApiCandidates() {
  const candidates = [];
  const configuredBase = (
    window.PUBLIC_API_BASE
    || document.querySelector('meta[name="public-api-base"]')?.content
    || ""
  ).trim().replace(/\/$/, "");

  if (configuredBase && !configuredBase.includes("your-public-api-domain.com")) {
    candidates.push(configuredBase);
  }

  if (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") {
    candidates.push(window.location.origin);
  }

  return [...new Set(candidates)];
}

async function resolveApiBase() {
  for (const candidate of getApiCandidates()) {
    try {
      const response = await fetch(`${candidate}/api/public-dashboard`, { cache: "no-store" });
      if (!response.ok) {
        continue;
      }

      const payload = await response.json();
      if (payload?.status === "success") {
        return candidate;
      }
    } catch (error) {
      continue;
    }
  }

  throw new Error("未找到可用后端接口，请先部署 Flask 轻量接口，并在 HTML 的 public-api-base 中填写接口地址。");
}

function buildApiUrl(path) {
  if (!state.apiBase) {
    throw new Error("后端接口尚未连接，请先配置 public-api-base。");
  }

  return `${state.apiBase}${path}`;
}

function startAutoRefresh() {
  if (startAutoRefresh.timer) {
    window.clearInterval(startAutoRefresh.timer);
  }

  startAutoRefresh.timer = window.setInterval(async () => {
    try {
      await initPage(true);
    } catch (error) {
      showStatus(`自动刷新失败：${error.message}`, "warning", true);
    }
  }, AUTO_REFRESH_MS);
}

async function initPage(keepSelection = false) {
  showStatus("正在加载基金列表...", "info");

  try {
    const dashboardResult = await fetchJSON(buildApiUrl("/api/public-dashboard"));
    const siteData = dashboardResult?.data?.site || {};
    const fundList = dashboardResult?.data?.fund_list || [];

    state.fundList = Array.isArray(fundList) ? fundList : [];
    state.publicShareMode = Boolean(siteData?.public_share_mode ?? true);
    state.benchmarkOptions = Array.isArray(siteData?.benchmarks) && siteData.benchmarks.length
      ? siteData.benchmarks
      : DEFAULT_BENCHMARK_OPTIONS.slice();

    configureAdminActions();
    renderBenchmarkSelector(state.benchmarkOptions);
    renderFundSelector(state.fundList);

    if (!state.fundList.length) {
      resetPage();
      showStatus("当前数据库中还没有基金净值数据。", "warning");
      return;
    }

    let nextFund = state.currentFund;
    if (!keepSelection || !state.fundList.some((item) => item.short_name === nextFund)) {
      nextFund = state.fundList[0].short_name;
    }

    document.getElementById("fundSelector").value = nextFund;
    state.currentFund = nextFund;
    await loadFundData(nextFund);

    const generatedAt = siteData?.generated_at
      ? `数据更新时间：${siteData.generated_at}`
      : `已加载 ${state.fundList.length} 只基金。`;
    showStatus(generatedAt, "success");
  } catch (error) {
    resetPage();
    showStatus(`加载基金列表失败：${error.message}`, "error", true);
  }
}

async function loadFundData(shortName) {
  showStatus(`正在加载 ${shortName} 的净值数据...`, "info");

  try {
    const benchmarkQuery = `&benchmark_code=${encodeURIComponent(state.currentBenchmark)}`;
    const result = await fetchJSON(
      buildApiUrl(`/api/public-dashboard?fund=${encodeURIComponent(shortName)}${benchmarkQuery}`)
    );

    const siteData = result?.data?.site || {};
    const fundPayload = result?.data?.fund_payload || {};

    state.publicShareMode = Boolean(siteData?.public_share_mode ?? true);
    state.rangeData = fundPayload.range_data || null;
    state.benchmarkOptions = Array.isArray(siteData?.benchmarks) && siteData.benchmarks.length
      ? siteData.benchmarks
      : getBenchmarkOptions(state.rangeData);

    renderBenchmarkSelector(state.benchmarkOptions);
    renderSummary(state.rangeData);
    renderTopIndicators(state.rangeData);
    renderRiskIndicators(state.rangeData);
    renderPerformanceTable(fundPayload.performance_data || []);
    renderIndicatorTable("returnBody", fundPayload.return_indicators || []);
    renderIndicatorTable("riskBody", fundPayload.risk_indicators || []);
    renderNetValueTable(fundPayload.net_value_list || []);
    initializeTimeline();

    const generatedAt = siteData?.generated_at ? `数据更新时间：${siteData.generated_at}` : "数据已刷新";
    showStatus(`已加载 ${shortName} 的可视化数据。${generatedAt}`, "success");
  } catch (error) {
    resetPage();
    showStatus(`加载基金数据失败：${error.message}`, "error", true);
  }
}

async function fetchJSON(url) {
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    const preview = text.trim().slice(0, 120).replace(/\s+/g, " ");
    throw new Error(`接口返回了非 JSON 内容。返回片段：${preview}`);
  }

  if (!response.ok || payload.status === "error") {
    throw new Error(payload.message || `请求失败：${response.status}`);
  }

  return payload;
}
