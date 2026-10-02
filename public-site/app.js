// 麻雀ポイント数えるくん（公開版）
// 身内版との違い: ポイントのみ表示（換算なし） / ルーム同期は Cloudflare のルームサーバー

const { createApp, ref, computed, onMounted } = Vue;
const { calcGameResults, pointsToUnits, calcFeeShares, calcFeeAdjustments, calcSettlements } = MahjongCalc;
const { createRoom, RoomClient } = RoomSync;

// ポイント移動は 0.1pt 単位の整数で計算する
const UNITS_PER_PT = 10;
const ptToUnits = v => Math.round((Number(v) || 0) * UNITS_PER_PT);
const unitsToPt = u => u / UNITS_PER_PT;

const ADJUST_METHODS = [
  { value: 'none', label: 'なし' },
  { value: 'equal', label: '均等' },
  { value: 'top', label: 'トップのみ' },
  { value: 'tiered', label: '順位で傾斜' },
  { value: 'custom', label: '個別入力' }
];

const createDefaultAdjustment = () => ({
  method: 'none',
  total: 0,
  tiers: [0, 0, 0, 0],
  custom: [0, 0, 0, 0],
  payer: -1
});

const ERROR_MESSAGES = {
  host_only: 'このルームは代表者のみ入力できます。',
  room_closed: 'この対局は終了しています。',
  bad_op: '入力内容を保存できませんでした。値を確認してください。',
  too_large: 'データが大きすぎるため保存できませんでした。'
};

