import { ethers } from "../vendor/ethers-6.13.4.min.js";
import { CONFIG } from "./config.js";
import { MINING_ABI, STAKING_ABI } from "./abi.js";
import { t, setLang, getLang, applyI18n } from "./i18n.js";

const $ = (id) => document.getElementById(id);
const CONSENT_KEY = "mst-mining-consent-v1";
const HASHRATE_WINDOW_MS = 5000;
const FALLBACK_TARGET = ethers.MaxUint256 >> 24n; // 컨트랙트가 없을 때 측정용 목표값
const WithheldReason = ["whyPool", "whyDaily", "whyEpoch"];

const hasContract = ethers.isAddress(CONFIG.contractAddress);
const readProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });
const reader = hasContract ? new ethers.Contract(CONFIG.contractAddress, MINING_ABI, readProvider) : null;

let stakingReader = null; // 채굴 컨트랙트의 staking() 주소로 만든 읽기 전용 인스턴스
const S = {
  provider: null, // ethers.BrowserProvider
  account: null,
  chainId: null,
  chain: null, // 마지막으로 읽은 컨트랙트 상태
  me: null, // 연결된 지갑 기준 상태
  roles: { admin: false, registrar: false, params: false },
  mining: {
    running: false,
    held: false, // 탭이 가려져 잠시 멈춘 상태
    workers: [],
    job: null, // { challenge, miner, target }
    sessionHashes: 0,
    samples: [], // [{ at, hashes }]
    found: 0,
    submitted: 0,
    accepted: 0,
    pending: null, // 제출 대기 중인 share
    submitting: false,
    lastSubmitAt: 0,
    lastFoundLogAt: 0,
  },
};

// ───────────────────────── 포맷 ─────────────────────────

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const fmtInt = (n) => Number(n).toLocaleString(getLang() === "ko" ? "ko-KR" : "en-US");
function fmtHps(hps) {
  const units = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s"];
  let i = 0;
  while (hps >= 1000 && i < units.length - 1) { hps /= 1000; i++; }
  return `${hps.toFixed(i ? 2 : 0)} ${units[i]}`;
}
function fmtBig(n) {
  // 매우 큰 수(난이도 등)를 읽기 쉽게
  const s = n.toString();
  if (s.length <= 12) return fmtInt(s);
  return `${s[0]}.${s.slice(1, 3)}e${s.length - 1}`;
}
function fmtMst(wei) {
  const v = Number(ethers.formatEther(wei));
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${CONFIG.symbol}`;
}
function fmtDuration(sec) {
  if (!isFinite(sec)) return "–";
  if (sec < 60) return `${Math.ceil(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
  return `${(sec / 86400).toFixed(1)}d`;
}
const explorerTx = (h) => (CONFIG.explorerUrl ? `${CONFIG.explorerUrl.replace(/\/$/, "")}/tx/${h}` : null);

function errMsg(e) {
  if (e?.code === "ACTION_REJECTED") return getLang() === "ko" ? "사용자가 거절함" : "rejected by user";
  if (e?.revert?.name) return e.revert.name;
  const data = e?.data ?? e?.info?.error?.data;
  if (reader && typeof data === "string" && data.length >= 10) {
    try { return reader.interface.parseError(data)?.name ?? data; } catch {}
  }
  return e?.shortMessage || e?.message || String(e);
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 4000);
}

function log(msg, cls = "") {
  const li = document.createElement("li");
  const time = document.createElement("time");
  time.textContent = new Date().toLocaleTimeString();
  const span = document.createElement("span");
  span.textContent = msg;
  if (cls) span.className = cls;
  li.append(time, span);
  const ol = $("activityLog");
  ol.prepend(li);
  while (ol.children.length > 100) ol.lastChild.remove();
}

// ───────────────────────── 저장값 ─────────────────────────

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const cumKey = () => `mst-mining-cum:${S.account ?? "anon"}`;
let cumUnsaved = 0;
function flushCumulative() {
  if (!cumUnsaved) return;
  store.set(cumKey(), String(Number(store.get(cumKey()) || 0) + cumUnsaved));
  cumUnsaved = 0;
}
const cumulative = () => Number(store.get(cumKey()) || 0) + cumUnsaved;

// ───────────────────────── 지갑 ─────────────────────────

const chainOk = () => S.chainId === CONFIG.chainId;
const writer = async () => new ethers.Contract(CONFIG.contractAddress, MINING_ABI, await S.provider.getSigner());

async function connect(interactive = true) {
  if (!window.ethereum) {
    if (interactive) toast(t("noWallet"));
    return;
  }
  const accounts = await window.ethereum.request({ method: interactive ? "eth_requestAccounts" : "eth_accounts" });
  if (!accounts.length) return;
  S.provider = new ethers.BrowserProvider(window.ethereum, "any");
  S.account = ethers.getAddress(accounts[0]);
  S.chainId = Number(await window.ethereum.request({ method: "eth_chainId" }));
  if (!connect.bound) {
    connect.bound = true;
    window.ethereum.on?.("accountsChanged", (a) => onWalletChange(a[0] ? ethers.getAddress(a[0]) : null, S.chainId));
    window.ethereum.on?.("chainChanged", (c) => onWalletChange(S.account, Number(c)));
  }
  await onWalletChange(S.account, S.chainId);
}

async function onWalletChange(account, chainId) {
  const changedAccount = account !== S.account;
  if (changedAccount && S.mining.running) stopMining(); // 다른 지갑의 nonce로 계속 채굴하지 않는다
  flushCumulative();
  S.account = account;
  S.chainId = chainId;
  if (window.ethereum && account) S.provider = new ethers.BrowserProvider(window.ethereum, "any");
  await refreshChain();
  if (changedAccount) $("histBody").replaceChildren();
}

async function switchNetwork() {
  const hex = "0x" + CONFIG.chainId.toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if (e.code !== 4902 && e?.data?.originalError?.code !== 4902) return toast(t("txFail", errMsg(e)));
    const params = {
      chainId: hex,
      chainName: CONFIG.chainName,
      nativeCurrency: { name: CONFIG.symbol, symbol: CONFIG.symbol, decimals: CONFIG.decimals },
      rpcUrls: [CONFIG.rpcUrl],
    };
    if (CONFIG.explorerUrl) params.blockExplorerUrls = [CONFIG.explorerUrl];
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [params] });
  }
}

