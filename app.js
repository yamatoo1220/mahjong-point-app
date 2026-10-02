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
const auth = firebase.auth();

// 匿名認証（ホスト判定とセキュリティルールに使う uid を取得する）
const authReady = new Promise((resolve, reject) => {
  auth.onAuthStateChanged(user => {
    if (user) resolve(user);
  });
  auth.signInAnonymously().catch(err => {
    console.error('匿名認証に失敗しました', err);
    reject(err);
  });
});
authReady.catch(() => {}); // 失敗時の処理は利用側（ルーム作成・参加）で行う

const MAX_ROOM_CREATE_ATTEMPTS = 20;

// 回戦タイトルを除外されていない半荘だけで振り直す
const renumberHistory = (games) => {
  let count = 1;
  return games.map(g => (g.excluded ? g : { ...g, title: `第 ${count++} 回戦` }));
};

const { createApp, ref, computed, onMounted, watch } = Vue;
const { calcGameResults, pointsToUnits, calcFeeShares, calcFeeAdjustments, calcSettlements } = MahjongCalc;

const FEE_METHODS = [
  { value: 'none', label: 'なし' },
  { value: 'equal', label: '均等割り' },
  { value: 'top', label: 'トップ払い' },
  { value: 'tiered', label: '順位で傾斜' },
  { value: 'custom', label: '個別入力' }
];

const createDefaultTableFee = () => ({
  method: 'none',
  total: 0,
  tiers: [0, 0, 0, 0],
  custom: [0, 0, 0, 0],
  payer: -1
});