// 回戦タイトルを除外されていない半荘だけで振り直す
const renumberHistory = (games) => {
  let count = 1;
  return games.map(g => (g.excluded ? g : { ...g, title: `第 ${count++} 回戦` }));
};

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
    const connectionStatus = ref('idle');
    let roomClient = null;

    // 対戦設定
    const sessionConfig = ref({
      gameMode: '4p',
      controlMode: 'all',
      status: 'active'
    });

    const tempSetup = ref({
      gameMode: '4p',
      playerNames: ["プレイヤーA", "プレイヤーB", "プレイヤーC", "プレイヤーD"],
      connectionType: 'room',
      controlMode: 'hostOnly'
    });

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

    const playerNames = ref(["プレイヤーA", "プレイヤーB", "プレイヤーC", "プレイヤーD"]);
    const currentInput = ref([
      { rawScore: 25000 },
      { rawScore: 25000 },
      { rawScore: 25000 },
      { rawScore: 25000 }
    ]);
    const bonusPoints = ref([0, 0, 0, 0]);
    // 終了時の PT 調整（サーバー上の項目名は tableFee）
    const adjustment = ref(createDefaultAdjustment());

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
      return sessionConfig.value.controlMode === 'hostOnly' && !isHost.value;
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
    const BACKUP_KEY = "mahjong_public_session_backup";
    const ARCHIVE_KEY = "mahjong_public_archives";

    const saveLocalBackup = () => {
      if (isSessionStarted.value && !isRoomClosed.value) {
        const state = {
          isSessionStarted: isSessionStarted.value,
          sessionConfig: sessionConfig.value,
          currentRule: currentRule.value,
          playerNames: playerNames.value,
          currentInput: currentInput.value,
          bonusPoints: bonusPoints.value,
          tableFee: adjustment.value,
          history: history.value,
          roomId: roomId.value
        };
        localStorage.setItem(BACKUP_KEY, JSON.stringify(state));
      } else {
        localStorage.removeItem(BACKUP_KEY);
      }
    };

    const applyState = (val) => {
      isSessionStarted.value = !!val.isSessionStarted;
      if (val.sessionConfig) {
        sessionConfig.value = val.sessionConfig;
        isRoomClosed.value = (val.sessionConfig.status === 'closed');
      }
      if (val.currentRule) currentRule.value = val.currentRule;
      if (val.playerNames) playerNames.value = val.playerNames;
      if (val.currentInput) currentInput.value = val.currentInput;
      if (val.bonusPoints) bonusPoints.value = val.bonusPoints;
      adjustment.value = { ...createDefaultAdjustment(), ...(val.tableFee || {}) };
      history.value = Array.isArray(val.history) ? val.history : [];
    };

    const resumeCachedSession = () => {
      if (cachedSessionState.value) {
        const val = cachedSessionState.value;
        applyState(val);
        if (val.roomId) connectRoom(val.roomId);
      }
      isResumeModalOpen.value = false;
    };

    const discardCachedSession = () => {
      localStorage.removeItem(BACKUP_KEY);
      cachedSessionState.value = null;
      isResumeModalOpen.value = false;
    };

    // ==========================================
    // ルーム同期
    // ==========================================
    const buildRoomState = () => ({
      isSessionStarted: isSessionStarted.value,
      sessionConfig: sessionConfig.value,
      currentRule: currentRule.value,
      playerNames: playerNames.value,
      currentInput: currentInput.value,
      bonusPoints: bonusPoints.value,
      tableFee: adjustment.value
    });

    const sendOp = (op) => {
      saveLocalBackup();
      if (!roomClient || isReadOnly.value) return;
      roomClient.send(op);
    };

    // 指定した項目だけを送る（他の人が編集中の項目を上書きしない）
    const syncFields = (...keys) => {
      const state = buildRoomState();
      const fields = {};
      keys.forEach(k => { fields[k] = state[k]; });
      sendOp({ t: 'patch', fields });
    };

    const disconnectRoom = () => {
      if (roomClient) roomClient.close();
      roomClient = null;
      connectionStatus.value = 'idle';
    };

    const resetToLobby = () => {
      disconnectRoom();
      roomId.value = null;
      isHost.value = false;
      isSessionStarted.value = false;
      isRoomClosed.value = false;
      localStorage.removeItem(BACKUP_KEY);
      window.history.replaceState(null, '', window.location.pathname);
    };

    const connectRoom = (id) => {
      disconnectRoom();
      roomId.value = id;
      roomClient = new RoomClient({
        roomId: id,
        hostToken: localStorage.getItem(`mahjong_public_host_${id}`),
        onState: (state, hostFlag) => {
          applyState(state);
          isHost.value = hostFlag;
          saveLocalBackup();
        },
        onError: (code) => {
          if (code === 'not_found') {
            alert(`ルーム #${id} が見つかりませんでした。番号を確認してください。`);
            resetToLobby();
            return;
          }
          if (ERROR_MESSAGES[code]) alert(ERROR_MESSAGES[code]);
        },
        onStatus: (status) => {
          connectionStatus.value = status;
        }
      });
      roomClient.connect();
    };

    const openStartModal = () => {
      tempSetup.value.playerNames = [...playerNames.value];
      isStartModalOpen.value = true;
    };

    const confirmStartSession = async () => {
      resetToLobby();

      sessionConfig.value = {
        gameMode: tempSetup.value.gameMode,
        controlMode: tempSetup.value.controlMode,
        status: 'active'
      };
      playerNames.value = [...tempSetup.value.playerNames];

      selectedPresetIndex.value = 0;
      applyPreset();

      history.value = [];
      bonusPoints.value = [0, 0, 0, 0];
      adjustment.value = createDefaultAdjustment();
      gameMultiplier.value = 1;
      isSessionStarted.value = true;
      isStartModalOpen.value = false;

      if (tempSetup.value.connectionType === 'room') {
        try {
          const { roomId: newRoomId, hostToken } = await createRoom(buildRoomState());
          localStorage.setItem(`mahjong_public_host_${newRoomId}`, hostToken);
          isHost.value = true;
          window.history.replaceState(null, '', `?room=${newRoomId}`);
          connectRoom(newRoomId);
        } catch (err) {
          console.error('ルームの作成に失敗しました', err);
          alert('ルームを作成できませんでした。この端末だけで記録するローカルモードで開始します。');
        }
      }
      saveLocalBackup();
    };

    const joinRoomPrompt = () => {
      const code = (prompt("参加する4桁のルーム番号を入力してください:") || '').trim();
      if (!code) return;
      if (!/^\d{4}$/.test(code)) {
        alert('ルーム番号は4桁の数字です。');
        return;
      }
      window.history.replaceState(null, '', `?room=${code}`);
      connectRoom(code);
    };

    const copyRoomUrl = () => {
      const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId.value}`;
      navigator.clipboard.writeText(shareUrl).then(() => {
        alert("招待リンクをコピーしました！友人に共有してください。");
      });
    };

    const leaveRoom = () => {
      if (confirm("ルームから退室しますか？")) {
        resetToLobby();
      }
    };

    const confirmResetSession = () => {
      if (confirm("現在の対局設定をリセットし、最初からやり直しますか？")) {
        isSessionStarted.value = false;
        isRoomClosed.value = false;
        history.value = [];
        localStorage.removeItem(BACKUP_KEY);
        sendOp({ t: 'resetHistory' });
        syncFields('isSessionStarted');
      }
    };

    const adjustScore = (idx, delta) => {
      currentInput.value[idx].rawScore = (currentInput.value[idx].rawScore || 0) + delta;
      syncFields('currentInput');
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
        syncFields('currentRule', 'currentInput');
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
        localStorage.setItem("mahjong_public_presets4p", JSON.stringify(presets4P.value));
      } else {
        presets3P.value.push(newPreset);
        selectedPresetIndex.value = presets3P.value.length - 1;
        localStorage.setItem("mahjong_public_presets3p", JSON.stringify(presets3P.value));
      }
      currentRule.value.name = newPreset.name;
      syncFields('currentRule');
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

      const game = {
        // 同じミリ秒に別端末で記録しても重ならないよう乱数を足す
        id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        title: '',
        mode: sessionConfig.value.gameMode,
        ruleName: appliedRuleName,
        multiplier: mult,
        results: calcGameResults(rule, rawData, mult),
        excluded: false
      };
      history.value = renumberHistory([...history.value, game]);

      gameMultiplier.value = 1;
      resetInputPoints();
      sendOp({ t: 'addGame', game });
      syncFields('currentInput');
    };

    const toggleExclude = (id, exclude) => {
      if (!history.value.some(g => g.id === id)) return;
      history.value = renumberHistory(history.value.map(g => (g.id === id ? { ...g, excluded: exclude } : g)));
      sendOp({ t: 'setExcluded', id, excluded: exclude });
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

    // ==========================================
    // PT 調整 & ポイント移動（0.1pt 単位の整数で計算）
    // ==========================================
    const pointUnits = computed(() => pointsToUnits(totalPointsWithBonus.value, UNITS_PER_PT));

    const adjustmentShares = computed(() => {
      const a = adjustment.value;
      const inUnits = {
        ...a,
        total: ptToUnits(a.total),
        tiers: a.tiers.map(ptToUnits),
        custom: a.custom.map(ptToUnits)
      };
      return calcFeeShares(inUnits, totalPointsWithBonus.value);
    });
    const adjustmentTotal = computed(() => adjustmentShares.value.reduce((acc, v) => acc + v, 0));
    const hasAdjustment = computed(() => adjustment.value.method !== 'none' && adjustmentTotal.value > 0);
    const finalUnits = computed(() => {
      const delta = calcFeeAdjustments(adjustmentShares.value, adjustment.value.payer);
      return pointUnits.value.map((u, idx) => u + delta[idx]);
    });

    const transfers = computed(() => calcSettlements(activePlayers.value, finalUnits.value));

    const formatPt = (units, signed = false) => {
      const pt = unitsToPt(units);
      return `${signed && pt > 0 ? '+' : ''}${pt.toFixed(1)}`;
    };

    const adjustMethodLabel = (method) => ADJUST_METHODS.find(m => m.value === method)?.label || '';

    const setAdjustMethod = (method) => {
      adjustment.value.method = method;
      syncFields('tableFee');
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
        players: activePlayers.value.map((name, idx) => ({
          name,
          point: totalPointsWithBonus.value[idx],
          adjustment: unitsToPt(adjustmentShares.value[idx]),
          final: unitsToPt(finalUnits.value[idx])
        })),
        adjustment: hasAdjustment.value
          ? {
              method: adjustment.value.method,
              total: unitsToPt(adjustmentTotal.value),
              receiver: activePlayers.value[adjustment.value.payer] || null
            }
          : null,
        transfers: transfers.value.map(t => ({ ...t, amount: unitsToPt(t.amount) }))
      };

      sessionArchives.value.unshift(newArchive);
      localStorage.setItem(ARCHIVE_KEY, JSON.stringify(sessionArchives.value));
      localStorage.removeItem(BACKUP_KEY);

      sessionConfig.value = { ...sessionConfig.value, status: 'closed' };
      isSessionStarted.value = false;
      isFinishModalOpen.value = false;
      syncFields('sessionConfig', 'isSessionStarted');
      isRoomClosed.value = true;
    };

    const deleteArchive = (id) => {
      if (confirm("この対戦結果を削除しますか？")) {
        sessionArchives.value = sessionArchives.value.filter(a => a.id !== id);
        localStorage.setItem(ARCHIVE_KEY, JSON.stringify(sessionArchives.value));
      }
    };

    onMounted(() => {
      const loadJson = (key) => {
        try {
          return JSON.parse(localStorage.getItem(key) || 'null');
        } catch {
          return null;
        }
      };
      sessionArchives.value = loadJson(ARCHIVE_KEY) || [];
      presets4P.value = loadJson("mahjong_public_presets4p") || presets4P.value;
      presets3P.value = loadJson("mahjong_public_presets3p") || presets3P.value;

      const roomParam = new URLSearchParams(window.location.search).get('room');
      if (roomParam && /^\d{4}$/.test(roomParam)) {
        connectRoom(roomParam);
        return;
      }

      // 中断データの自動復帰検知
      const backup = loadJson(BACKUP_KEY);
      if (backup?.isSessionStarted) {
        cachedSessionState.value = backup;
        isResumeModalOpen.value = true;
      } else {
        localStorage.removeItem(BACKUP_KEY);
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
      connectionStatus,
      sessionConfig,
      tempSetup,
      gameMultiplier,
      currentPresets,
      selectedPresetIndex,
      currentRule,
      playerNames,
      activePlayers,
      activeInput,
      bonusPoints,
      adjustment,
      adjustMethods: ADJUST_METHODS,
      adjustmentShares,
      adjustmentTotal,
      hasAdjustment,
      finalUnits,
      setAdjustMethod,
      adjustMethodLabel,
      formatPt,
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
      transfers,
      openStartModal,
      confirmStartSession,
      joinRoomPrompt,
      copyRoomUrl,
      leaveRoom,
      confirmResetSession,
      syncFields,
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