// ───────────────────────── 체인 상태 ─────────────────────────

async function refreshChain() {
  if (!reader) return render();
  try {
    const [challenge, target, difficulty, epoch, epochShares, params, pool, devices, netShares, paused, stakingEnabled, day] =
      await Promise.all([
        reader.challenge(), reader.miningTarget(), reader.difficulty(), reader.epoch(), reader.epochShares(),
        reader.params(), reader.poolBalance(), reader.registeredCount(), reader.totalAcceptedShares(),
        reader.paused(), reader.stakingEnabled(), reader.currentDay(),
      ]);
    await refreshStaking();
    const prevChallenge = S.chain?.challenge;
    S.chain = { challenge, target, difficulty, epoch, epochShares, params, pool, devices, netShares, paused, stakingEnabled, day };

    if (S.account) {
      const a = S.account;
      const [registered, shares, toWallet, toStaking, today, preview, nextAt, mode, roleAdmin, roleReg, roleParams] =
        await Promise.all([
          reader.isRegistered(a), reader.acceptedShares(a), reader.rewardedToWallet(a), reader.rewardedToStaking(a),
          reader.paidOnDay(a, day), reader.previewReward(a), reader.nextShareAllowedAt(a), reader.rewardMode(a),
          reader.hasRole(ethers.ZeroHash, a), reader.hasRole(ethers.id("REGISTRAR_ROLE"), a), reader.hasRole(ethers.id("PARAMS_ROLE"), a),
        ]);
      S.me = { registered, shares, toWallet, toStaking, today, preview, nextAt: Number(nextAt), mode: Number(mode) };
      const radio = document.querySelector(`input[name=rmode][value="${S.me.mode}"]`);
      if (radio && !document.querySelector("#rewardModeCard:focus-within")) radio.checked = true;
      S.roles = { admin: roleAdmin, registrar: roleReg, params: roleParams };
    } else {
      S.me = null;
      S.roles = { admin: false, registrar: false, params: false };
    }

    if (S.mining.running && prevChallenge && prevChallenge !== challenge) {
      log(t("logNewChallenge", epoch.toString()));
      S.mining.pending = null;
    }
    if (S.mining.running) syncJob();
    $("statsUpdated").textContent = new Date().toLocaleTimeString();
  } catch (e) {
    console.warn("refreshChain", e);
  }
  render();
}

