import {
  fetchRemoteState,
  handleGoogleRedirectResult,
  isFirebaseEnabled,
  loginWithEmailPassword,
  loginWithGoogle,
  logoutFirebaseUser,
  persistRemoteState,
  registerWithEmailPassword,
  subscribeToAuthState,
  subscribeToRemoteState,
} from "./firebase-client.js";

const STORAGE_KEY = "zona-sfide-state";
const SESSION_KEY = "zona-sfide-session-user";
const ADMIN_SESSION_KEY = "zona-sfide-admin";
const STARTING_COINS = 20;
const BANK_LOAN_AMOUNT = 10;
const GAME_DURATION_MS = 3 * 60 * 60 * 1000;
const ADMIN_PASSWORD = "admin123";
const DESTINY_CARD_INTERVAL = 5;
const GAME_OWNER_EMAIL = "mrpinkukulele@gmail.com";

const registerView = document.querySelector("#register-view");
const dashboardView = document.querySelector("#dashboard-view");

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      console.error("Impossibile leggere lo stato salvato", error);
    }
  }

  return normalizeState({
    users: [],
    challenges: [],
    bets: [],
  });
}

let state = loadState();
let sessionUserId = sessionStorage.getItem(SESSION_KEY);
let selectedPlayerId = null;
let timerHandle = null;
let adminUnlocked = sessionStorage.getItem(ADMIN_SESSION_KEY) === "true";
let revealedCardBanner = null;
let rulesOpen = false;
let rankingOpen = false;
let remoteUnsubscribe = null;
let authUnsubscribe = null;
let timerVisible = false;

if ("serviceWorker" in navigator && window.location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.error("Service worker non registrato", error);
    });
  });
}

function normalizeState(rawState) {
  return {
    users: (rawState.users || []).map((user) => ({
      ...user,
      bankDebt: Number(user.bankDebt || 0),
      matchesPlayed: Number(user.matchesPlayed || 0),
      nextWinBonus: Number(user.nextWinBonus || 0),
      nextLossPenalty: Number(user.nextLossPenalty || 0),
      destinyCards: (user.destinyCards || []).map((card) => ({
        ...card,
        revealed: Boolean(card.revealed),
      })),
    })),
    challenges: rawState.challenges || [],
    bets: rawState.bets || [],
    game: {
      status: rawState.game?.status || "idle",
      startedAt: rawState.game?.startedAt || null,
      endsAt: rawState.game?.endsAt || null,
      endedAt: rawState.game?.endedAt || null,
    },
    uiMessage: rawState.uiMessage,
  };
}

