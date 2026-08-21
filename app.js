// Firebase 初期化
const firebaseConfig = {
  apiKey: "AIzaSyDehvyLC1y-nL2uUvFpV-96R_QjQna0DYk",
  authDomain: "mahjong-score-app-382cf.firebaseapp.com",
  databaseURL: "https://mahjong-score-app-382cf-default-rtdb.firebaseio.com",
  projectId: "mahjong-score-app-382cf",
  storageBucket: "mahjong-score-app-382cf.firebasestorage.app",
  messagingSenderId: "998848135440",
  appId: "1:998848135440:web:27e2f3945a0c87a843e595"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const { createApp, ref, computed, onMounted, watch } = Vue;

createApp({
  setup() {
    const currentTab = ref('active');
    const isFinishModalOpen = ref(false);
    const isStartModalOpen = ref(false);
    const isResumeModalOpen = ref(false);
    const isSessionStarted = ref(false);
    const isRoomClosed = ref(false);
    const isHost = ref(false);
    const hostKey = ref(null);
    const roomId = ref(null);
    let isRemoteUpdating = false;

    // 対戦設定
    const sessionConfig = ref({
      gameMode: '4p',
      controlMode: 'all',
      status: 'active',
      hostKey: null
    });

    const presetRates = [
      { label: "ノーレート", sub: "0円", value: 0 },
      { label: "テンイチ", sub: "10円", value: 10 },
      { label: "テンゴ", sub: "50円", value: 50 },
      { label: "テンピン", sub: "100円", value: 100 }
    ];

    const tempSetup = ref({
      gameMode: '4p',
      rate: 50,
      playerNames: ["プレイヤーA", "プレイヤーB", "プレイヤーC", "プレイヤーD"],
      connectionType: 'room',
      controlMode: 'hostOnly'
    });

    const selectPresetRate = (val) => {
      tempSetup.value.rate = val;
    };

    const gameMultiplier = ref(1);

    const defaultPresets4P = [
      { name: "定番ルール1 (25-25 / 10-30)", startingPoints: 25000, returnPoints: 25000, uma: [30, 10, -10, -30] },
      { name: "Mリーグルール (25-30 / 10-30)", startingPoints: 25000, returnPoints: 30000, uma: [30, 10, -10, -30] }
    ];

    const defaultPresets3P = [
      { name: "サンマ標準 (35-40 / 10-20)", startingPoints: 35000, returnPoints: 40000, uma: [20, 0, -20] },
      { name: "サンマ沈みウマ (35-35 / 15-30)", startingPoints: 35000, returnPoints: 35000, uma: [30, 0, -30] }
    ];

    const presets4P = ref([...defaultPresets4P]);
    const presets3P = ref([...defaultPresets3P]);
    const selectedPresetIndex = ref(0);

    const currentRule = ref({ ...defaultPresets4P[0] });
    const rate = ref(50);

    const playerNames = ref(["プレイヤーA", "プレイヤーB", "プレイヤーC", "プレイヤーD"]);
    const currentInput = ref([
      { rawScore: 25000 },
      { rawScore: 25000 },
      { rawScore: 25000 },
      { rawScore: 25000 }
    ]);
    const bonusPoints = ref([0, 0, 0, 0]);

    const history = ref([]);
    const sessionArchives = ref([]);

    // ページネーション & アコーディオン展開状態
    const currentArchivePage = ref(1);
    const itemsPerPage = 5;
    const expandedArchiveIds = ref([]);
    const cachedSessionState = ref(null);

    const playerCount = computed(() => (sessionConfig.value.gameMode === '4p' ? 4 : 3));
    const activePlayers = computed(() => playerNames.value.slice(0, playerCount.value));
    const activeInput = computed(() => currentInput.value.slice(0, playerCount.value));
    const currentPresets = computed(() => (sessionConfig.value.gameMode === '4p' ? presets4P.value : presets3P.value));

    const isReadOnly = computed(() => {
      if (isRoomClosed.value) return true;
      if (!roomId.value) return false;
      if (sessionConfig.value.controlMode === 'hostOnly' && !isHost.value) {
        return true;
      }
      return false;
    });

    const activeHistory = computed(() => history.value.filter(g => !g.excluded));

    const allHistorySorted = computed(() => {
      const active = history.value.filter(g => !g.excluded);
      const excluded = history.value.filter(g => g.excluded);
      return [...active, ...excluded];
    });

    const totalInputPoints = computed(() => {
      return activeInput.value.reduce((sum, p) => sum + (Number(p.rawScore) || 0), 0);
    });

    const isPointsValid = computed(() => {
      return totalInputPoints.value === currentRule.value.startingPoints * playerCount.value;
    });

    const bonusSum = computed(() => {
      return bonusPoints.value.slice(0, playerCount.value).reduce((sum, b) => sum + (Number(b) || 0), 0);
    });
    const isBonusValid = computed(() => bonusSum.value === 0);

    // ==========================================
    // 過去ログページネーション & 勝者計算
    // ==========================================
    const totalPages = computed(() => {
      return Math.ceil(sessionArchives.value.length / itemsPerPage) || 1;
    });

    const paginatedArchives = computed(() => {
      const start = (currentArchivePage.value - 1) * itemsPerPage;
      return sessionArchives.value.slice(start, start + itemsPerPage);
    });

    const toggleArchiveDetail = (id) => {
      const idx = expandedArchiveIds.value.indexOf(id);
      if (idx > -1) {
        expandedArchiveIds.value.splice(idx, 1);
      } else {
        expandedArchiveIds.value.push(id);
      }
    };

    const getTopPlayer = (session) => {
      if (!session.players || session.players.length === 0) return { name: '-', point: 0 };
      return [...session.players].sort((a, b) => b.point - a.point)[0];
    };

    // ==========================================
    // ローカル自動バックアップ（タブ閉じ対策）
    // ==========================================
    const saveLocalBackup = () => {
      if (isSessionStarted.value && !isRoomClosed.value) {
        const state = {
          isSessionStarted: isSessionStarted.value,
          sessionConfig: sessionConfig.value,
          currentRule: currentRule.value,
          rate: rate.value,
          playerNames: playerNames.value,
          currentInput: currentInput.value,
          bonusPoints: bonusPoints.value,
          history: history.value,
          sessionArchives: sessionArchives.value,
          roomId: roomId.value
        };
        localStorage.setItem("mahjong_active_session_backup", JSON.stringify(state));
      } else {
        localStorage.removeItem("mahjong_active_session_backup");
      }
    };

    const resumeCachedSession = () => {
      if (cachedSessionState.value) {
        const val = cachedSessionState.value;
        isSessionStarted.value = val.isSessionStarted;
        if (val.sessionConfig) sessionConfig.value = val.sessionConfig;
        if (val.currentRule) currentRule.value = val.currentRule;
        if (val.rate !== undefined) rate.value = val.rate;
        if (val.playerNames) playerNames.value = val.playerNames;
        if (val.currentInput) currentInput.value = val.currentInput;
        if (val.bonusPoints) bonusPoints.value = val.bonusPoints;
        if (val.history) history.value = val.history;
        if (val.sessionArchives) sessionArchives.value = val.sessionArchives;
        if (val.roomId) listenToRoom(val.roomId);
      }
      isResumeModalOpen.value = false;
    };

    const discardCachedSession = () => {
      localStorage.removeItem("mahjong_active_session_backup");
      cachedSessionState.value = null;
      isResumeModalOpen.value = false;
    };

    // ==========================================
    // Firebase 同期ロジック
    // ==========================================
    const syncStateToFirebase = () => {
      saveLocalBackup();
      if (isRemoteUpdating || !roomId.value || isReadOnly.value) return;

      const payload = {
        isSessionStarted: isSessionStarted.value,
        sessionConfig: sessionConfig.value,
        currentRule: currentRule.value,
        rate: rate.value,
        playerNames: playerNames.value,
        currentInput: currentInput.value,
        bonusPoints: bonusPoints.value,
        history: history.value,
        sessionArchives: sessionArchives.value,
        updatedAt: Date.now()
      };

      db.ref(`rooms/${roomId.value}`).set(payload);
    };

    const listenToRoom = (id) => {
      roomId.value = id;

      db.ref(`rooms/${id}`).on('value', (snapshot) => {
        const val = snapshot.val();
        if (!val) return;

        isRemoteUpdating = true;
        isSessionStarted.value = !!val.isSessionStarted;
        if (val.sessionConfig) {
          sessionConfig.value = val.sessionConfig;
          isRoomClosed.value = (val.sessionConfig.status === 'closed');
        }
        if (val.currentRule) currentRule.value = val.currentRule;
        if (val.rate !== undefined) rate.value = val.rate;
        if (val.playerNames) playerNames.value = val.playerNames;
        if (val.currentInput) currentInput.value = val.currentInput;
        if (val.bonusPoints) bonusPoints.value = val.bonusPoints;
        if (val.history) history.value = val.history;
        if (val.sessionArchives) sessionArchives.value = val.sessionArchives;

        const localHostKey = localStorage.getItem(`mahjong_host_${id}`);
        if (val.sessionConfig?.hostKey && localHostKey === val.sessionConfig.hostKey) {
          isHost.value = true;
        } else {
          isHost.value = false;
        }

        saveLocalBackup();

        setTimeout(() => {
          isRemoteUpdating = false;
        }, 100);
      });
    };

    const openStartModal = () => {
      tempSetup.value.playerNames = [...playerNames.value];
      tempSetup.value.rate = rate.value;
      isStartModalOpen.value = true;
    };

    const confirmStartSession = () => {
      sessionConfig.value.gameMode = tempSetup.value.gameMode;
      sessionConfig.value.controlMode = tempSetup.value.controlMode;
      sessionConfig.value.status = 'active';
      isRoomClosed.value = false;
      rate.value = Number(tempSetup.value.rate) || 0;
      playerNames.value = [...tempSetup.value.playerNames];

      selectedPresetIndex.value = 0;
      applyPreset();

      history.value = [];
      bonusPoints.value = [0, 0, 0, 0];
      gameMultiplier.value = 1;
      isSessionStarted.value = true;
      isStartModalOpen.value = false;

      if (tempSetup.value.connectionType === 'room') {
        const newRoomId = Math.floor(1000 + Math.random() * 9000).toString();
        const generatedHostKey = 'h_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        sessionConfig.value.hostKey = generatedHostKey;
        isHost.value = true;
        localStorage.setItem(`mahjong_host_${newRoomId}`, generatedHostKey);

        window.history.replaceState(null, '', `?room=${newRoomId}`);
        listenToRoom(newRoomId);
        syncStateToFirebase();
      } else {
        roomId.value = null;
        window.history.replaceState(null, '', window.location.pathname);
        saveLocalBackup();
      }
    };

    const joinRoomPrompt = () => {
      const code = prompt("参加する4桁のルーム番号を入力してください:");
      if (code && code.trim()) {
        window.history.replaceState(null, '', `?room=${code.trim()}`);
        listenToRoom(code.trim());
      }
    };

    const copyRoomUrl = () => {
      const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId.value}`;
      navigator.clipboard.writeText(shareUrl).then(() => {
        alert("招待リンクをコピーしました！友人に共有してください。");
      });
    };

    const leaveRoom = () => {
      if (confirm("ルームから退室しますか？")) {
        if (roomId.value) db.ref(`rooms/${roomId.value}`).off();
        roomId.value = null;
        isSessionStarted.value = false;
        isRoomClosed.value = false;
        localStorage.removeItem("mahjong_active_session_backup");
        window.history.replaceState(null, '', window.location.pathname);
      }
    };

    const confirmResetSession = () => {
      if (confirm("現在の対局設定をリセットし、最初からやり直しますか？")) {
        isSessionStarted.value = false;
        isRoomClosed.value = false;
        history.value = [];
        localStorage.removeItem("mahjong_active_session_backup");
        syncStateToFirebase();
      }
    };

    const adjustScore = (idx, delta) => {
      currentInput.value[idx].rawScore = (currentInput.value[idx].rawScore || 0) + delta;
      syncStateToFirebase();
    };

    const applyPreset = () => {
      const selected = currentPresets.value[selectedPresetIndex.value];
      if (selected) {
        currentRule.value = {
          name: selected.name,
          startingPoints: selected.startingPoints,
          returnPoints: selected.returnPoints,
          uma: [...selected.uma]
        };
        resetInputPoints();
        syncStateToFirebase();
      }
    };

    const resetInputPoints = () => {
      currentInput.value.forEach(p => p.rawScore = currentRule.value.startingPoints);
    };

    const getNextCustomName = () => {
      const customRegex = /^カスタム(\d+)$/;
      let maxNum = 0;
      currentPresets.value.forEach(p => {
        const match = p.name.match(customRegex);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      });
      return `カスタム${maxNum + 1}`;
    };

    const saveNewPreset = () => {
      const defaultName = currentRule.value.name?.trim() || getNextCustomName();
      const name = prompt("プリセット名を入力してください:", defaultName);
      if (!name) return;

      const newPreset = {
        name: name.trim(),
        startingPoints: currentRule.value.startingPoints,
        returnPoints: currentRule.value.returnPoints,
        uma: [...currentRule.value.uma]
      };

      if (sessionConfig.value.gameMode === '4p') {
        presets4P.value.push(newPreset);
        selectedPresetIndex.value = presets4P.value.length - 1;
        localStorage.setItem("mahjong_presets4p_v6", JSON.stringify(presets4P.value));
      } else {
        presets3P.value.push(newPreset);
        selectedPresetIndex.value = presets3P.value.length - 1;
        localStorage.setItem("mahjong_presets3p_v6", JSON.stringify(presets3P.value));
      }
      currentRule.value.name = newPreset.name;
      syncStateToFirebase();
    };

    const commitGame = () => {
      if (!isPointsValid.value) return;

      const rule = currentRule.value;
      const appliedRuleName = rule.name?.trim() || getNextCustomName();
      const numPlayers = playerCount.value;
      const mult = Number(gameMultiplier.value) || 1;

      const rawData = activeInput.value.map((p, idx) => ({
        name: playerNames.value[idx],
        rawScore: Number(p.rawScore) || 0
      }));

      const sorted = [...rawData].sort((a, b) => b.rawScore - a.rawScore);
      const totalOka = ((rule.returnPoints - rule.startingPoints) * numPlayers) / 1000;

      const rankBasePoints = rule.uma.map((umaVal, idx) => {
        return umaVal + (idx === 0 ? totalOka : 0);
      });

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

        const startRank = i + 1;
        const rankDisplay = tieCount > 1 ? `${startRank}位タイ` : `${startRank}位`;

        for (let k = i; k <= j; k++) {
          const p = sorted[k];
          const rawPoint = (p.rawScore - rule.returnPoints) / 1000;
          const finalPoint = (rawPoint + splitUmaOka) * mult;

          results.push({
            rankDisplay: rankDisplay,
            name: p.name,
            rawScore: p.rawScore,
            point: finalPoint
          });
        }

        i = j + 1;
      }

      history.value.push({
        id: Date.now(),
        title: `第 ${activeHistory.value.length + 1} 回戦`,
        mode: sessionConfig.value.gameMode,
        ruleName: appliedRuleName,
        multiplier: mult,
        results: results,
        excluded: false
      });

      gameMultiplier.value = 1;
      resetInputPoints();
      syncStateToFirebase();
    };

    const toggleExclude = (id, exclude) => {
      const item = history.value.find(g => g.id === id);
      if (item) {
        item.excluded = exclude;
        let count = 1;
        history.value.forEach(g => {
          if (!g.excluded) {
            g.title = `第 ${count++} 回戦`;
          }
        });
        syncStateToFirebase();
      }
    };

    const cumulativePoints = computed(() => {
      const map = {};
      activePlayers.value.forEach(name => map[name] = 0);

      activeHistory.value.forEach(game => {
        game.results.forEach(res => {
          if (map[res.name] !== undefined) {
            map[res.name] += res.point;
          }
        });
      });

      return activePlayers.value.map(name => map[name] || 0);
    });

    const totalPointsWithBonus = computed(() => {
      return cumulativePoints.value.map((pt, idx) => pt + (Number(bonusPoints.value[idx]) || 0));
    });

    const totalMoney = computed(() => {
      const r = rate.value || 0;
      const calculatedMoney = totalPointsWithBonus.value.map(pt => Math.round(pt * r));
      const sum = calculatedMoney.reduce((acc, v) => acc + v, 0);
      if (calculatedMoney.length > 0 && sum !== 0) {
        calculatedMoney[0] -= sum;
      }
      return calculatedMoney;
    });

    const settlements = computed(() => {
      const balances = activePlayers.value.map((name, idx) => ({
        name: name,
        money: totalMoney.value[idx] || 0
      }));

      let debtors = balances.filter(b => b.money < 0).map(b => ({ name: b.name, balance: -b.money }));
      let creditors = balances.filter(b => b.money > 0).map(b => ({ name: b.name, balance: b.money }));

      debtors.sort((a, b) => b.balance - a.balance);
      creditors.sort((a, b) => b.balance - a.balance);

      const list = [];
      let d = 0, c = 0;

      while (d < debtors.length && c < creditors.length) {
        const debtor = debtors[d];
        const creditor = creditors[c];
        const amount = Math.min(debtor.balance, creditor.balance);

        if (amount > 0) {
          list.push({
            from: debtor.name,
            to: creditor.name,
            amount: Math.round(amount)
          });
        }

        debtor.balance -= amount;
        creditor.balance -= amount;

        if (debtor.balance === 0) d++;
        if (creditor.balance === 0) c++;
      }

      return list;
    });

    const openFinishModal = () => {
      isFinishModalOpen.value = true;
    };

    const archiveAndReset = () => {
      const now = new Date();
      const dateStr = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      const newArchive = {
        id: Date.now(),
        date: dateStr,
        mode: sessionConfig.value.gameMode,
        totalGames: activeHistory.value.length,
        rate: rate.value,
        players: activePlayers.value.map((name, idx) => ({
          name,
          point: totalPointsWithBonus.value[idx],
          money: totalMoney.value[idx]
        })),
        settlements: [...settlements.value]
      };

      sessionArchives.value.unshift(newArchive);
      localStorage.setItem("mahjong_archives_storage", JSON.stringify(sessionArchives.value));
      localStorage.removeItem("mahjong_active_session_backup");

      sessionConfig.value.status = 'closed';
      isRoomClosed.value = true;
      isSessionStarted.value = false;
      isFinishModalOpen.value = false;

      syncStateToFirebase();
    };

    const deleteArchive = (id) => {
      if (confirm("この対戦結果を削除しますか？")) {
        sessionArchives.value = sessionArchives.value.filter(a => a.id !== id);
        localStorage.setItem("mahjong_archives_storage", JSON.stringify(sessionArchives.value));
        syncStateToFirebase();
      }
    };

    onMounted(() => {
      // 過去アーカイブのローカル復元
      const savedArchives = localStorage.getItem("mahjong_archives_storage");
      if (savedArchives) {
        sessionArchives.value = JSON.parse(savedArchives);
      }

      const urlParams = new URLSearchParams(window.location.search);
      const roomParam = urlParams.get('room');

      if (roomParam) {
        listenToRoom(roomParam);
      } else {
        // 中断データの自動復帰検知
        const backup = localStorage.getItem("mahjong_active_session_backup");
        if (backup) {
          try {
            const parsed = JSON.parse(backup);
            if (parsed.isSessionStarted) {
              cachedSessionState.value = parsed;
              isResumeModalOpen.value = true;
            }
          } catch (e) {
            localStorage.removeItem("mahjong_active_session_backup");
          }
        }
      }
    });

    return {
      currentTab,
      isFinishModalOpen,
      isStartModalOpen,
      isResumeModalOpen,
      isSessionStarted,
      isRoomClosed,
      isHost,
      isReadOnly,
      roomId,
      sessionConfig,
      presetRates,
      tempSetup,
      selectPresetRate,
      gameMultiplier,
      currentPresets,
      selectedPresetIndex,
      currentRule,
      rate,
      playerNames,
      activePlayers,
      activeInput,
      bonusPoints,
      history,
      activeHistory,
      allHistorySorted,
      sessionArchives,
      currentArchivePage,
      totalPages,
      paginatedArchives,
      expandedArchiveIds,
      toggleArchiveDetail,
      getTopPlayer,
      cachedSessionState,
      resumeCachedSession,
      discardCachedSession,
      totalInputPoints,
      isPointsValid,
      bonusSum,
      isBonusValid,
      cumulativePoints,
      totalPointsWithBonus,
      totalMoney,
      settlements,
      openStartModal,
      confirmStartSession,
      joinRoomPrompt,
      copyRoomUrl,
      leaveRoom,
      confirmResetSession,
      syncStateToFirebase,
      adjustScore,
      applyPreset,
      saveNewPreset,
      commitGame,
      toggleExclude,
      openFinishModal,
      archiveAndReset,
      deleteArchive
    };
  }
}).mount('#app');