const canSubmit = () => !!(reader && S.account && chainOk() && S.me?.registered && S.chain && !S.chain.paused);

// ───────────────────────── 채굴 ─────────────────────────

function currentJob() {
  if (canSubmit()) {
    return { challenge: S.chain.challenge, miner: S.account, target: S.chain.target, submit: true };
  }
  // 측정 전용: 무작위 challenge로 같은 계산을 하되 제출하지 않는다.
  const keep = S.mining.job && !S.mining.job.submit ? S.mining.job.challenge : ethers.hexlify(ethers.randomBytes(32));
  return { challenge: keep, miner: S.account ?? ethers.ZeroAddress, target: S.chain?.target ?? FALLBACK_TARGET, submit: false };
}

function syncJob() {
  const next = currentJob();
  const cur = S.mining.job;
  if (cur && cur.challenge === next.challenge && cur.miner === next.miner && cur.target === next.target) return;
  S.mining.job = next;
  postJob();
}

function postJob() {
  const j = S.mining.job;
  for (const w of S.mining.workers) {
    w.postMessage({ type: "job", challenge: j.challenge, miner: j.miner, target: "0x" + j.target.toString(16) });
  }
}

function spawnWorkers() {
  const n = Number($("threadsSel").value);
  const cpuCap = Number($("cpuSel").value);
  S.mining.workers = Array.from({ length: n }, () => {
    const w = new Worker(new URL("./miner-worker.js", import.meta.url), { type: "module" });
    w.onmessage = onWorkerMessage;
    w.onerror = (e) => log(`worker: ${e.message}`, "err");
    w.postMessage({ type: "cpu", cpuCap });
    return w;
  });
  postJob();
}

function killWorkers() {
  for (const w of S.mining.workers) w.terminate();
  S.mining.workers = [];
  S.mining.samples = [];
}

function onWorkerMessage(e) {
  const m = e.data;
  const M = S.mining;
  if (!M.running) return;
  if (m.type === "progress") {
    M.sessionHashes += m.hashes;
    cumUnsaved += m.hashes;
    M.samples.push({ at: performance.now(), hashes: m.hashes });
  } else if (m.type === "found") {
    if (m.challenge !== M.job?.challenge) return;
    M.found++;
    const now = Date.now();
    if (now - M.lastFoundLogAt > 2000) {
      log(t("logFound", short(m.nonce)));
      M.lastFoundLogAt = now;
    }
    if (M.job.submit) {
      M.pending = { nonce: m.nonce, challenge: m.challenge };
      trySubmit();
    }
  }
}

function hashrate() {
  const now = performance.now();
  const M = S.mining;
  M.samples = M.samples.filter((s) => now - s.at <= HASHRATE_WINDOW_MS);
  if (!M.samples.length || !M.workers.length) return 0;
  const sum = M.samples.reduce((a, s) => a + s.hashes, 0);
  const span = Math.min(HASHRATE_WINDOW_MS, now - (M.startedAt ?? now));
  return span > 0 ? (sum / span) * 1000 : 0;
}

function nextSubmitAt() {
  const gapSec = Math.max(CONFIG.minSubmitIntervalSec, Number(S.chain?.params?.minShareInterval ?? 0));
  return Math.max(S.mining.lastSubmitAt + gapSec * 1000, (S.me?.nextAt ?? 0) * 1000);
}

