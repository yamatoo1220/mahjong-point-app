// 点数・精算・場代の計算（身内版・公開版で共通）
// 画面や通信に依存しない純粋な関数だけを置く。<script> で読み込むと globalThis.MahjongCalc に入る。
(function (global) {
  // 1半荘分の順位・ポイントを計算（同点はウマ・オカを山分け）
  function calcGameResults(rule, players, mult) {
    const numPlayers = players.length;
    const sorted = [...players].sort((a, b) => b.rawScore - a.rawScore);
    const totalOka = ((rule.returnPoints - rule.startingPoints) * numPlayers) / 1000;
    const rankBasePoints = rule.uma.map((umaVal, idx) => umaVal + (idx === 0 ? totalOka : 0));

    const results = [];
    let i = 0;
    while (i < numPlayers) {
      let j = i;
      while (j + 1 < numPlayers && sorted[j + 1].rawScore === sorted[i].rawScore) {
        j++;
      }

      const tieCount = j - i + 1;
      let sumUmaOka = 0;
      for (let k = i; k <= j; k++) {
        sumUmaOka += rankBasePoints[k];
      }
      const splitUmaOka = sumUmaOka / tieCount;
      const rankDisplay = tieCount > 1 ? `${i + 1}位タイ` : `${i + 1}位`;

      for (let k = i; k <= j; k++) {
        const p = sorted[k];
        const rawPoint = (p.rawScore - rule.returnPoints) / 1000;
        results.push({
          rankDisplay,
          name: p.name,
          rawScore: p.rawScore,
          point: (rawPoint + splitUmaOka) * mult
        });
      }
      i = j + 1;
    }
    return results;
  }

  // ポイントを整数の金額（または単位）に換算。丸め誤差は先頭の人で吸収して合計0にする
  function pointsToUnits(points, rate) {
    const units = points.map(pt => Math.round(pt * rate));
    const sum = units.reduce((acc, v) => acc + v, 0);
    if (units.length > 0 && sum !== 0) units[0] -= sum;
    return units;
  }

  // ポイント順に並べ、同点をまとめた順位グループ（各グループはプレイヤー index の配列）
  function rankGroups(points) {
    const order = points.map((pt, idx) => idx).sort((a, b) => points[b] - points[a]);
    const groups = [];
    order.forEach(idx => {
      const last = groups[groups.length - 1];
      if (last && points[last[0]] === points[idx]) last.push(idx);
      else groups.push([idx]);
    });
    return groups;
  }

  // amount を idxs の人数で割る。端数は先頭（上位）から1ずつ配る
  function splitAmount(shares, amount, idxs) {
    if (idxs.length === 0) return;
    const base = Math.floor(amount / idxs.length);
    let rest = amount - base * idxs.length;
    idxs.forEach(i => {
      shares[i] += base + (rest > 0 ? 1 : 0);
      if (rest > 0) rest--;
    });
  }

  const toAmount = v => Math.max(0, Math.round(Number(v) || 0));

  // 場代の負担額（プレイヤーごと、整数）
  //   fee.method: 'none' | 'equal' 均等割り | 'top' トップ負担 | 'tiered' 順位で傾斜 | 'custom' 個別入力
  //   points: 順位決定に使う各プレイヤーの最終ポイント
  function calcFeeShares(fee, points) {
    const n = points.length;
    const shares = new Array(n).fill(0);
    if (!fee || fee.method === 'none') return shares;

    if (fee.method === 'custom') {
      return points.map((_, idx) => toAmount(fee.custom?.[idx]));
    }

    const groups = rankGroups(points);
    if (fee.method === 'equal') {
      splitAmount(shares, toAmount(fee.total), groups.flat());
    } else if (fee.method === 'top') {
      splitAmount(shares, toAmount(fee.total), groups[0] || []);
    } else if (fee.method === 'tiered') {
      // 同順位の人は、該当する順位の金額を合算して山分け
      let rank = 0;
      groups.forEach(group => {
        let sum = 0;
        for (let k = rank; k < rank + group.length; k++) sum += toAmount(fee.tiers?.[k]);
        splitAmount(shares, sum, group);
        rank += group.length;
      });
    }
    return shares;
  }

  // 場代による収支の増減。payer が立て替えた場合のみ、他の人から payer への支払いとして反映
  function calcFeeAdjustments(shares, payer) {
    if (!(payer >= 0 && payer < shares.length)) return shares.map(() => 0);
    const total = shares.reduce((acc, v) => acc + v, 0);
    return shares.map((s, idx) => (idx === payer ? total - s : -s));
  }

  // 最小回数の精算ルート（balances は合計0の整数）
  function calcSettlements(names, balances) {
    const debtors = [];
    const creditors = [];
    balances.forEach((b, idx) => {
      if (b < 0) debtors.push({ name: names[idx], balance: -b });
      if (b > 0) creditors.push({ name: names[idx], balance: b });
    });
    debtors.sort((a, b) => b.balance - a.balance);
    creditors.sort((a, b) => b.balance - a.balance);

    const list = [];
    let d = 0;
    let c = 0;
    while (d < debtors.length && c < creditors.length) {
      const debtor = debtors[d];
      const creditor = creditors[c];
      const amount = Math.min(debtor.balance, creditor.balance);
      if (amount > 0) list.push({ from: debtor.name, to: creditor.name, amount: Math.round(amount) });
      debtor.balance -= amount;
      creditor.balance -= amount;
      if (debtor.balance === 0) d++;
      if (creditor.balance === 0) c++;
    }
    return list;
  }

  const api = {
    calcGameResults,
    pointsToUnits,
    rankGroups,
    calcFeeShares,
    calcFeeAdjustments,
    calcSettlements
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MahjongCalc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
