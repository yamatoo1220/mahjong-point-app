// クライアントから届いた値の検査と正規化。
// 不正な値は null を返して書き込みを拒否する（部分的に直して受け入れることはしない）。

const MAX_NAME = 30;
const MAX_RULE_NAME = 60;
const MAX_ABS = 1e9;
const FEE_METHODS = ["none", "equal", "top", "tiered", "custom"];

// 入力途中の空欄（""）は数値として扱わず、そのまま保持する
const isNum = v => v === "" || (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_ABS);
const isStr = (v, max) => typeof v === "string" && v.length <= max;
const isObj = v => typeof v === "object" && v !== null && !Array.isArray(v);
const numArray = (v, len) => Array.isArray(v) && v.length === len && v.every(isNum);

function sessionConfig(v, current) {
  if (!isObj(v)) return null;
  const next = { ...(current || {}), ...v };
  if (!["4p", "3p"].includes(next.gameMode)) return null;
  if (!["all", "hostOnly"].includes(next.controlMode)) return null;
  if (!["active", "closed"].includes(next.status)) return null;
  return { gameMode: next.gameMode, controlMode: next.controlMode, status: next.status };
}

function currentRule(v) {
  if (!isObj(v)) return null;
  if (v.name !== undefined && !isStr(v.name, MAX_RULE_NAME)) return null;
  if (!isNum(v.startingPoints) || !isNum(v.returnPoints)) return null;
  if (!Array.isArray(v.uma) || v.uma.length < 3 || v.uma.length > 4 || !v.uma.every(isNum)) return null;
  return { name: v.name ?? "", startingPoints: v.startingPoints, returnPoints: v.returnPoints, uma: [...v.uma] };
}

function playerNames(v) {
  if (!Array.isArray(v) || v.length !== 4 || !v.every(n => isStr(n, MAX_NAME))) return null;
  return [...v];
}

function currentInput(v) {
  if (!Array.isArray(v) || v.length !== 4) return null;
  if (!v.every(p => isObj(p) && isNum(p.rawScore))) return null;
  return v.map(p => ({ rawScore: p.rawScore }));
}

function tableFee(v) {
  if (!isObj(v)) return null;
  if (!FEE_METHODS.includes(v.method)) return null;
  if (!isNum(v.total) || !numArray(v.tiers, 4) || !numArray(v.custom, 4)) return null;
  if (!Number.isInteger(v.payer) || v.payer < -1 || v.payer > 3) return null;
  return { method: v.method, total: v.total, tiers: [...v.tiers], custom: [...v.custom], payer: v.payer };
}

const FIELD_VALIDATORS = {
  isSessionStarted: v => (typeof v === "boolean" ? v : null),
  currentRule,
  playerNames,
  currentInput,
  bonusPoints: v => (numArray(v, 4) ? [...v] : null),
  tableFee
};

// ルーム作成時の初期状態（全項目必須）
export function sanitizeInitialState(v) {
  if (!isObj(v)) return null;
  const config = sessionConfig(v.sessionConfig);
  if (!config || config.status !== "active") return null;

  const out = { sessionConfig: config };
  for (const [key, validate] of Object.entries(FIELD_VALIDATORS)) {
    const value = validate(v[key]);
    if (value === null) return null;
    out[key] = value;
  }
  return out;
}

// 部分更新（送られてきた項目だけを検査して返す）
export function sanitizePatch(fields, state) {
  if (!isObj(fields)) return null;
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "sessionConfig") {
      const config = sessionConfig(value, state.sessionConfig);
      if (!config) return null;
      out.sessionConfig = config;
      continue;
    }
    const validate = FIELD_VALIDATORS[key];
    if (!validate) return null;
    const sanitized = validate(value);
    if (sanitized === null) return null;
    out[key] = sanitized;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// 1半荘分の記録
export function sanitizeGame(v) {
  if (!isObj(v)) return null;
  if (!Number.isSafeInteger(v.id) || v.id < 0) return null;
  if (!["4p", "3p"].includes(v.mode)) return null;
  if (!isStr(v.ruleName, MAX_RULE_NAME)) return null;
  if (typeof v.multiplier !== "number" || !(v.multiplier > 0 && v.multiplier <= 100)) return null;
  if (!Array.isArray(v.results) || v.results.length < 3 || v.results.length > 4) return null;

  const results = [];
  for (const r of v.results) {
    if (!isObj(r) || !isStr(r.rankDisplay, 10) || !isStr(r.name, MAX_NAME)) return null;
    if (typeof r.rawScore !== "number" || !Number.isFinite(r.rawScore)) return null;
    if (typeof r.point !== "number" || !Number.isFinite(r.point)) return null;
    results.push({ rankDisplay: r.rankDisplay, name: r.name, rawScore: r.rawScore, point: r.point });
  }

  return {
    id: v.id,
    title: "",
    mode: v.mode,
    ruleName: v.ruleName,
    multiplier: v.multiplier,
    results,
    excluded: false
  };
}