async function trySubmit() {
  const M = S.mining;
  const share = M.pending;
  if (!share || M.submitting || !canSubmit()) return;
  if (share.challenge !== S.chain.challenge) { M.pending = null; return; }
  if (Date.now() < nextSubmitAt()) return; // 1초 타이머가 다시 부른다

  M.submitting = true;
  try {
    const [amount, , reason] = await reader.previewReward(S.account);
    if (amount === 0n && $("skipNoReward").checked) {
      log(t("logSkippedNoReward", t(WithheldReason[Number(reason)])));
      M.lastSubmitAt = Date.now();
      return;
    }
    const c = await writer();
    // estimateGas는 실패 시 되돌림 사유를 알려 주므로 사전 검증(staticCall) 역할도 한다.
    const gas = await c.submitShare.estimateGas(share.nonce, share.challenge);
    const fee = await S.provider.getFeeData();
    const gasCost = gas * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
    if (amount > 0n && gasCost >= amount) {
      log(t("logSkippedGas"));
      M.lastSubmitAt = Date.now();
      return;
    }
    log(t("logSubmitting"));
    M.submitted++;
    M.lastSubmitAt = Date.now();
    const tx = await c.submitShare(share.nonce, share.challenge, { gasLimit: (gas * 12n) / 10n });
    log(t("logTxSent", short(tx.hash)));
    const rc = await tx.wait();
    for (const l of rc.logs) {
      let ev;
      try { ev = reader.interface.parseLog(l); } catch { continue; }
      if (ev?.name === "ShareAccepted") {
        M.accepted++;
        log(t("logAccepted", ethers.formatEther(ev.args.reward)), "ok");
      }
    }
  } catch (e) {
    M.lastSubmitAt = Date.now();
    log(t("logRejected", errMsg(e)), "err");
  } finally {
    if (M.pending === share) M.pending = null;
    M.submitting = false;
    refreshChain();
  }
}

function startMining() {
  if (store.get(CONSENT_KEY) !== "yes") return openConsent();
  const M = S.mining;
  Object.assign(M, { running: true, held: false, job: null, sessionHashes: 0, found: 0, submitted: 0, accepted: 0, pending: null, startedAt: performance.now() });
  M.job = currentJob();
  if (document.hidden && $("pauseHidden").checked) M.held = true;
  else spawnWorkers();
  log(t("logStarted", $("threadsSel").value, $("cpuSel").value));
  render();
}

function stopMining() {
  const M = S.mining;
  if (!M.running) return;
  killWorkers();
  M.running = false;
  M.held = false;
  M.pending = null;
  flushCumulative();
  log(t("logStopped"));
  render();
}

function holdForVisibility() {
  const M = S.mining;
  if (!M.running) return;
  if (document.hidden && $("pauseHidden").checked && !M.held) {
    M.held = true;
    killWorkers();
  } else if (!document.hidden && M.held) {
    M.held = false;
    M.startedAt = performance.now();
    spawnWorkers();
  }
  render();
}

function openConsent() {
  const dlg = $("consentDlg");
  const boxes = [...dlg.querySelectorAll(".consent")];
  boxes.forEach((b) => (b.checked = false));
  $("consentOk").disabled = true;
  dlg.returnValue = "";
  dlg.showModal();
}

// ───────────────────────── 화면 ─────────────────────────