function serializeState(rawState) {
  return {
    users: rawState.users || [],
    challenges: rawState.challenges || [],
    bets: rawState.bets || [],
    game: rawState.game || {
      status: "idle",
      startedAt: null,
      endsAt: null,
      endedAt: null,
    },
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  persistRemoteState(serializeState(state)).catch((error) => {
    console.error("Impossibile salvare su Firebase", error);
  });
}

function saveSession() {
  if (isFirebaseEnabled()) {
    return;
  }
  if (sessionUserId) {
    sessionStorage.setItem(SESSION_KEY, sessionUserId);
    return;
  }
  sessionStorage.removeItem(SESSION_KEY);
}

function saveAdminSession() {
  if (adminUnlocked) {
    sessionStorage.setItem(ADMIN_SESSION_KEY, "true");
    return;
  }
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
}

function uid(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function applyState(nextState) {
  state = normalizeState(nextState);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function hydrateRemoteState() {
  if (!isFirebaseEnabled()) {
    return;
  }

  try {
    const remoteState = await fetchRemoteState();
    if (!remoteState) {
      await persistRemoteState(serializeState(state));
      return;
    }
    applyState(remoteState);
    render();
  } catch (error) {
    console.error("Impossibile leggere da Firebase", error);
  }
}

async function processAuthRedirect() {
  if (!isFirebaseEnabled()) {
    return;
  }

  try {
    const firebaseUser = await handleGoogleRedirectResult();
    if (!firebaseUser) {
      return;
    }

    sessionUserId = firebaseUser.uid;
    const fallbackName =
      firebaseUser.displayName || firebaseUser.email?.split("@")[0] || "Giocatore";
    ensureUserProfile({
      id: firebaseUser.uid,
      name: fallbackName,
      email: firebaseUser.email || "",
    });
    setMessage("success", `${fallbackName} ha effettuato l'accesso con Google.`);
    saveState();
    render();
  } catch (error) {
    console.error("Redirect Google non riuscito", error);
  }
}

function startRemoteSync() {
  if (!isFirebaseEnabled()) {
    return;
  }

  if (remoteUnsubscribe) {
    remoteUnsubscribe();
  }

  remoteUnsubscribe = subscribeToRemoteState((remoteState) => {
    const currentSerialized = JSON.stringify(serializeState(state));
    const incomingSerialized = JSON.stringify(serializeState(remoteState));
    if (currentSerialized === incomingSerialized) {
      return;
    }

    applyState(remoteState);
    render();
  });
}

function startAuthSync() {
  if (!isFirebaseEnabled()) {
    return;
  }

  if (authUnsubscribe) {
    authUnsubscribe();
  }

  authUnsubscribe = subscribeToAuthState((firebaseUser) => {
    if (!firebaseUser) {
      sessionUserId = null;
      render();
      return;
    }

    sessionUserId = firebaseUser.uid;
    const fallbackName = firebaseUser.displayName || firebaseUser.email?.split("@")[0] || "Giocatore";
    ensureUserProfile({
      id: firebaseUser.uid,
      name: fallbackName,
      email: firebaseUser.email || "",
    });
    saveState();
    render();
  });
}

function getUser(userId) {
  return state.users.find((user) => user.id === userId);
}

function playerHasActiveChallenge(userId) {
  return state.challenges.some(
    (challenge) =>
      challenge.status === "active" &&
      (challenge.challengerId === userId || challenge.receiverId === userId)
  );
}

function reservedCoins(userId) {
  return state.challenges
    .filter((challenge) => challenge.status === "active")
    .reduce((sum, challenge) => {
      if (challenge.challengerId === userId || challenge.receiverId === userId) {
        return sum + challenge.stake;
      }
      return sum;
    }, 0);
}

function availableCoins(userId) {
  const user = getUser(userId);
  if (!user) {
    return 0;
  }
  return user.coins - reservedCoins(userId);
}

function bankDebt(userId) {
  const user = getUser(userId);
  return user ? Number(user.bankDebt || 0) : 0;
}

function pendingDestinyCards(userId) {
  const user = getUser(userId);
  if (!user) {
    return [];
  }
  return (user.destinyCards || []).filter((card) => !card.revealed);
}

function createDestinyCard() {
  const effects = [
    { label: "Gruzzolo segreto", type: "bonus", effect: "coins_bonus", amount: 5 },
    { label: "Comportati da nero", type: "bonus", effect: "coins_bonus", amount: 2 },
    { label: "Vendi su Vinted", type: "bonus", effect: "next_win_bonus", amount: 5 },
    { label: "Associazione a delinquere", type: "bonus", effect: "clear_bank_debt", amount: 0 },
    { label: "Compra dei bey", type: "malus", effect: "coins_malus", amount: 4 },
    { label: "Giro in stazione", type: "malus", effect: "gift_other_player", amount: 2 },
    { label: "La ghigliottina", type: "malus", effect: "halve_coins", amount: 0 },
    { label: "Pessima giornata", type: "malus", effect: "next_loss_penalty", amount: 3 },
  ];
  const effect = effects[Math.floor(Math.random() * effects.length)];
  return {
    id: uid("destiny"),
    title: effect.label,
    type: effect.type,
    amount: effect.amount,
    revealed: false,
    createdAt: new Date().toISOString(),
  };
}

function awardDestinyCardIfNeeded(user) {
  if (user.matchesPlayed % DESTINY_CARD_INTERVAL !== 0) {
    return null;
  }

  const card = createDestinyCard();
  user.destinyCards.push(card);
  return card;
}

function resolveMatchEffects(winner, loser) {
  let summary = [];

  if (winner.nextWinBonus > 0) {
    winner.coins += winner.nextWinBonus;
    summary.push(`${winner.name} guadagna ${winner.nextWinBonus} monete extra dalla banca.`);
    winner.nextWinBonus = 0;
  }

  if (loser.nextLossPenalty > 0) {
    const penalty = loser.nextLossPenalty;
    loser.coins = Math.max(0, loser.coins - penalty);
    summary.push(`${loser.name} perde ${penalty} monete extra.`);
    loser.nextLossPenalty = 0;
  }

  return summary.join(" ");
}

function settleBankDebtIfPossible(user) {
  const debt = Number(user.bankDebt || 0);
  if (debt <= 0) {
    return 0;
  }

  if (availableCoins(user.id) < debt) {
    return 0;
  }

  user.coins -= debt;
  user.bankDebt = 0;
  return debt;
}

function currentUser() {
  return getUser(sessionUserId);
}

function canStartGame(user) {
  return Boolean(user?.email) && user.email.toLowerCase() === GAME_OWNER_EMAIL;
}

function buildNewUserProfile({ id, name, email }) {
  return {
    id,
    name,
    email,
    coins: STARTING_COINS,
    bankDebt: 0,
    matchesPlayed: 0,
    nextWinBonus: 0,
    nextLossPenalty: 0,
    destinyCards: [],
    createdAt: new Date().toISOString(),
  };
}

function ensureUserProfile({ id, name, email }) {
  let user = getUser(id);
  if (user) {
    if (name && user.name !== name) {
      user.name = name;
    }
    if (email && user.email !== email) {
      user.email = email;
    }
    return { user, created: false };
  }

  user = buildNewUserProfile({ id, name, email });
  state.users.push(user);
  return { user, created: true };
}

function isGameActive() {
  return state.game.status === "active";
}

function isGameFinished() {
  return state.game.status === "finished";
}

function ensureGameActive() {
  if (isGameFinished()) {
    setMessage("error", "Il gioco e finito. La classifica e bloccata.");
    render();
    return false;
  }

  if (!isGameActive()) {
    setMessage("error", "Prima devi dichiarare iniziato il gioco.");
    render();
    return false;
  }

  return true;
}

function otherUsers() {
  return state.users.filter((user) => user.id !== sessionUserId);
}

function pendingRequestsForCurrentUser() {
  return state.challenges.filter(
    (challenge) =>
      challenge.status === "pending" && challenge.receiverId === sessionUserId
  );
}

function activeChallengesForCurrentUser() {
  return state.challenges.filter(
    (challenge) =>
      challenge.status === "active" &&
      (challenge.challengerId === sessionUserId ||
        challenge.receiverId === sessionUserId)
  );
}

function openChallengesSentByCurrentUser() {
  return state.challenges.filter(
    (challenge) =>
      challenge.status === "pending" && challenge.challengerId === sessionUserId
  );
}

function fullChallengeLabel(challenge) {
  const challenger = getUser(challenge.challengerId);
  const receiver = getUser(challenge.receiverId);
  return `${challenger?.name ?? "Giocatore"} vs ${receiver?.name ?? "Giocatore"}`;
}

function setMessage(kind, text) {
  state.uiMessage = { kind, text };
}

function clearMessage() {
  delete state.uiMessage;
}

function closeRevealedCardBanner() {
  revealedCardBanner = null;
  render();
}

function openRules() {
  rulesOpen = true;
  render();
}

function closeRules() {
  rulesOpen = false;
  render();
}

function toggleRanking() {
  rankingOpen = !rankingOpen;
  render();
}

function toggleTimerVisibility() {
  timerVisible = !timerVisible;
  render();
}

function unlockAdmin(formData) {
  const password = formData.get("adminPassword").toString();
  if (password !== ADMIN_PASSWORD) {
    setMessage("error", "Password admin non corretta.");
    render();
    return;
  }

  adminUnlocked = true;
  saveAdminSession();
  setMessage("success", "Accesso admin sbloccato.");
  render();
}

function lockAdmin() {
  adminUnlocked = false;
  saveAdminSession();
  setMessage("info", "Accesso admin nascosto.");
  render();
}

function formatRemainingTime() {
  if (!state.game.endsAt || !isGameActive()) {
    return "03:00:00";
  }

  const remainingMs = Math.max(0, new Date(state.game.endsAt).getTime() - Date.now());
  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function leaderboard() {
  return [...state.users]
    .map((user) => ({
      ...user,
      score: user.coins - bankDebt(user.id),
    }))
    .sort((a, b) => b.score - a.score || b.coins - a.coins || a.name.localeCompare(b.name, "it"));
}

function rankingPosition(userId) {
  return leaderboard().findIndex((user) => user.id === userId) + 1;
}

function bettingMultiplierForPosition(position) {
  if (position <= 1) {
    return 0.5;
  }
  if (position === 2) {
    return 1;
  }
  if (position === 3) {
    return 1.5;
  }
  if (position === 4) {
    return 2;
  }
  if (position === 5) {
    return 2.5;
  }
  return 3;
}

function openBetsForCurrentUser() {
  return state.bets.filter((bet) => bet.bettorId === sessionUserId && bet.status === "open");
}

function hasOpenBetOnPlayer(bettorId, targetUserId) {
  return state.bets.some(
    (bet) =>
      bet.status === "open" &&
      bet.bettorId === bettorId &&
      bet.targetUserId === targetUserId
  );
}

function startGame() {
  if (isGameActive()) {
    setMessage("error", "Il gioco e gia iniziato.");
    render();
    return;
  }

  if (isGameFinished()) {
    setMessage("error", "Il gioco e gia finito. Azzera i dati per ripartire.");
    render();
    return;
  }

  if (state.users.length < 2) {
    setMessage("error", "Servono almeno due giocatori per iniziare.");
    render();
    return;
  }

  const startedAt = new Date();
  state.game.status = "active";
  state.game.startedAt = startedAt.toISOString();
  state.game.endsAt = new Date(startedAt.getTime() + GAME_DURATION_MS).toISOString();
  state.game.endedAt = null;
  setMessage("success", "Gioco iniziato. Il timer da 3 ore e partito.");
  saveState();
  render();
}

function finishGame(source = "manual") {
  if (isGameFinished()) {
    setMessage("info", "Il gioco e gia finito.");
    render();
    return;
  }

  if (!isGameActive() && source !== "force") {
    setMessage("error", "Il gioco non e ancora iniziato.");
    render();
    return;
  }

  state.game.status = "finished";
  state.game.endedAt = new Date().toISOString();
  if (!state.game.endsAt) {
    state.game.endsAt = state.game.endedAt;
  }
  setMessage(
    "success",
    source === "timer"
      ? "Tempo scaduto. Classifica finale calcolata."
      : "Gioco dichiarato finito. Classifica finale calcolata."
  );
  saveState();
  render();
}

function syncGameTimer() {
  if (isGameActive() && state.game.endsAt) {
    const endsAtMs = new Date(state.game.endsAt).getTime();
    if (Date.now() >= endsAtMs) {
      finishGame("timer");
      return;
    }

    const timerNode = document.querySelector('[data-role="game-timer"]');
    if (timerNode) {
      timerNode.textContent = `Timer ${formatRemainingTime()}`;
    }
  }
}

function toggleSelectedPlayer(userId) {
  selectedPlayerId = selectedPlayerId === userId ? null : userId;
  render();
}

async function registerUser(formData) {
  const name = formData.get("name").toString().trim();
  const email = formData.get("email").toString().trim().toLowerCase();
  const password = formData.get("password").toString();
  if (!name) {
    setMessage("error", "Inserisci un nome utente.");
    render();
    return;
  }

  if (!email || !password) {
    setMessage("error", "Inserisci email e password.");
    render();
    return;
  }

  if (isFirebaseEnabled()) {
    try {
      const firebaseUser = await registerWithEmailPassword({ name, email, password });
      sessionUserId = firebaseUser.uid;
      const profile = ensureUserProfile({
        id: firebaseUser.uid,
        name,
        email: firebaseUser.email || email,
      });
      setMessage(
        "success",
        profile.created
          ? `${name} registrato con 20 monete di gioco.`
          : `${name} ha completato l'accesso.`
      );
      saveState();
      render();
    } catch (error) {
      setMessage("error", "Registrazione non riuscita. Controlla email, password e Firebase Auth.");
      render();
    }
    return;
  }

  const existingUser = state.users.find(
    (user) => user.name.toLowerCase() === name.toLowerCase()
  );

  if (existingUser) {
    sessionUserId = existingUser.id;
    saveSession();
    setMessage("success", `${existingUser.name} ha effettuato l'accesso.`);
    saveState();
    render();
    return;
  }

  const user = buildNewUserProfile({ id: uid("user"), name, email });
  state.users.push(user);
  sessionUserId = user.id;
  saveSession();
  setMessage("success", `${name} registrato con 20 monete di gioco.`);
  saveState();
  render();
}

async function loginUser(formData) {
  const email = formData.get("loginEmail").toString().trim().toLowerCase();
  const password = formData.get("loginPassword").toString();

  if (!email || !password) {
    setMessage("error", "Inserisci email e password per entrare.");
    render();
    return;
  }

  if (isFirebaseEnabled()) {
    try {
      const firebaseUser = await loginWithEmailPassword({ email, password });
      sessionUserId = firebaseUser.uid;
      const fallbackName = firebaseUser.displayName || email.split("@")[0];
      const profile = ensureUserProfile({
        id: firebaseUser.uid,
        name: fallbackName,
        email: firebaseUser.email || email,
      });
      setMessage("success", `${profile.user.name} ha effettuato l'accesso.`);
      saveState();
      render();
    } catch (error) {
      setMessage("error", "Login non riuscito. Controlla email e password.");
      render();
    }
    return;
  }

  const localUser = state.users.find((user) => user.email === email);
  if (!localUser) {
    setMessage("error", "Utente non trovato.");
    render();
    return;
  }

  sessionUserId = localUser.id;
  saveSession();
  setMessage("success", `${localUser.name} ha effettuato l'accesso.`);
  render();
}

async function loginWithGoogleAction() {
  if (!isFirebaseEnabled()) {
    setMessage("error", "Accesso Google disponibile solo con Firebase attivo.");
    render();
    return;
  }

  try {
    const firebaseUser = await loginWithGoogle();
    if (!firebaseUser) {
      return;
    }

    sessionUserId = firebaseUser.uid;
    const fallbackName =
      firebaseUser.displayName || firebaseUser.email?.split("@")[0] || "Giocatore";
    ensureUserProfile({
      id: firebaseUser.uid,
      name: fallbackName,
      email: firebaseUser.email || "",
    });
    setMessage("success", `${fallbackName} ha effettuato l'accesso con Google.`);
    saveState();
    render();
  } catch (error) {
    setMessage("error", "Accesso con Google non riuscito.");
    render();
  }
}

async function logout() {
  if (isFirebaseEnabled()) {
    await logoutFirebaseUser();
  }
  sessionUserId = null;
  saveSession();
  setMessage("info", "Sessione chiusa. Puoi entrare con un altro giocatore.");
  saveState();
  render();
}

function createChallenge(receiverId) {
  if (!ensureGameActive()) {
    return;
  }

  const challenger = currentUser();
  const receiver = getUser(receiverId);

  if (!challenger || !receiver) {
    setMessage("error", "Giocatore non trovato.");
    render();
    return;
  }

  if (hasOpenBetOnPlayer(challenger.id, receiver.id)) {
    setMessage("error", `Non puoi sfidare ${receiver.name} finche hai una scommessa aperta su di lui.`);
    render();
    return;
  }

  const duplicatePending = state.challenges.some(
    (challenge) =>
      challenge.status === "pending" &&
      ((challenge.challengerId === challenger.id && challenge.receiverId === receiverId) ||
        (challenge.challengerId === receiverId && challenge.receiverId === challenger.id))
  );

  if (duplicatePending) {
    setMessage("error", "Esiste gia una richiesta di sfida aperta tra questi due giocatori.");
    render();
    return;
  }

  state.challenges.unshift({
    id: uid("challenge"),
    challengerId: challenger.id,
    receiverId,
    status: "pending",
    stake: 0,
    createdAt: new Date().toISOString(),
  });

  setMessage("success", `Sfida inviata a ${receiver.name}.`);
  saveState();
  render();
}

function placeBet(targetUserId, formData) {
  if (!ensureGameActive()) {
    return;
  }

  const bettor = currentUser();
  const target = getUser(targetUserId);
  const amount = Number.parseInt(formData.get("betAmount"), 10);

  if (!bettor || !target) {
    setMessage("error", "Giocatore non trovato.");
    render();
    return;
  }

  if (bettor.id === target.id) {
    setMessage("error", "Non puoi scommettere su te stesso.");
    render();
    return;
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    setMessage("error", "Inserisci una puntata valida.");
    render();
    return;
  }

  if (playerHasActiveChallenge(target.id)) {
    setMessage("error", "Puoi scommettere solo su un giocatore che non e in una sfida in corso.");
    render();
    return;
  }

  if (availableCoins(bettor.id) < amount) {
    setMessage("error", "Non hai abbastanza monete disponibili per scommettere.");
    render();
    return;
  }

  bettor.coins -= amount;
  state.bets.unshift({
    id: uid("bet"),
    bettorId: bettor.id,
    targetUserId: target.id,
    amount,
    status: "open",
    createdAt: new Date().toISOString(),
  });

  setMessage("success", `Hai scommesso ${amount} monete su ${target.name}.`);
  saveState();
  render();
}

function takeBankLoan() {
  if (!ensureGameActive()) {
    return;
  }

  const user = currentUser();
  if (!user) {
    return;
  }

  if (bankDebt(user.id) > 0) {
    setMessage("error", "Hai gia un prestito aperto con la banca.");
    render();
    return;
  }

  user.coins += BANK_LOAN_AMOUNT;
  user.bankDebt = BANK_LOAN_AMOUNT;
  setMessage("success", `Hai ricevuto ${BANK_LOAN_AMOUNT} monete dalla banca.`);
  saveState();
  render();
}

function repayBankLoan() {
  if (!ensureGameActive()) {
    return;
  }

  const user = currentUser();
  if (!user) {
    return;
  }

  const debt = bankDebt(user.id);
  if (debt <= 0) {
    setMessage("error", "Non hai debiti con la banca.");
    render();
    return;
  }

  if (availableCoins(user.id) < debt) {
    setMessage("error", "Non hai abbastanza monete libere per restituire il prestito.");
    render();
    return;
  }

  user.coins -= debt;
  user.bankDebt = 0;
  setMessage("success", `Hai restituito ${debt} monete alla banca.`);
  saveState();
  render();
}

function acceptChallenge(challengeId, formData) {
  if (!ensureGameActive()) {
    return;
  }

  const challenge = state.challenges.find((item) => item.id === challengeId);
  if (!challenge || challenge.status !== "pending") {
    setMessage("error", "Richiesta non disponibile.");
    render();
    return;
  }

  const stake = Number.parseInt(formData.get("stake"), 10);
  const challenger = getUser(challenge.challengerId);
  const receiver = getUser(challenge.receiverId);

  if (!Number.isInteger(stake) || stake <= 0) {
    setMessage("error", "Inserisci un numero valido di monete.");
    render();
    return;
  }

  const challengerAvailable = availableCoins(challenger.id);
  const receiverAvailable = availableCoins(receiver.id);

  if (stake > challengerAvailable || stake > receiverAvailable) {
    setMessage(
      "error",
      `Puntata troppo alta. Disponibili: ${challenger.name} ${challengerAvailable}, ${receiver.name} ${receiverAvailable}.`
    );
    render();
    return;
  }

  challenge.status = "active";
  challenge.stake = stake;
  challenge.acceptedAt = new Date().toISOString();
  setMessage("success", `Sfida accettata: in palio ${stake} monete.`);
  saveState();
  render();
}

function allInChallenge(challengeId) {
  if (!ensureGameActive()) {
    return;
  }

  const challenge = state.challenges.find((item) => item.id === challengeId);
  if (!challenge || challenge.status !== "pending") {
    setMessage("error", "Richiesta non disponibile.");
    render();
    return;
  }

  if (challenge.receiverId !== sessionUserId) {
    setMessage("error", "Solo chi riceve la sfida puo andare all in.");
    render();
    return;
  }

  const challenger = getUser(challenge.challengerId);
  const receiver = getUser(challenge.receiverId);
  const stake = Math.min(
    availableCoins(challenger.id),
    availableCoins(receiver.id)
  );

  if (stake <= 0) {
    setMessage("error", "Nessuno dei due ha monete disponibili per andare all in.");
    render();
    return;
  }

  challenge.status = "active";
  challenge.stake = stake;
  challenge.acceptedAt = new Date().toISOString();
  challenge.isAllIn = true;
  setMessage("success", `All in accettato: in palio ${stake} monete.`);
  saveState();
  render();
}

function declineChallenge(challengeId) {
  if (!ensureGameActive()) {
    return;
  }

  const challenge = state.challenges.find((item) => item.id === challengeId);
  if (!challenge || challenge.status !== "pending") {
    return;
  }

  challenge.status = "declined";
  challenge.closedAt = new Date().toISOString();
  setMessage("info", "Sfida rifiutata.");
  saveState();
  render();
}

function giftCoins(receiverId, formData) {
  if (!ensureGameActive()) {
    return;
  }

  const sender = currentUser();
  const receiver = getUser(receiverId);
  const amount = Number.parseInt(formData.get("amount"), 10);

  if (!sender || !receiver) {
    setMessage("error", "Giocatore non trovato.");
    render();
    return;
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    setMessage("error", "Inserisci un numero valido di monete da regalare.");
    render();
    return;
  }

  if (availableCoins(sender.id) < amount) {
    setMessage("error", "Non hai abbastanza monete disponibili da regalare.");
    render();
    return;
  }

  sender.coins -= amount;
  receiver.coins += amount;
  setMessage("success", `Hai regalato ${amount} monete a ${receiver.name}.`);
  saveState();
  render();
}

function revealDestinyCard(cardId) {
  const user = currentUser();
  if (!user) {
    return;
  }

  const card = (user.destinyCards || []).find((item) => item.id === cardId);
  if (!card || card.revealed) {
    setMessage("error", "Carta del destino non disponibile.");
    render();
    return;
  }

  card.revealed = true;
  card.revealedAt = new Date().toISOString();
  let message = `Carta del destino: ${card.title}.`;
  let effectDescription = "";

  switch (card.effect) {
    case "coins_bonus":
      user.coins += card.amount;
      message = `${message} Hai guadagnato ${card.amount} monete.`;
      effectDescription = `Bonus immediato di ${card.amount} monete.`;
      break;
    case "next_win_bonus":
      user.nextWinBonus += card.amount;
      message = `${message} Alla prossima vittoria guadagni ${card.amount} monete extra dalla banca.`;
      effectDescription = `Alla tua prossima vittoria guadagni ${card.amount} monete extra dalla banca.`;
      break;
    case "clear_bank_debt":
      if (bankDebt(user.id) > 0) {
        user.bankDebt = 0;
        message = `${message} Il tuo debito con la banca e stato cancellato.`;
        effectDescription = "Il tuo debito con la banca viene cancellato senza restituire monete.";
      } else {
        message = `${message} Nessun debito da cancellare.`;
        effectDescription = "La carta cancella il debito con la banca, ma al momento non avevi debiti.";
      }
      break;
    case "coins_malus":
      user.coins = Math.max(0, user.coins - card.amount);
      message = `${message} Hai perso ${card.amount} monete.`;
      effectDescription = `Malus immediato di ${card.amount} monete.`;
      break;
    case "halve_coins":
      user.coins = Math.floor(user.coins / 2);
      message = `${message} Le tue monete sono state dimezzate.`;
      effectDescription = "Le tue monete vengono dimezzate subito.";
      break;
    case "next_loss_penalty":
      user.nextLossPenalty += card.amount;
      message = `${message} Alla prossima sconfitta perdi ${card.amount} monete extra.`;
      effectDescription = `Alla tua prossima sconfitta perdi ${card.amount} monete extra.`;
      break;
    case "gift_other_player":
      message = `${message} Devi regalare ${card.amount} monete a un altro giocatore dalla lobby.`;
      card.pendingGift = true;
      effectDescription = `Devi regalare ${card.amount} monete a un altro giocatore.`;
      break;
    default:
      break;
  }

  revealedCardBanner = {
    title: card.title,
    type: card.type,
    description: effectDescription || message,
  };
  setMessage(card.type === "bonus" ? "success" : "info", message);

  saveState();
  render();
}

function useGiftPenalty(cardId, receiverId) {
  const sender = currentUser();
  const receiver = getUser(receiverId);
  const card = (sender?.destinyCards || []).find((item) => item.id === cardId);

  if (!sender || !receiver || !card || !card.pendingGift) {
    setMessage("error", "Carta malus non disponibile.");
    render();
    return;
  }

  if (availableCoins(sender.id) < card.amount) {
    setMessage("error", "Non hai abbastanza monete disponibili per eseguire questo malus.");
    render();
    return;
  }

  sender.coins -= card.amount;
  receiver.coins += card.amount;
  card.pendingGift = false;
  setMessage("info", `Hai regalato ${card.amount} monete a ${receiver.name} per effetto di ${card.title}.`);
  saveState();
  render();
}

function resolveBetsForChallenge(winner, loser) {
  const summary = [];
  const relevantBets = state.bets.filter(
    (bet) =>
      bet.status === "open" &&
      (bet.targetUserId === winner.id || bet.targetUserId === loser.id)
  );

  if (!relevantBets.length) {
    return "";
  }

  const winnerPosition = rankingPosition(winner.id);
  const multiplier = bettingMultiplierForPosition(winnerPosition);

  relevantBets.forEach((bet) => {
    const bettor = getUser(bet.bettorId);
    if (!bettor) {
      bet.status = "void";
      return;
    }

    if (bet.targetUserId === winner.id) {
      const bankPrize = Math.floor(bet.amount * multiplier);
      bettor.coins += bet.amount + bankPrize;
      bet.status = "won";
      bet.resolvedAt = new Date().toISOString();
      bet.resultAmount = bankPrize;
      summary.push(
        `${bettor.name} vince la scommessa su ${winner.name} e incassa ${bankPrize} monete dalla banca.`
      );
      return;
    }

    bet.status = "lost";
    bet.resolvedAt = new Date().toISOString();
    bet.resultAmount = 0;
    summary.push(`${bettor.name} perde la scommessa su ${loser.name}.`);
  });

  return summary.join(" ");
}

function settleChallenge(challengeId, winnerId) {
  if (!ensureGameActive()) {
    return;
  }

  const challenge = state.challenges.find((item) => item.id === challengeId);
  if (!challenge || challenge.status !== "active") {
    return;
  }

  const challenger = getUser(challenge.challengerId);
  const receiver = getUser(challenge.receiverId);
  const loserId =
    winnerId === challenge.challengerId ? challenge.receiverId : challenge.challengerId;
  const winner = getUser(winnerId);
  const loser = getUser(loserId);

  if (!winner || !loser || !challenger || !receiver) {
    setMessage("error", "Giocatori non disponibili.");
    render();
    return;
  }

  if (loser.coins < challenge.stake) {
    setMessage(
      "error",
      `La sfida non puo essere chiusa: ${loser.name} non ha abbastanza monete.`
    );
    render();
    return;
  }

  loser.coins -= challenge.stake;
  winner.coins += challenge.stake;
  const matchEffectsSummary = resolveMatchEffects(winner, loser);
  challenge.status = "completed";
  challenge.winnerId = winnerId;
  challenge.closedAt = new Date().toISOString();
  winner.matchesPlayed += 1;
  loser.matchesPlayed += 1;

  const betsSummary = resolveBetsForChallenge(winner, loser);
  const repaidWinner = settleBankDebtIfPossible(winner);
  const repaidLoser = settleBankDebtIfPossible(loser);
  const winnerCard = awardDestinyCardIfNeeded(winner);
  const loserCard = awardDestinyCardIfNeeded(loser);
  const repaymentSummary = [repaidWinner ? `${winner.name} ha restituito ${repaidWinner} alla banca.` : null, repaidLoser ? `${loser.name} ha restituito ${repaidLoser} alla banca.` : null]
    .filter(Boolean)
    .join(" ");
  const destinySummary = [
    winnerCard ? `${winner.name} ha ottenuto una Carta del destino.` : null,
    loserCard ? `${loser.name} ha ottenuto una Carta del destino.` : null,
  ]
    .filter(Boolean)
    .join(" ");

  setMessage(
    "success",
    `${winner.name} ha vinto ${challenge.stake} monete contro ${loser.name}.${matchEffectsSummary ? ` ${matchEffectsSummary}` : ""}${betsSummary ? ` ${betsSummary}` : ""}${repaymentSummary ? ` ${repaymentSummary}` : ""}${destinySummary ? ` ${destinySummary}` : ""}`
  );
  saveState();
  render();
}

function resetAll() {
  localStorage.removeItem(STORAGE_KEY);
  state = loadState();
  setMessage("info", "Dati azzerati.");
  saveState();
  render();
}

function renderRegister() {
  const users = [...state.users].sort((a, b) => a.name.localeCompare(b.name, "it"));
  registerView.innerHTML = `
    <div class="section-head">
      <div>
        <span class="badge">Ingresso Giocatore</span>
        <h2>Registrazione</h2>
      </div>
    </div>
    <p class="muted">
      Ogni nuovo giocatore parte con ${STARTING_COINS} monete. Registrazione con nome, email e password. Login solo con email e password.
    </p>
    <div class="auth-grid">
      <form id="register-form">
        <div>
          <label for="name">Nome giocatore</label>
          <input id="name" name="name" maxlength="24" placeholder="Es. Marco" required />
        </div>
        <div>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" placeholder="nome@email.com" required />
        </div>
        <div>
          <label for="password">Password</label>
          <input id="password" name="password" type="password" minlength="6" placeholder="Almeno 6 caratteri" required />
        </div>
        <button class="primary" type="submit">Registrati</button>
      </form>

      <form id="login-form">
        <div>
          <label for="login-email">Email</label>
          <input id="login-email" name="loginEmail" type="email" placeholder="nome@email.com" required />
        </div>
        <div>
          <label for="login-password">Password</label>
          <input id="login-password" name="loginPassword" type="password" minlength="6" placeholder="Password" required />
        </div>
        <button class="secondary" type="submit">Login</button>
        <button class="ghost" type="button" id="google-login-button">Accedi con Google</button>
      </form>
    </div>
    ${
      users.length
        ? `
      <div class="stack">
        <p class="tiny">Giocatori gia registrati</p>
        ${users
          .map(
            (user) => `
            <div class="player-card">
              <div class="player-head">
                <strong>${user.name}</strong>
                <span class="badge">${user.coins} monete</span>
              </div>
            </div>
          `
          )
          .join("")}
      </div>
    `
        : `<p class="empty">Nessun giocatore registrato.</p>`
    }
    ${
      state.uiMessage
        ? `<div class="message ${state.uiMessage.kind}">${state.uiMessage.text}</div>`
        : ""
    }
  `;

  registerView.querySelector("#register-form").addEventListener("submit", (event) => {
    event.preventDefault();
    clearMessage();
    registerUser(new FormData(event.currentTarget));
  });

  registerView.querySelector("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    clearMessage();
    loginUser(new FormData(event.currentTarget));
  });

  registerView.querySelector("#google-login-button").addEventListener("click", () => {
    clearMessage();
    loginWithGoogleAction();
  });

}

function renderDashboard() {
  const user = currentUser();
  const others = otherUsers();
  const pending = pendingRequestsForCurrentUser();
  const active = activeChallengesForCurrentUser();
  const sent = openChallengesSentByCurrentUser();
  const ranking = leaderboard();
  const cards = pendingDestinyCards(user.id);
  const bets = openBetsForCurrentUser();
  const liveRanking = ranking
    .map((player, index) => ({
      ...player,
      rank: index + 1,
      quote: bettingMultiplierForPosition(index + 1),
    }));

  dashboardView.innerHTML = `
    <section class="dashboard-header">
      <div class="welcome">
        <span class="badge success">Giocatore attivo</span>
        <h2>${user.name}</h2>
        <p class="muted">Lancia sfide, accetta richieste e chiudi le partite assegnando il vincitore.</p>
      </div>
      <div class="actions">
        <button class="secondary" data-action="open-rules">Regole</button>
        <button class="secondary" data-action="toggle-timer">
          ${timerVisible ? "Nascondi timer" : "Mostra timer"}
        </button>
        <button class="secondary" data-action="logout">Cambia giocatore</button>
      </div>
    </section>

    ${
      isGameFinished()
        ? `
        <section class="dashboard-section">
          <div class="section-head">
            <div>
              <span class="badge success">Finale</span>
              <h3>Classifica</h3>
            </div>
          </div>
          <div class="stack">
            ${ranking
              .map(
                (player, index) => `
                  <article class="player-card">
                    <div class="player-head">
                      <strong>#${index + 1} ${player.name}</strong>
                      <span class="badge">${player.score} punti</span>
                    </div>
                    <p class="muted">Monete: ${player.coins} | Debito banca: ${player.bankDebt}</p>
                  </article>
                `
              )
              .join("")}
          </div>
        </section>
      `
        : ""
    }

    <section class="dashboard-section">
      <div class="stats-grid">
        <div class="stat-card">
          <span>Saldo totale</span>
          <strong>${user.coins}</strong>
        </div>
        <div class="stat-card">
          <span>Disponibili</span>
          <strong>${availableCoins(user.id)}</strong>
        </div>
        <div class="stat-card">
          <span>Bloccate</span>
          <strong>${reservedCoins(user.id)}</strong>
        </div>
        <div class="stat-card">
          <span>Debito banca</span>
          <strong>${bankDebt(user.id)}</strong>
        </div>
        <div class="stat-card">
          <span>Partite fatte</span>
          <strong>${user.matchesPlayed}</strong>
        </div>
        <div class="stat-card">
          <span>Carte destino</span>
          <strong>${cards.length}</strong>
        </div>
      </div>
    </section>

    <section class="dashboard-section">
      <div class="section-head">
        <div>
          <span class="badge">Live</span>
          <h3>Classifica e quote</h3>
        </div>
        <button class="secondary" data-action="toggle-ranking">
          ${rankingOpen ? "Nascondi classifica" : "Mostra classifica"}
        </button>
      </div>
      ${
        rankingOpen
          ? `
            <div class="challenge-grid">
              ${liveRanking
                .map(
                  (player) => `
                    <article class="challenge-card">
                      <div class="challenge-head">
                        <strong>#${player.rank} ${player.name}</strong>
                        <span class="badge">Quota x${player.quote}</span>
                      </div>
                      <p class="muted">Punti: ${player.score}</p>
                      <p class="tiny">Monete ${player.coins} | Debito ${player.bankDebt}</p>
                    </article>
                  `
                )
                .join("")}
            </div>
          `
          : `<p class="empty">Classifica nascosta. Premi "Mostra classifica" per vedere posizioni e quote live.</p>`
      }
    </section>

    <section class="dashboard-section">
      <div class="section-head">
        <div>
          <span class="badge">Scommesse</span>
          <h3>Scommesse aperte</h3>
        </div>
      </div>
      ${
        bets.length
          ? `<div class="challenge-grid">
              ${bets
                .map((bet) => {
                  const target = getUser(bet.targetUserId);
                  const position = rankingPosition(bet.targetUserId);
                  const multiplier = bettingMultiplierForPosition(position);
                  return `
                    <article class="challenge-card">
                      <div class="challenge-head">
                        <strong>#${position} ${target?.name ?? "Giocatore"}</strong>
                        <span class="badge">x${multiplier} banca</span>
                      </div>
                      <p class="muted">Hai puntato ${bet.amount} monete sulla sua prossima vittoria.</p>
                      <p class="tiny">Posizione attuale in classifica: ${position}</p>
                    </article>
                  `;
                })
                .join("")}
            </div>`
          : `<p class="empty">Nessuna scommessa aperta.</p>`
      }
    </section>

    <section class="dashboard-section">
      <div class="section-head">
        <div>
          <span class="badge">Destino</span>
          <h3>Carte del destino</h3>
        </div>
      </div>
      ${
        cards.length
          ? `<div class="challenge-grid">
              ${cards
                .map(
                  (card) => `
                    <article class="challenge-card">
                      <div class="challenge-head">
                        <strong>Carta del destino</strong>
                        <span class="badge">Coperta</span>
                      </div>
                      <p class="muted">Il contenuto resta nascosto finche non decidi di scoprirla.</p>
                      ${
                        card.pendingGift
                          ? `
                            <p class="muted">Devi regalare ${card.amount} monete a un altro giocatore.</p>
                            <div class="actions">
                              ${others
                                .map(
                                  (other) => `
                                    <button class="secondary" data-action="gift-penalty" data-card-id="${card.id}" data-user-id="${other.id}">
                                      Dai a ${other.name}
                                    </button>
                                  `
                                )
                                .join("")}
                            </div>
                          `
                          : `
                            <p class="muted">Hai sbloccato una carta dopo ${DESTINY_CARD_INTERVAL} partite.</p>
                            <div class="actions">
                              <button class="primary" data-action="reveal-card" data-card-id="${card.id}">
                                Scopri carta
                              </button>
                            </div>
                          `
                      }
                    </article>
                  `
                )
                .join("")}
            </div>`
          : `<p class="empty">Ogni ${DESTINY_CARD_INTERVAL} partite completate ricevi una carta del destino.</p>`
      }
    </section>

    <section class="dashboard-section">
      <div class="section-head">
        <div>
          <span class="badge">Banca</span>
          <h3>Prestito e restituzione</h3>
        </div>
      </div>
      <div class="actions">
        <button class="primary" data-action="bank-loan" ${bankDebt(user.id) > 0 ? "disabled" : ""}>
          Chiedi 10 monete
        </button>
        <button class="secondary" data-action="bank-repay" ${bankDebt(user.id) === 0 ? "disabled" : ""}>
          Restituisci alla banca
        </button>
      </div>
      <p class="muted">
        Il prestito banca ti da ${BANK_LOAN_AMOUNT} monete. Finche hai debito aperto non puoi chiederne un altro.
      </p>
    </section>

    <section class="dashboard-section">
      <div class="section-head">
        <div>
          <span class="badge">Lobby</span>
          <h3>Altri giocatori</h3>
        </div>
        ${
          canStartGame(user) && !isGameActive() && !isGameFinished()
            ? `
              <div class="admin-mini inline-admin">
                <button class="primary" data-action="start-game">
                  Inizia partita
                </button>
              </div>
            `
            : ""
        }
      </div>
      ${
        others.length
          ? `<div class="players-grid">
            ${others
              .map(
                (other) => `
                  <article class="player-card">
                    <div class="player-head">
                      <strong>${other.name}</strong>
                      <span class="badge">Quota x${bettingMultiplierForPosition(rankingPosition(other.id))}</span>
                    </div>
                    <p class="muted">Posizione #${rankingPosition(other.id)} | Saldo totale: ${other.coins} monete</p>
                    <button class="ghost" data-action="toggle-player" data-user-id="${other.id}">
                      ${selectedPlayerId === other.id ? "Chiudi azioni" : "Apri azioni"}
                    </button>
                    ${
                      selectedPlayerId === other.id
                        ? `
                        <div class="player-actions">
                          <div class="actions">
                            <button class="primary" data-action="challenge" data-user-id="${other.id}" ${hasOpenBetOnPlayer(user.id, other.id) ? "disabled" : ""}>
                              Lancia sfida
                            </button>
                          </div>
                          ${
                            hasOpenBetOnPlayer(user.id, other.id)
                              ? `<p class="muted">Non puoi sfidare questo giocatore finche hai una scommessa aperta su di lui.</p>`
                              : ""
                          }
                          <form data-action="gift" data-user-id="${other.id}">
                            <div>
                              <label>Regala monete</label>
                              <input name="amount" type="number" min="1" max="${Math.max(availableCoins(user.id), 1)}" required />
                            </div>
                            <button class="secondary" type="submit">Regala</button>
                          </form>
                          ${
                            playerHasActiveChallenge(other.id)
                              ? `<p class="muted">Scommessa non disponibile: ${other.name} e gia in una sfida in corso.</p>`
                              : `
                                  <form data-action="bet" data-user-id="${other.id}">
                                    <div>
                                      <label>Scommetti su ${other.name}</label>
                                      <input name="betAmount" type="number" min="1" max="${Math.max(availableCoins(user.id), 1)}" required />
                                    </div>
                                    <button class="secondary" type="submit">Punta monete</button>
                                  </form>
                                `
                          }
                        </div>
                      `
                        : ""
                    }
                  </article>
                `
              )
              .join("")}
          </div>`
          : `<p class="empty">Registra un secondo giocatore per vedere la lobby e iniziare le sfide.</p>`
      }
    </section>

    <section class="dashboard-section">
      <div class="section-head">
        <div>
          <span class="badge">Richieste</span>
          <h3>Sfide ricevute</h3>
        </div>
      </div>
      ${
        pending.length
          ? `<div class="challenge-grid">
            ${pending
              .map((challenge) => {
                const challenger = getUser(challenge.challengerId);
                const maxStake = Math.min(
                  availableCoins(challenge.challengerId),
                  availableCoins(challenge.receiverId)
                );
                return `
                  <article class="challenge-card">
                    <div class="challenge-head">
                      <strong>${challenger.name}</strong>
                      <span class="badge">In attesa</span>
                    </div>
                    <p class="muted">
                      Se accetti sei tu a decidere quante monete mettere in gioco.
                    </p>
                    <p class="tiny">Massimo disponibile adesso: ${maxStake}</p>
                    <form data-action="accept-challenge" data-challenge-id="${challenge.id}">
                      <div>
                        <label>Puntata in monete</label>
                        <input name="stake" type="number" min="1" max="${Math.max(maxStake, 1)}" required />
                      </div>
                      <div class="actions">
                        <button class="success" type="submit">Accetta</button>
                        <button class="secondary" type="button" data-action="all-in" data-challenge-id="${challenge.id}" ${maxStake <= 0 ? "disabled" : ""}>
                          Vai all in
                        </button>
                        <button class="danger" type="button" data-action="decline" data-challenge-id="${challenge.id}">
                          Rifiuta
                        </button>
                      </div>
                    </form>
                  </article>
                `;
              })
              .join("")}
          </div>`
          : `<p class="empty">Nessuna richiesta di sfida ricevuta.</p>`
      }
    </section>

    <section class="dashboard-section">
      <div class="section-head">
        <div>
          <span class="badge">Sfide In Corso</span>
          <h3>Partite attive</h3>
        </div>
      </div>
      ${
        active.length
          ? `<div class="challenge-grid">
            ${active
              .map((challenge) => {
                const challenger = getUser(challenge.challengerId);
                const receiver = getUser(challenge.receiverId);
                return `
                  <article class="challenge-card">
                    <div class="challenge-head">
                      <strong>${fullChallengeLabel(challenge)}</strong>
                      <span class="badge success">${challenge.stake} monete${challenge.isAllIn ? " all in" : ""}</span>
                    </div>
                    <p class="muted">
                      Ogni giocatore ha questa quota bloccata finche la sfida non viene chiusa.
                    </p>
                    <div class="actions">
                      <button class="primary" data-action="settle" data-challenge-id="${challenge.id}" data-winner-id="${challenger.id}">
                        Vince ${challenger.name}
                      </button>
                      <button class="primary" data-action="settle" data-challenge-id="${challenge.id}" data-winner-id="${receiver.id}">
                        Vince ${receiver.name}
                      </button>
                    </div>
                  </article>
                `;
              })
              .join("")}
          </div>`
          : `<p class="empty">Nessuna sfida in corso.</p>`
      }
    </section>

    <section class="dashboard-section">
      <div class="section-head">
        <div>
          <span class="badge">Inviate</span>
          <h3>Richieste aperte</h3>
        </div>
      </div>
      ${
        sent.length
          ? `<div class="challenge-grid">
            ${sent
              .map((challenge) => `
                <article class="challenge-card">
                  <div class="challenge-head">
                    <strong>${fullChallengeLabel(challenge)}</strong>
                    <span class="badge">In attesa</span>
                  </div>
                  <p class="muted">Aspetta la risposta dell'altro giocatore.</p>
                </article>
              `)
              .join("")}
          </div>`
          : `<p class="empty">Nessuna richiesta aperta inviata.</p>`
      }
    </section>

    ${
      state.uiMessage
        ? `<div class="message ${state.uiMessage.kind}">${state.uiMessage.text}</div>`
        : ""
    }

    ${
      revealedCardBanner
        ? `
          <div class="card-banner-backdrop" data-action="close-card-banner">
            <div class="card-banner" role="dialog" aria-modal="true">
              <span class="badge">${revealedCardBanner.type === "bonus" ? "Bonus" : "Malus"}</span>
              <h3>${revealedCardBanner.title}</h3>
              <p class="muted">${revealedCardBanner.description}</p>
              <button class="primary" data-action="close-card-banner">Chiudi</button>
            </div>
          </div>
        `
        : ""
    }

    ${
      rulesOpen
        ? `
          <div class="card-banner-backdrop" data-action="close-rules">
            <div class="card-banner rules-banner" role="dialog" aria-modal="true">
              <span class="badge">Regole</span>
              <h3>Regole del gioco</h3>
              <div class="rules-list">
                <p>1. Ogni nuovo giocatore parte con 20 monete.</p>
                <p>2. Solo l'admin puo iniziare la partita con la password e far partire il timer di 3 ore.</p>
                <p>3. Un giocatore puo sfidarne un altro dalla lobby.</p>
                <p>4. Chi riceve la sfida decide quante monete mettere in palio oppure puo andare all in.</p>
                <p>5. Quando una sfida finisce, il vincitore incassa le monete del perdente.</p>
                <p>6. I giocatori possono regalarsi monete tra loro.</p>
                <p>7. Ogni giocatore puo chiedere 10 monete alla banca. Il debito va restituito appena possibile.</p>
                <p>8. Ogni 5 partite completate un giocatore ottiene una Carta del destino.</p>
                <p>9. La Carta del destino resta coperta finche il giocatore non clicca Scopri carta.</p>
                <p>10. Si puo scommettere solo su giocatori che non sono in una sfida in corso.</p>
                <p>11. Se hai una scommessa aperta su un giocatore non puoi sfidarlo.</p>
                <p>12. Le scommesse valgono per la prossima sfida del giocatore scelto e la banca paga in base alla quota.</p>
                <p>13. Quando il gioco finisce viene congelata la classifica finale.</p>
              </div>
              <button class="primary" data-action="close-rules">Chiudi</button>
            </div>
          </div>
        `
        : ""
    }

    ${
      timerVisible
        ? `
          <section class="game-corner">
            <div class="game-mini">
              <span class="badge">${isGameFinished() ? "Classifica" : "Partita"}</span>
              <strong>${isGameActive() ? "In corso" : isGameFinished() ? "Finito" : "Da iniziare"}</strong>
              <span class="tiny" data-role="game-timer">Timer ${isGameFinished() ? "00:00:00" : formatRemainingTime()}</span>
            </div>
          </section>
        `
        : ""
    }
  `;

  dashboardView.querySelector('[data-action="logout"]').addEventListener("click", () => {
    logout();
  });

  dashboardView.querySelector('[data-action="open-rules"]').addEventListener("click", () => {
    openRules();
  });

  dashboardView.querySelector('[data-action="toggle-timer"]').addEventListener("click", () => {
    toggleTimerVisibility();
  });

  dashboardView.querySelector('[data-action="toggle-ranking"]').addEventListener("click", () => {
    toggleRanking();
  });

  if (dashboardView.querySelector('[data-action="start-game"]')) {
    dashboardView.querySelector('[data-action="start-game"]').addEventListener("click", () => {
      clearMessage();
      if (!canStartGame(currentUser())) {
        setMessage("error", "Solo l'account autorizzato puo iniziare la partita.");
        render();
        return;
      }
      startGame();
    });
  }

  dashboardView.querySelector('[data-action="bank-loan"]').addEventListener("click", () => {
    clearMessage();
    takeBankLoan();
  });

  dashboardView.querySelector('[data-action="bank-repay"]').addEventListener("click", () => {
    clearMessage();
    repayBankLoan();
  });

  dashboardView.querySelectorAll('[data-action="challenge"]').forEach((button) => {
    button.addEventListener("click", () => {
      clearMessage();
      createChallenge(button.dataset.userId);
    });
  });

  dashboardView.querySelectorAll('[data-action="toggle-player"]').forEach((button) => {
    button.addEventListener("click", () => {
      toggleSelectedPlayer(button.dataset.userId);
    });
  });

  dashboardView.querySelectorAll('[data-action="gift"]').forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      clearMessage();
      giftCoins(form.dataset.userId, new FormData(event.currentTarget));
    });
  });

  dashboardView.querySelectorAll('[data-action="bet"]').forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      clearMessage();
      placeBet(form.dataset.userId, new FormData(event.currentTarget));
    });
  });

  dashboardView
    .querySelectorAll('[data-action="accept-challenge"]')
    .forEach((form) => {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        clearMessage();
        acceptChallenge(form.dataset.challengeId, new FormData(event.currentTarget));
      });
    });

  dashboardView.querySelectorAll('[data-action="all-in"]').forEach((button) => {
    button.addEventListener("click", () => {
      clearMessage();
      allInChallenge(button.dataset.challengeId);
    });
  });

  dashboardView.querySelectorAll('[data-action="reveal-card"]').forEach((button) => {
    button.addEventListener("click", () => {
      clearMessage();
      revealDestinyCard(button.dataset.cardId);
    });
  });

  dashboardView.querySelectorAll('[data-action="gift-penalty"]').forEach((button) => {
    button.addEventListener("click", () => {
      clearMessage();
      useGiftPenalty(button.dataset.cardId, button.dataset.userId);
    });
  });

  dashboardView.querySelectorAll('[data-action="decline"]').forEach((button) => {
    button.addEventListener("click", () => {
      clearMessage();
      declineChallenge(button.dataset.challengeId);
    });
  });

  dashboardView.querySelectorAll('[data-action="settle"]').forEach((button) => {
    button.addEventListener("click", () => {
      clearMessage();
      settleChallenge(button.dataset.challengeId, button.dataset.winnerId);
    });
  });

  dashboardView.querySelectorAll('[data-action="close-card-banner"]').forEach((element) => {
    element.addEventListener("click", (event) => {
      if (
        event.target === element ||
        event.target.dataset.action === "close-card-banner"
      ) {
        closeRevealedCardBanner();
      }
    });
  });

  dashboardView.querySelectorAll('[data-action="close-rules"]').forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target === element || event.target.dataset.action === "close-rules") {
        closeRules();
      }
    });
  });
}

function render() {
  state = loadState();
  if (selectedPlayerId && !getUser(selectedPlayerId)) {
    selectedPlayerId = null;
  }
  const isLoggedIn = Boolean(currentUser());
  registerView.classList.toggle("hidden", isLoggedIn);
  dashboardView.classList.toggle("hidden", !isLoggedIn);

  if (isLoggedIn) {
    renderDashboard();
    return;
  }

  renderRegister();
}

window.addEventListener("storage", () => {
  render();
});

if (timerHandle) {
  clearInterval(timerHandle);
}
timerHandle = setInterval(syncGameTimer, 1000);

hydrateRemoteState();
startRemoteSync();
startAuthSync();
processAuthRedirect();
render();