createApp({
  setup() {
    const currentTab = ref('active');
    const isFinishModalOpen = ref(false);
    const isStartModalOpen = ref(false);
    const isResumeModalOpen = ref(false);
    const isSessionStarted = ref(false);
    const isRoomClosed = ref(false);
    const isHost = ref(false);
    const roomId = ref(null);
    let isRemoteUpdating = false;
    let roomRef = null;

    // 対戦設定
    const sessionConfig = ref({
      gameMode: '4p',
      controlMode: 'all',
      status: 'active',
      hostUid: null
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
    const tableFee = ref(createDefaultTableFee());

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
          tableFee: tableFee.value,
          history: history.value,
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
        tableFee.value = { ...createDefaultTableFee(), ...(val.tableFee || {}) };
        if (val.history) history.value = val.history;
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
    // ルームで共有する項目（半荘履歴は別途トランザクションで更新する）
    const buildRoomState = () => ({
      isSessionStarted: isSessionStarted.value,
      sessionConfig: sessionConfig.value,
      currentRule: currentRule.value,
      rate: rate.value,
      playerNames: playerNames.value,
      currentInput: currentInput.value,
      bonusPoints: bonusPoints.value,
      tableFee: tableFee.value
    });

    let hasShownWriteError = false;
    const handleWriteError = (err) => {
      console.error('ルームへの保存に失敗しました', err);
      if (!hasShownWriteError) {
        hasShownWriteError = true;
        alert('ルームへの保存に失敗しました。権限がないか、通信が切れている可能性があります。');
      }
    };

    // 変更された項目だけを送る（他の人の半荘記録を上書きしない）
    const syncStateToFirebase = () => {
      saveLocalBackup();
      if (isRemoteUpdating || !roomId.value || isReadOnly.value) return;

      db.ref(`rooms/${roomId.value}`).update({
        ...buildRoomState(),
        updatedAt: firebase.database.ServerValue.TIMESTAMP
      }).catch(handleWriteError);
    };

    // 半荘履歴はサーバー上の最新値に対して操作を適用する（同時入力でも消えない）
    const updateRoomHistory = (mutate) => {
      saveLocalBackup();
      if (!roomId.value || isReadOnly.value) return;

      const id = roomId.value;
      db.ref(`rooms/${id}/history`)
        .transaction(current => renumberHistory(mutate(Array.isArray(current) ? current : [])))
        .then(() => db.ref(`rooms/${id}/updatedAt`).set(firebase.database.ServerValue.TIMESTAMP))
        .catch(handleWriteError);
    };

    const stopListening = () => {
      if (roomRef) roomRef.off();
      roomRef = null;
    };

    const listenToRoom = (id) => {
      stopListening();
      roomId.value = id;

      authReady.then(user => {
        if (roomId.value !== id) return;
        roomRef = db.ref(`rooms/${id}`);
        let isFirstSnapshot = true;

        roomRef.on('value', (snapshot) => {
          const val = snapshot.val();
          if (!val) {
            if (isFirstSnapshot) {
              alert(`ルーム #${id} が見つかりませんでした。番号を確認してください。`);
              stopListening();
              roomId.value = null;
              window.history.replaceState(null, '', window.location.pathname);
            }
            return;
          }
          isFirstSnapshot = false;

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
          tableFee.value = { ...createDefaultTableFee(), ...(val.tableFee || {}) };
          history.value = Array.isArray(val.history) ? val.history : [];

          isHost.value = !!val.sessionConfig?.hostUid && val.sessionConfig.hostUid === user.uid;

          saveLocalBackup();

          setTimeout(() => {
            isRemoteUpdating = false;
          }, 100);
        }, (err) => {
          console.error('ルームの読み込みに失敗しました', err);
          alert('ルームを読み込めませんでした。通信状況を確認してください。');
        });
      }).catch(() => {
        alert('ルームに接続できませんでした（認証エラー）。時間をおいて再読み込みしてください。');
      });
    };

    // 空いているルーム番号を確保して作成（既存ルームは上書きしない）
    const createRoom = async (initialState) => {
      for (let i = 0; i < MAX_ROOM_CREATE_ATTEMPTS; i++) {
        const candidate = String(1000 + Math.floor(Math.random() * 9000));
        const result = await db.ref(`rooms/${candidate}`).transaction(
          current => (current === null ? initialState : undefined),
          undefined,
          false
        );
        if (result.committed) return candidate;
      }
      throw new Error('空いているルーム番号が見つかりませんでした');
    };

    const openStartModal = () => {
      tempSetup.value.playerNames = [...playerNames.value];
      tempSetup.value.rate = rate.value;
      isStartModalOpen.value = true;
    };

    const confirmStartSession = async () => {
      // 前のルームとの接続を切ってから新しい対局を準備する
      stopListening();
      roomId.value = null;
      isHost.value = false;
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
      tableFee.value = createDefaultTableFee();
      gameMultiplier.value = 1;
      isSessionStarted.value = true;
      isStartModalOpen.value = false;

      if (tempSetup.value.connectionType === 'room') {
        try {
          const user = await authReady;
          sessionConfig.value.hostUid = user.uid;
          const newRoomId = await createRoom({
            ...buildRoomState(),
            updatedAt: firebase.database.ServerValue.TIMESTAMP
          });
          isHost.value = true;
          window.history.replaceState(null, '', `?room=${newRoomId}`);
          listenToRoom(newRoomId);
        } catch (err) {
          console.error('ルームの作成に失敗しました', err);
          alert('ルームを作成できませんでした。この端末だけで記録するローカルモードで開始します。');
          sessionConfig.value.hostUid = null;
          saveLocalBackup();
        }
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
        stopListening();
        roomId.value = null;
        isHost.value = false;
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
        updateRoomHistory(() => []);
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
      const mult = Number(gameMultiplier.value) || 1;

      const rawData = activeInput.value.map((p, idx) => ({
        name: playerNames.value[idx],
        rawScore: Number(p.rawScore) || 0
      }));

      const results = calcGameResults(rule, rawData, mult);

      const game = {
        // 同じミリ秒に別端末で記録しても重ならないよう乱数を足す
        id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        title: '',
        mode: sessionConfig.value.gameMode,
        ruleName: appliedRuleName,
        multiplier: mult,
        results: results,
        excluded: false
      };
      history.value = renumberHistory([...history.value, game]);

      gameMultiplier.value = 1;
      resetInputPoints();
      syncStateToFirebase();
      updateRoomHistory(games => {
        const usedIds = new Set(games.map(g => g.id));
        const uniqueGame = { ...game };
        while (usedIds.has(uniqueGame.id)) uniqueGame.id++;
        return [...games, uniqueGame];
      });
    };

    const toggleExclude = (id, exclude) => {
      const setExcluded = games => games.map(g => (g.id === id ? { ...g, excluded: exclude } : g));
      if (history.value.some(g => g.id === id)) {
        history.value = renumberHistory(setExcluded(history.value));
        updateRoomHistory(setExcluded);
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

    const totalMoney = computed(() => pointsToUnits(totalPointsWithBonus.value, rate.value || 0));

    // 場代: 負担額は順位（祝儀込みの最終pt）で決める
    const feeShares = computed(() => calcFeeShares(tableFee.value, totalPointsWithBonus.value));
    const feeTotal = computed(() => feeShares.value.reduce((acc, v) => acc + v, 0));
    const feeAdjustments = computed(() => calcFeeAdjustments(feeShares.value, tableFee.value.payer));
    const finalMoney = computed(() => totalMoney.value.map((m, idx) => m + feeAdjustments.value[idx]));
    const hasTableFee = computed(() => tableFee.value.method !== 'none' && feeTotal.value > 0);

    const settlements = computed(() => calcSettlements(activePlayers.value, finalMoney.value));

    const feeMethodLabel = (method) => FEE_METHODS.find(m => m.value === method)?.label || '';

    const setFeeMethod = (method) => {
      tableFee.value.method = method;
      syncStateToFirebase();
    };

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
          money: finalMoney.value[idx],
          gameMoney: totalMoney.value[idx],
          fee: feeShares.value[idx]
        })),
        tableFee: hasTableFee.value
          ? {
              method: tableFee.value.method,
              total: feeTotal.value,
              payer: activePlayers.value[tableFee.value.payer] || null
            }
          : null,
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
      tableFee,
      feeMethods: FEE_METHODS,
      feeShares,
      feeTotal,
      feeAdjustments,
      finalMoney,
      hasTableFee,
      setFeeMethod,
      feeMethodLabel,
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