function render() {
  const M = S.mining;
  const connected = !!S.account;

  $("connectBtn").textContent = connected ? short(S.account) : t("connect");
  $("langBtn").textContent = getLang() === "ko" ? "EN" : "한국어";

  // 배너
  const banners = [];
  if (!hasContract) banners.push({ text: t("noContract") });
  if (connected && !chainOk()) banners.push({ text: t("wrongNetwork"), action: t("switchNetwork"), onClick: switchNetwork });
  if (S.chain?.paused) banners.push({ text: t("paused") });
  $("banners").replaceChildren(
    ...banners.map((b) => {
      const div = document.createElement("div");
      div.className = "banner";
      const span = document.createElement("span");
      span.textContent = b.text;
      div.append(span);
      if (b.action) {
        const btn = document.createElement("button");
        btn.textContent = b.action;
        btn.onclick = b.onClick;
        div.append(btn);
      }
      return div;
    })
  );

  // 장치 상태
  const st = $("deviceStatus");
  if (!connected) { st.textContent = t("stDisconnected"); st.className = "status-line"; }
  else if (S.me?.registered) { st.textContent = `${t("stRegistered")} · ${short(S.account)}`; st.className = "status-line ok"; }
  else { st.textContent = `${t("stUnregistered")} · ${short(S.account)}`; st.className = "status-line warn"; }
  $("modeLine").textContent = canSubmit() ? t("modeSubmit") : `${t("modeMeasure")} — ${t("modeMeasureHint")}`;

  const rs = $("runState");
  rs.className = "run-state" + (M.running ? (M.held ? " held" : " on") : "");
  $("runStateText").textContent = M.running ? (M.held ? t("hiddenPaused") : t("running")) : t("idle");
  const sb = $("startBtn");
  sb.textContent = M.running ? t("stop") : t("start");
  sb.classList.toggle("stop", M.running);
  $("threadsSel").disabled = M.running;
  $("cpuSel").disabled = false;

  // 실시간 값
  const hps = M.running && !M.held ? hashrate() : 0;
  $("liveHps").textContent = fmtHps(hps);
  $("liveHashes").textContent = fmtInt(M.sessionHashes);
  $("liveFound").textContent = fmtInt(M.found);
  $("liveSubmitted").textContent = `${M.submitted} / ${M.accepted}`;
  const wait = (nextSubmitAt() - Date.now()) / 1000;
  $("liveNext").textContent = canSubmit() ? (wait > 0 ? fmtDuration(wait) : t("now")) : "–";

  // 보상 방식 · 참여 신청
  $("rewardModeCard").hidden = !(S.me?.registered);
  const stakeOn = !!S.chain?.stakingEnabled;
  $("rmStake").disabled = !stakeOn;
  $("rmStakeOff").hidden = stakeOn;
  $("applyCard").hidden = !(connected && hasContract && chainOk() && S.me && !S.me.registered);

  // 대시보드
  const c = S.chain;
  const me = S.me;
  $("sHps").textContent = fmtHps(hps);
  $("sCum").textContent = fmtInt(cumulative());
  $("sSubAcc").textContent = `${M.submitted} / ${M.accepted}`;
  $("sMyShares").textContent = me ? fmtInt(me.shares) : "–";
  $("sReceived").textContent = me ? fmtMst(me.toWallet) : "–";
  $("sStaked").textContent = me ? fmtMst(me.toStaking) : "–";
  $("sToday").textContent = me && c ? `${fmtMst(me.today)} / ${fmtMst(c.params.dailyCapPerWallet)}` : "–";
  $("sDiff").textContent = c ? fmtBig(c.difficulty) : "–";
  $("sExpect").textContent = c && hps > 0 ? fmtDuration(Number(c.difficulty) / hps) : "–";
  $("sPool").textContent = c ? fmtMst(c.pool) : "–";
  $("sReward").textContent = c ? fmtMst(c.params.rewardPerShare) : "–";
  $("sEpoch").textContent = c ? c.epoch.toString() : "–";
  $("sEpochProg").textContent = c ? `${c.epochShares} / ${c.params.sharesPerEpoch}` : "–";
  $("sDevices").textContent = c ? c.devices.toString() : "–";
  $("sNetShares").textContent = c ? fmtInt(c.netShares) : "–";

  // 관리자 탭은 권한이 있는 지갑에만
  const isAdminish = chainOk() && (S.roles.admin || S.roles.registrar || S.roles.params);
  $("adminTabBtn").hidden = !isAdminish;
  if (!isAdminish && $("tab-admin").classList.contains("active")) selectTab("mine");

  $("contractInfo").textContent = hasContract ? `Contract ${CONFIG.contractAddress} · Chain ${CONFIG.chainId}` : "";
}

// ───────────────────────── 스테이킹 ─────────────────────────

async function refreshStaking() {
  try {
    const addr = await reader.staking();
    if (addr === ethers.ZeroAddress) {
      stakingReader = null;
    } else if (!stakingReader || stakingReader.target !== addr) {
      stakingReader = new ethers.Contract(addr, STAKING_ABI, readProvider);
    }
    if (!stakingReader) {
      S.staking = null;
    } else {
      const a = S.account;
      const [totalAssets, reserve, rate, balance, compounded] = await Promise.all([
        stakingReader.totalAssetsNow(), stakingReader.rewardReserve(), stakingReader.rewardRate(),
        a ? stakingReader.balanceOf(a) : 0n, a ? stakingReader.compoundedOf(a) : 0n,
      ]);
      S.staking = { totalAssets, reserve, rate, balance, compounded };
    }
  } catch {
    S.staking = null;
  }
  renderStaking();
}

function renderStaking() {
  const st = S.staking;
  $("stkNone").hidden = !!st;
  $("stkBody").hidden = !st;
  if (!st) return;
  $("stkBalance").textContent = S.account ? fmtMst(st.balance) : "–";
  $("stkCompounded").textContent = S.account ? fmtMst(st.compounded) : "–";
  $("stkTotal").textContent = fmtMst(st.totalAssets);
  $("stkReserve").textContent = fmtMst(st.reserve);
  $("stkRate").textContent = `${fmtMst(st.rate * 86400n)} ${t("stkPerDay")}`;
}

async function stakingSend(build) {
  try {
    if (!stakingReader) throw new Error(t("stkNone"));
    const c = new ethers.Contract(stakingReader.target, STAKING_ABI, await S.provider.getSigner());
    const tx = await build(c);
    toast(t("logTxSent", short(tx.hash)));
    await tx.wait();
    toast(t("txDone"));
    await refreshStaking();
  } catch (e) {
    toast(t("txFail", errMsg(e)));
  }
}

function selectTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${name}`));
  if (name === "history") loadHistory();
  if (name === "admin") loadAdmin();
}

// ───────────────────────── 이벤트 조회 ─────────────────────────

async function queryLogs(filter, { limit = Infinity } = {}) {
  const latest = await readProvider.getBlockNumber();
  const out = [];
  for (let to = latest; to >= CONFIG.deployBlock && out.length < limit; to -= CONFIG.logChunk) {
    const from = Math.max(CONFIG.deployBlock, to - CONFIG.logChunk + 1);
    const logs = await reader.queryFilter(filter, from, to);
    out.push(...logs.reverse());
  }
  return out.slice(0, limit);
}

async function loadHistory() {
  const body = $("histBody");
  const row = (cells) => {
    const tr = document.createElement("tr");
    for (const c of cells) {
      const td = document.createElement("td");
      if (c instanceof Node) td.append(c); else td.textContent = c;
      tr.append(td);
    }
    return tr;
  };
  const message = (key) => {
    const tr = row([t(key)]);
    tr.firstChild.colSpan = 4;
    tr.firstChild.className = "muted";
    body.replaceChildren(tr);
  };
  if (!S.account || !reader) return message("connectFirst");
  message("loading");
  try {
    const logs = await queryLogs(reader.filters.ShareAccepted(S.account), { limit: 200 });
    if (!logs.length) return message("histEmpty");
    const blocks = [...new Set(logs.slice(0, 100).map((l) => l.blockNumber))];
    const times = new Map(
      await Promise.all(blocks.map(async (n) => [n, (await readProvider.getBlock(n))?.timestamp]))
    );
    body.replaceChildren(
      ...logs.map((l) => {
        const ts = times.get(l.blockNumber);
        const hash = document.createElement("span");
        hash.className = "mono";
        hash.textContent = `${l.args.hash.slice(0, 18)}…`;
        hash.title = l.args.hash;
        let hashCell = hash;
        const url = explorerTx(l.transactionHash);
        if (url) {
          const a = document.createElement("a");
          a.href = url;
          a.target = "_blank";
          a.rel = "noopener";
          a.append(hash);
          hashCell = a;
        }
        const tr = row([String(l.blockNumber), ts ? new Date(ts * 1000).toLocaleString() : "", hashCell, fmtMst(l.args.reward)]);
        tr.lastChild.className = "num";
        return tr;
      })
    );
  } catch (e) {
    message("histEmpty");
    toast(t("txFail", errMsg(e)));
  }
}

// ───────────────────────── 관리자 ─────────────────────────

async function send(build) {
  try {
    const c = await writer();
    const tx = await build(c);
    toast(t("logTxSent", short(tx.hash)));
    await tx.wait();
    toast(t("txDone"));
    await refreshChain();
    if ($("tab-admin").classList.contains("active")) loadAdmin();
    return true;
  } catch (e) {
    toast(t("txFail", errMsg(e)));
    return false;
  }
}

function listItem(addr, label, button) {
  const li = document.createElement("li");
  const span = document.createElement("span");
  span.className = "mono";
  span.textContent = label ? `${addr} · ${label}` : addr;
  li.append(span);
  if (button) li.append(button);
  return li;
}

function smallButton(text, onClick, cls = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  if (cls) b.className = cls;
  b.onclick = onClick;
  return b;
}

async function loadAdmin() {
  if (!reader || !S.chain) return;
  const p = S.chain.params;
  $("pReward").value = ethers.formatEther(p.rewardPerShare);
  $("pDaily").value = ethers.formatEther(p.dailyCapPerWallet);
  $("pEpoch").value = ethers.formatEther(p.epochCap);
  $("pInterval").value = p.targetInterval.toString();
  $("pPerEpoch").value = p.sharesPerEpoch.toString();
  $("pMinInt").value = p.minShareInterval.toString();
  $("stakingToggle").checked = S.chain.stakingEnabled;

  try {
    // 현재 등록 여부는 isRegistered로 다시 확인하므로 해제 이벤트는 따로 읽지 않는다.
    const [requests, registered] = await Promise.all([
      queryLogs(reader.filters.RegistrationRequested()),
      queryLogs(reader.filters.DeviceRegistered()),
    ]);
    // 최신 기록이 앞에 오므로 처음 본 라벨을 쓴다.
    const labels = new Map();
    for (const l of [...registered, ...requests]) if (!labels.has(l.args[0])) labels.set(l.args[0], l.args.label);
    const candidates = [...new Set([...requests, ...registered].map((l) => l.args[0]))];
    const status = new Map(await Promise.all(candidates.map(async (a) => [a, await reader.isRegistered(a)])));

    const pending = [...new Set(requests.map((l) => l.args.applicant))].filter((a) => !status.get(a));
    $("pendingList").replaceChildren(
      ...(pending.length
        ? pending.map((a) => listItem(a, labels.get(a), smallButton(t("approve"), () => send((c) => c.registerDevice(a, labels.get(a) || "")))))
        : [listItem(t("none"))])
    );
    const active = candidates.filter((a) => status.get(a));
    $("registeredList").replaceChildren(
      ...(active.length
        ? active.map((a) => listItem(a, labels.get(a), smallButton(t("unregister"), () => confirm(t("confirmUnregister", a)) && send((c) => c.unregisterDevice(a)), "danger")))
        : [listItem(t("none"))])
    );
  } catch (e) {
    toast(t("txFail", errMsg(e)));
  }
  updateTargetPreview();
}

function updateTargetPreview() {
  const hps = Number($("hpsInput").value);
  const interval = Number($("pInterval").value || S.chain?.params?.targetInterval || 60);
  if (!(hps > 0)) return ($("targetPreview").textContent = "");
  const target = ethers.MaxUint256 / (BigInt(Math.round(hps)) * BigInt(interval));
  $("targetPreview").textContent = `target = 0x${target.toString(16)} (≈ ${fmtBig(BigInt(Math.round(hps)) * BigInt(interval))} hashes/share)`;
  return target;
}

// ───────────────────────── 바인딩 ─────────────────────────

function bind() {
  const cores = navigator.hardwareConcurrency || 4;
  const sel = $("threadsSel");
  for (let i = 1; i <= cores; i++) sel.append(new Option(String(i), String(i)));
  sel.value = String(Math.max(1, Math.floor(cores / 2)));

  $("langBtn").onclick = () => { setLang(getLang() === "ko" ? "en" : "ko"); render(); };
  $("connectBtn").onclick = () => connect(true).catch((e) => toast(t("txFail", errMsg(e))));
  document.querySelectorAll(".tabs button").forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));
  $("startBtn").onclick = () => (S.mining.running ? stopMining() : startMining());
  $("cpuSel").onchange = () => S.mining.workers.forEach((w) => w.postMessage({ type: "cpu", cpuCap: Number($("cpuSel").value) }));
  $("pauseHidden").onchange = holdForVisibility;
  $("refreshBtn").onclick = refreshChain;
  $("histRefreshBtn").onclick = loadHistory;

  // 동의 화면: 세 항목을 모두 체크해야 동의 버튼이 켜진다.
  const dlg = $("consentDlg");
  dlg.querySelectorAll(".consent").forEach((b) =>
    b.addEventListener("change", () => ($("consentOk").disabled = ![...dlg.querySelectorAll(".consent")].every((x) => x.checked)))
  );
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "ok") {
      store.set(CONSENT_KEY, "yes");
      startMining();
    }
  });

  // 정지·탭 종료 시 즉시 멈춘다. 숨김 상태에서는 설정에 따라 잠시 멈춘다.
  window.addEventListener("pagehide", stopMining);
  document.addEventListener("visibilitychange", holdForVisibility);

  $("saveModeBtn").onclick = () => {
    const mode = Number(document.querySelector("input[name=rmode]:checked").value);
    send((c) => c.setRewardMode(mode));
  };
  $("applyBtn").onclick = async () => {
    if (await send((c) => c.requestRegistration($("applyLabel").value.trim()))) toast(t("applied"));
  };

  // 관리자
  const addr = (v) => ethers.getAddress(v.trim());
  $("regBtn").onclick = () => send((c) => c.registerDevice(addr($("regAddr").value), $("regLabel").value.trim()));
  $("unregBtn").onclick = () => {
    const a = addr($("regAddr").value);
    if (confirm(t("confirmUnregister", a))) send((c) => c.unregisterDevice(a));
  };
  $("batchBtn").onclick = () => {
    const rows = $("batchInput").value.split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(","));
    const addrs = rows.map((r) => addr(r[0]));
    const labels = rows.map((r) => (r[1] || "").trim());
    send((c) => c.registerDevices(addrs, labels));
  };
  $("fundBtn").onclick = () => send((c) => c.fundPool({ value: ethers.parseEther($("poolAmount").value || "0") }));
  $("withdrawBtn").onclick = () => send((c) => c.withdrawPool(S.account, ethers.parseEther($("poolAmount").value || "0")));
  $("paramsBtn").onclick = () =>
    send((c) =>
      c.setParams({
        rewardPerShare: ethers.parseEther($("pReward").value),
        dailyCapPerWallet: ethers.parseEther($("pDaily").value),
        epochCap: ethers.parseEther($("pEpoch").value),
        targetInterval: BigInt($("pInterval").value),
        sharesPerEpoch: BigInt($("pPerEpoch").value),
        minShareInterval: BigInt($("pMinInt").value),
      })
    );
  $("hpsInput").oninput = updateTargetPreview;
  $("targetBtn").onclick = () => {
    const target = updateTargetPreview();
    if (target) send((c) => c.setTarget(target));
  };
  $("stakingToggle").onchange = (e) => send((c) => c.setStakingEnabled(e.target.checked));
  $("stakingAddrBtn").onclick = () => {
    const a = $("stakingAddr").value.trim();
    if (ethers.isAddress(a)) send((c) => c.setStakingContract(a));
  };
  $("stkStakeBtn").onclick = () => {
    const v = $("stkAmount").value;
    if (v && Number(v) > 0) stakingSend((c) => c.stake({ value: ethers.parseEther(v) }));
  };
  $("stkUnstakeBtn").onclick = () => {
    const v = $("stkOutAmount").value;
    if (v && Number(v) > 0) stakingSend((c) => c.unstake(ethers.parseEther(v)));
  };
  $("stkUnstakeAllBtn").onclick = () => stakingSend((c) => c.unstakeAll());
  $("pauseBtn").onclick = () => send((c) => c.pause());
  $("unpauseBtn").onclick = () => send((c) => c.unpause());
}

// ───────────────────────── 시작 ─────────────────────────

applyI18n();
bind();
render();
connect(false).catch(() => {}).finally(refreshChain);
setInterval(refreshChain, CONFIG.refreshMs);
setInterval(() => {
  if (S.mining.running) {
    trySubmit();
    render();
  }
}, 1000);
setInterval(flushCumulative, 5000);
