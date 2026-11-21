"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { supabase } from "../lib/supabase";
import Header from "../components/Header";

interface Room {
  room_id: string;
  creator: string;
  bet: number;
  is_public: boolean;
  players_count: number;
}

type Wallet = "play" | "bonus";

export default function P2PLobby() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [username, setUsername] = useState("");

  const [playBalance, setPlayBalance] = useState(0);
  const [bonusBalance, setBonusBalance] = useState(0);

  const [userId, setUserId] = useState<string | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [selectedWallet, setSelectedWallet] = useState<Wallet>("play");

  const [modal, setModal] = useState({
    isOpen: false,
    title: "",
    message: "",
  });

  const [betAmount, setBetAmount] = useState("0.25");
  const [isPublic, setIsPublic] = useState(true);
  const [password, setPassword] = useState("");
  const [roomPasswords, setRoomPasswords] = useState<Record<string, string>>(
    {}
  );

  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [board, setBoard] = useState<(string | null)[]>(Array(9).fill(null));

  const [symbol, setSymbol] = useState<string | null>(null);
  const [turn, setTurn] = useState("X");
  const [status, setStatus] = useState("Conectando...");
  const [winner, setWinner] = useState<string | null>(null);
  const [winnerPrize, setWinnerPrize] = useState(0);
  const [refundedAmount, setRefundedAmount] = useState(0);
  const [gameBet, setGameBet] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);

  const lobbySocketRef = useRef<WebSocket | null>(null);
  const gameSocketRef = useRef<WebSocket | null>(null);

  const userIdRef = useRef<string | null>(null);
  const usernameRef = useRef("");
  const selectedWalletRef = useRef<Wallet>("play");
  const betAmountRef = useRef("0.25");
  const symbolRef = useRef<string | null>(null);

  const pingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const registeredCommissionsRef = useRef<Set<string>>(new Set());
  const paidRoomsRef = useRef<Set<string>>(new Set());
  const refundedRoomsRef = useRef<Set<string>>(new Set());
  const processedFinishRoomsRef = useRef<Set<string>>(new Set());

  const pendingCreateRef = useRef<{
    wallet: Wallet;
    bet: number;
  } | null>(null);

  const connectingRef = useRef(false);
  const leavingRef = useRef(false);

  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

  useEffect(() => {
    usernameRef.current = username;
  }, [username]);

  useEffect(() => {
    selectedWalletRef.current = selectedWallet;
  }, [selectedWallet]);

  useEffect(() => {
    betAmountRef.current = betAmount;
  }, [betAmount]);

  const showAlert = (title: string, message: string) => {
    setModal({ isOpen: true, title, message });
  };

  const closeModal = () => {
    setModal({ isOpen: false, title: "", message: "" });
  };

  // El frontend local y el desplegado usan el mismo backend.
  const getWebSocketUrl = (endpoint: string) => {
    return `wss://casino-axiom.ethiodeploy.app${endpoint}`;
  };

  const stopPing = () => {
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }
  };

  const startPing = (ws: WebSocket) => {
    stopPing();

    pingIntervalRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "PING" }));
        } catch (error) {
          console.error("Error enviando PING:", error);
        }
      }
    }, 20000);
  };

  const loadUserBalances = async (currentSession?: any) => {
    let sessionToUse = currentSession;

    if (!sessionToUse) {
      const { data, error } = await supabase.auth.getSession();

      if (error) {
        console.error("ERROR OBTENIENDO SESIÓN:", error);
      }

      sessionToUse = data.session;
    }

    const currentUserId = sessionToUse?.user?.id;

    if (!currentUserId) {
      setUserId(null);
      setPlayBalance(0);
      setBonusBalance(0);
      setUsername("");
      return;
    }

    setUserId(currentUserId);

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("first_name, balance, withdraw_balance, bonus_balance")
      .eq("id", currentUserId)
      .maybeSingle();

    if (error) {
      console.error("ERROR AL CARGAR EL PERFIL:", error);
      return;
    }

    if (!profile) {
      setUsername(sessionToUse.user.email?.split("@")[0] || "Usuario");
      setPlayBalance(0);
      setBonusBalance(0);
      return;
    }

    setUsername(
      profile.first_name ||
      sessionToUse.user.email?.split("@")[0] ||
      "Usuario"
    );

    setPlayBalance(Number(profile.balance ?? 0));
    setBonusBalance(Number(profile.bonus_balance ?? 0));
  };

  useEffect(() => {
    let mounted = true;

    async function checkAuthAndLoadUser() {
      setIsAuthLoading(true);

      const {
        data: { session },
        error,
      } = await supabase.auth.getSession();

      if (error) {
        console.error("ERROR DE AUTENTICACIÓN:", error);
      }

      if (!mounted) return;

      if (!session) {
        setUserId(null);
        setIsAuthLoading(false);
        return;
      }

      await loadUserBalances(session);

      if (mounted) {
        setIsAuthLoading(false);
      }
    }

    checkAuthAndLoadUser();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!mounted) return;

      if (session) {
        await loadUserBalances(session);
      } else {
        setUserId(null);
        setUsername("");
        setPlayBalance(0);
        setBonusBalance(0);
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  // ==========================================================
  // COMISIÓN (SOLO CUANDO ALGUIEN GANA)
  // Se registra una sola vez por usuario y sala al haber victoria.
  // ==========================================================

  const registrarComision = async (roomId: string, monto: number) => {
    const currentUserId = userIdRef.current;

    if (!currentUserId) {
      console.error("No se pudo registrar la comisión: usuario no autenticado.");
      return;
    }

    const commissionKey = `${roomId}:${currentUserId}`;

    if (registeredCommissionsRef.current.has(commissionKey)) {
      return;
    }

    registeredCommissionsRef.current.add(commissionKey);

    const { error } = await supabase.rpc("registrar_comision_xo", {
      p_user_id: currentUserId,
      p_room_id: roomId,
      p_monto: monto,
    });

    if (error) {
      registeredCommissionsRef.current.delete(commissionKey);

      console.error("ERROR AL REGISTRAR COMISIÓN:", error);

      showAlert(
        "Error al registrar comisión",
        error.message || "No se pudo guardar la comisión de esta partida."
      );
    }
  };

  // ==========================================================
  // DEVOLUCIÓN DE APUESTA EN EMPATE (SIN COMISIÓN)
  // ==========================================================

  const devolverApuestaEmpate = async (
    roomId: string,
    monto: number,
    walletType: Wallet
  ) => {
    const currentUserId = userIdRef.current;
    if (!currentUserId || monto <= 0) return;

    const refundKey = `${roomId}:${currentUserId}`;
    if (refundedRoomsRef.current.has(refundKey)) return;

    refundedRoomsRef.current.add(refundKey);

    const { error } = await supabase.rpc("refund_bet_balance", {
      p_user_id: currentUserId,
      p_amount: monto,
      p_wallet: walletType === "bonus" ? "bonus" : "play",
    });

    if (error) {
      refundedRoomsRef.current.delete(refundKey);
      console.error("ERROR AL DEVOLVER APUESTA POR EMPATE:", error);
      showAlert(
        "Error al reembolsar apuesta",
        error.message || "No se pudo devolver la apuesta del empate."
      );
    } else {
      setRefundedAmount(monto);
      await loadUserBalances();
    }
  };

  // ==========================================================
  // LOBBY WEBSOCKET
  // ==========================================================

  useEffect(() => {
    if (!userId || activeRoomId) return;

    let cancelled = false;

    const wsUrl = getWebSocketUrl(
      `/ws/lobby?user_id=${encodeURIComponent(userId)}`
    );

    const ws = new WebSocket(wsUrl);
    lobbySocketRef.current = ws;

    ws.onopen = () => {
      if (cancelled) return;
      setStatus("Conectado");
    };

    ws.onmessage = async (event) => {
      if (cancelled) return;

      let data: any;

      try {
        data = JSON.parse(event.data);
      } catch {
        console.error("Mensaje inválido recibido del lobby:", event.data);
        return;
      }

      if (data.type === "LOBBY_UPDATE") {
        setRooms(Array.isArray(data.rooms) ? data.rooms : []);
        return;
      }

      if (data.type === "ROOM_CREATED") {
        const pending = pendingCreateRef.current;

        if (!pending) {
          console.error("Se recibió ROOM_CREATED sin creación pendiente.");
          return;
        }

        pendingCreateRef.current = null;

        await connectToGame(
          data.room_id,
          data.password || "",
          pending.wallet,
          pending.bet,
          false
        );

        return;
      }

      if (data.type === "ERROR") {
        pendingCreateRef.current = null;
        setIsProcessing(false);
        showAlert("Error en Sala", data.message || "Error desconocido.");
      }
    };

    ws.onerror = () => {
      if (!cancelled) {
        setStatus("Error de conexión");
      }
    };

    ws.onclose = () => {
      if (!cancelled && lobbySocketRef.current === ws) {
        lobbySocketRef.current = null;
        setStatus("Desconectado");
      }
    };

    return () => {
      cancelled = true;

      if (lobbySocketRef.current === ws) {
        lobbySocketRef.current = null;
      }

      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
    };
  }, [userId, activeRoomId]);

  // ==========================================================
  // CONECTAR A UNA PARTIDA
  // ==========================================================

  const connectToGame = async (
    roomId: string,
    roomPassword = "",
    walletType: Wallet = selectedWalletRef.current,
    roomBet?: number,
    checkClientBalance = true,
    creatorName?: string
  ) => {
    if (connectingRef.current) return;

    if (
      creatorName &&
      creatorName.trim().toLowerCase() ===
      usernameRef.current.trim().toLowerCase()
    ) {
      showAlert(
        "Acción no permitida",
        "No puedes unirte a una sala creada por tu misma cuenta."
      );
      return;
    }

    const betVal = Number(roomBet ?? betAmountRef.current);

    if (!Number.isFinite(betVal) || betVal < 0.25) {
      showAlert(
        "Apuesta Inválida",
        "La apuesta mínima permitida es de $0.25."
      );
      return;
    }

    const currentUserId = userIdRef.current;

    if (!currentUserId) {
      showAlert("Error", "Usuario no autenticado.");
      return;
    }

    if (gameSocketRef.current) {
      if (
        gameSocketRef.current.readyState === WebSocket.OPEN ||
        gameSocketRef.current.readyState === WebSocket.CONNECTING
      ) {
        showAlert("Partida activa", "Ya tienes una conexión de partida abierta.");
        return;
      }
    }

    const currentAvailable =
      walletType === "play" ? playBalance : bonusBalance;

    const walletName =
      walletType === "play" ? "Saldo de Juego" : "Saldo Bono";

    if (checkClientBalance && currentAvailable < betVal) {
      showAlert(
        "Saldo Insuficiente",
        `Necesitas $${betVal.toFixed(2)} en tu ${walletName}. Disponible: $${currentAvailable.toFixed(2)}.`
      );
      return;
    }

    connectingRef.current = true;
    setIsProcessing(true);

    try {
      if (checkClientBalance) {
        const walletParam = walletType === "bonus" ? "bonus" : "play";

        const { error: rpcError } = await supabase.rpc(
          "deduct_bet_balance",
          {
            p_user_id: currentUserId,
            p_amount: betVal,
            p_wallet: walletParam,
          }
        );

        if (rpcError) {
          showAlert(
            "Error de saldo",
            rpcError.message || "No se pudo descontar la apuesta."
          );
          return;
        }

        await loadUserBalances();
      }

      const wsUrl = getWebSocketUrl(
        `/ws/game/${encodeURIComponent(roomId)}?password=${encodeURIComponent(
          roomPassword
        )}&wallet=${walletType}&user_id=${encodeURIComponent(currentUserId)}`
      );

      const ws = new WebSocket(wsUrl);
      gameSocketRef.current = ws;

      let initialized = false;
      let finished = false;
      const effectiveBet = Number(roomBet ?? betVal);

      ws.onopen = () => {
        setStatus("Entrando a la sala...");
        startPing(ws);
      };

      ws.onmessage = async (event) => {
        let data: any;

        try {
          data = JSON.parse(event.data);
        } catch {
          console.error("Mensaje inválido recibido del juego:", event.data);
          return;
        }

        if (data.type === "PONG") {
          return;
        }

        // ----------------------------------------------------
        // INIT
        // ----------------------------------------------------

        if (data.type === "INIT") {
          initialized = true;

          setActiveRoomId(roomId);
          setSymbol(data.symbol);
          symbolRef.current = data.symbol;

          setIsHost(Boolean(data.is_host));
          setBoard(
            Array.isArray(data.board) ? data.board : Array(9).fill(null)
          );

          setTurn(data.turn || "X");
          const currentRoomBet = Number(data.bet ?? effectiveBet);
          setGameBet(currentRoomBet);
          setWinner(null);
          setWinnerPrize(0);
          setRefundedAmount(0);

          processedFinishRoomsRef.current.delete(roomId);

          setStatus(
            data.status === "PLAYING"
              ? `En juego. Apuesta: $${currentRoomBet.toFixed(2)}`
              : `Esperando rival... Apuesta: $${currentRoomBet.toFixed(2)}`
          );

          if (lobbySocketRef.current) {
            lobbySocketRef.current.close();
            lobbySocketRef.current = null;
          }

          await loadUserBalances();

          setIsProcessing(false);
          connectingRef.current = false;
          return;
        }

        // ----------------------------------------------------
        // START
        // ----------------------------------------------------

        if (data.type === "START") {
          setStatus("En juego. Turno: " + data.turn);
          setTurn(data.turn);
          return;
        }

        // ----------------------------------------------------
        // MOVE_MADE
        // ----------------------------------------------------

        if (data.type === "MOVE_MADE") {
          if (Array.isArray(data.board)) {
            setBoard(data.board);
          }

          setTurn(data.next_turn || data.turn || "X");

          if (!finished) {
            setStatus(`Turno: ${data.next_turn || data.turn}`);
          }

          return;
        }

        // ----------------------------------------------------
        // GAME_FINISHED
        // Cubre empate (devuelve apuesta, sin comisión),
        // victoria normal y victoria por abandono del rival.
        // ----------------------------------------------------

        if (data.type === "GAME_FINISHED") {
          if (finished) return;
          finished = true;

          if (Array.isArray(data.board)) {
            setBoard(data.board);
          }

          if (processedFinishRoomsRef.current.has(roomId)) {
            return;
          }

          processedFinishRoomsRef.current.add(roomId);

          const settledBet = Number(data.bet ?? effectiveBet);

          if (data.result === "draw") {
            setWinner("DRAW");
            setStatus("EMPATE");
            setWinnerPrize(0);

            await devolverApuestaEmpate(roomId, settledBet, walletType);
          } else {
            const currentUserId = userIdRef.current;
            const isWinner = String(data.winner_id) === String(currentUserId);
            const isForfeitWin =
              isWinner &&
              (data.reason === "forfeit" || data.reason === "opponent_left");

            if (isWinner) {
              setWinner(symbolRef.current || "X");
              setStatus(isForfeitWin ? "WIN (RIVAL ABANDONÓ)" : "WIN");

              const totalPot = Number((settledBet * 2).toFixed(2));
              const commissionPerPlayer =
                Math.round(settledBet * 0.06 * 100) / 100;
              const totalCommission = Number(
                (commissionPerPlayer * 2).toFixed(2)
              );
              const netPrize = Number(
                (totalPot - totalCommission).toFixed(2)
              );

              setWinnerPrize(netPrize);

              await registrarComision(roomId, settledBet);

              const payoutKey = `${roomId}:${currentUserId}`;

              if (
                currentUserId &&
                netPrize > 0 &&
                !paidRoomsRef.current.has(payoutKey)
              ) {
                paidRoomsRef.current.add(payoutKey);

                const { error: payoutError } = await supabase.rpc(
                  "credit_winner_balance",
                  {
                    p_user_id: currentUserId,
                    p_prize: netPrize,
                  }
                );

                if (payoutError) {
                  paidRoomsRef.current.delete(payoutKey);

                  console.error(
                    "ERROR AL ACREDITAR PREMIO:",
                    payoutError
                  );

                  showAlert(
                    "Error al entregar premio",
                    payoutError.message ||
                    "No se pudo acreditar el premio."
                  );
                } else {
                  await loadUserBalances();
                }
              }
            } else {
              setWinner("OPPONENT");
              setStatus(
                data.reason === "forfeit" || data.reason === "player_left"
                  ? "ABANDONASTE LA SALA"
                  : "GAME OVER"
              );
            }
          }

          await loadUserBalances();

          if (finishTimeoutRef.current) {
            clearTimeout(finishTimeoutRef.current);
          }

          finishTimeoutRef.current = setTimeout(() => {
            leaveGame(false);
          }, 5000);

          return;
        }

        // ----------------------------------------------------
        // ROOM_CLOSED_BY_HOST
        // Si nadie más había entrado aún, devuelve la apuesta.
        // ----------------------------------------------------

        if (data.type === "ROOM_CLOSED_BY_HOST") {
          if (!isHost && effectiveBet > 0) {
            await devolverApuestaEmpate(roomId, effectiveBet, walletType);
          }

          showAlert(
            "Sala Cerrada",
            "El creador de la sala ha cancelado la partida."
          );

          await leaveGame(false);
          return;
        }

        // ----------------------------------------------------
        // ERROR
        // ----------------------------------------------------

        if (data.type === "ERROR") {
          showAlert(
            "Error de Conexión",
            data.message || "No se pudo completar la operación."
          );

          setIsProcessing(false);

          if (!initialized) {
            connectingRef.current = false;
            stopPing();

            if (gameSocketRef.current === ws) {
              gameSocketRef.current = null;
            }

            try {
              ws.close();
            } catch {
              // No hay nada más que cerrar.
            }
          } else {
            await leaveGame(false);
          }
        }
      };

      ws.onerror = (event) => {
        console.error("ERROR WEBSOCKET PARTIDA:", event);

        if (!initialized) {
          setStatus("Error de conexión con la partida");
          setIsProcessing(false);
        }
      };

      ws.onclose = () => {
        stopPing();

        if (gameSocketRef.current === ws) {
          gameSocketRef.current = null;
        }

        if (!initialized) {
          connectingRef.current = false;
          setIsProcessing(false);
        }
      };
    } catch (error: any) {
      console.error("ERROR CONECTANDO A LA PARTIDA:", error);

      showAlert(
        "Error de conexión",
        error?.message || "No se pudo conectar con el servidor."
      );
    } finally {
      if (!gameSocketRef.current) {
        connectingRef.current = false;
        setIsProcessing(false);
      }
    }
  };

  // ==========================================================
  // SALIR / ABANDONAR SALA
  // Si abandona una partida en curso, notifica LEAVE_GAME para
  // perder lo apostado y que el rival gane.
  // ==========================================================

  const leaveGame = async (notifyServer = true) => {
    if (leavingRef.current) return;

    leavingRef.current = true;

    if (finishTimeoutRef.current) {
      clearTimeout(finishTimeoutRef.current);
      finishTimeoutRef.current = null;
    }

    stopPing();

    const ws = gameSocketRef.current;

    if (ws && ws.readyState === WebSocket.OPEN && notifyServer) {
      try {
        const gameAlreadyStarted = !status.includes("Esperando");

        if (isHost && !gameAlreadyStarted) {
          ws.send(JSON.stringify({ type: "CLOSE_ROOM" }));
        } else if (!winner) {
          ws.send(
            JSON.stringify({
              type: "LEAVE_GAME",
              user_id: userIdRef.current,
            })
          );
        }
      } catch (error) {
        console.error("ERROR NOTIFICANDO SALIDA DE SALA:", error);
      }
    }

    gameSocketRef.current = null;

    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      try {
        ws.close();
      } catch {
        // La conexión ya puede estar cerrada.
      }
    }

    setActiveRoomId(null);
    setWinner(null);
    setWinnerPrize(0);
    setRefundedAmount(0);
    setSymbol(null);
    symbolRef.current = null;
    setIsHost(false);
    setBoard(Array(9).fill(null));
    setTurn("X");
    setGameBet(0);
    setStatus("Conectado");
    setIsProcessing(false);

    connectingRef.current = false;
    processedFinishRoomsRef.current.clear();

    await loadUserBalances();

    leavingRef.current = false;
  };

  // ==========================================================
  // CREAR SALA
  // ==========================================================

  const createRoom = async () => {
    if (isProcessing || pendingCreateRef.current) return;

    const ws = lobbySocketRef.current;

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showAlert(
        "Error de Red",
        "Sin conexión activa con el servidor. Espera a que se conecte el lobby."
      );
      return;
    }

    const parsedBet = Number(betAmount);

    if (!Number.isFinite(parsedBet) || parsedBet < 0.25) {
      showAlert(
        "Apuesta Inválida",
        "La apuesta mínima permitida es de $0.25."
      );
      return;
    }

    if (!isPublic && !password.trim()) {
      showAlert(
        "Sala Privada",
        "Debes ingresar una contraseña para crear la sala privada."
      );
      return;
    }

    const currentUserId = userIdRef.current;

    if (!currentUserId) {
      showAlert("Error", "Usuario no autenticado.");
      return;
    }

    const currentAvailable =
      selectedWallet === "play" ? playBalance : bonusBalance;

    const walletName =
      selectedWallet === "play" ? "Saldo de Juego" : "Saldo Bono";

    if (currentAvailable < parsedBet) {
      showAlert(
        "Saldo Insuficiente",
        `No tienes suficiente en tu ${walletName}. Disponible: $${currentAvailable.toFixed(2)}.`
      );
      return;
    }

    setIsProcessing(true);

    try {
      const walletParam = selectedWallet === "bonus" ? "bonus" : "play";

      const { error: rpcError } = await supabase.rpc(
        "deduct_bet_balance",
        {
          p_user_id: currentUserId,
          p_amount: parsedBet,
          p_wallet: walletParam,
        }
      );

      if (rpcError) {
        showAlert(
          "Error de saldo",
          rpcError.message || "No se pudo descontar la apuesta."
        );
        return;
      }

      await loadUserBalances();

      pendingCreateRef.current = {
        wallet: selectedWallet,
        bet: parsedBet,
      };

      ws.send(
        JSON.stringify({
          type: "CREATE_ROOM",
          bet: parsedBet,
          is_public: isPublic,
          password: isPublic ? "" : password.trim(),
          creator: usernameRef.current || "Jugador",
          wallet: selectedWallet,
          user_id: currentUserId,
        })
      );
    } catch (error: any) {
      pendingCreateRef.current = null;

      console.error("ERROR CREANDO SALA:", error);

      showAlert(
        "Error al crear sala",
        error?.message || "No se pudo crear la sala."
      );
    } finally {
      if (!pendingCreateRef.current) {
        setIsProcessing(false);
      }
    }
  };

  // ==========================================================
  // MOVIMIENTOS
  // ==========================================================

  const handleClick = (index: number) => {
    const ws = gameSocketRef.current;

    if (
      !activeRoomId ||
      board[index] ||
      !symbol ||
      symbol !== turn ||
      winner ||
      status.includes("Esperando") ||
      status.startsWith("WIN") ||
      status === "GAME OVER" ||
      !ws ||
      ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    try {
      ws.send(
        JSON.stringify({
          type: "MOVE",
          index,
          symbol,
        })
      );
    } catch (error) {
      console.error("ERROR ENVIANDO MOVIMIENTO:", error);
      showAlert("Error", "No se pudo enviar el movimiento.");
    }
  };

  // ==========================================================
  // FILTRADO DE SALAS
  // ==========================================================

  const filteredRooms = rooms.filter((room) =>
    String(room.creator || "")
      .toLowerCase()
      .includes(searchQuery.toLowerCase())
  );

  // ==========================================================
  // LIMPIEZA
  // ==========================================================

  useEffect(() => {
    return () => {
      stopPing();

      if (finishTimeoutRef.current) {
        clearTimeout(finishTimeoutRef.current);
      }

      if (gameSocketRef.current) {
        try {
          gameSocketRef.current.close();
        } catch {
          // Limpieza al desmontar.
        }
      }

      if (lobbySocketRef.current) {
        try {
          lobbySocketRef.current.close();
        } catch {
          // Limpieza al desmontar.
        }
      }
    };
  }, []);

  // ==========================================================
  // CARGA
  // ==========================================================

  if (isAuthLoading) {
    return (
      <div className="min-h-screen bg-black text-white flex flex-col font-sans">
        <Header />

        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs uppercase tracking-widest text-emerald-400 font-bold animate-pulse">
            Verificando credenciales...
          </p>
        </div>
      </div>
    );
  }

  if (!userId) {
    return (
      <div className="min-h-screen bg-black text-white flex flex-col justify-between font-sans">
        <Header />

        <main className="flex-1 flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-zinc-950 border border-zinc-800 rounded-3xl p-8 text-center space-y-6 shadow-2xl">
            <div>
              <h2 className="text-xl font-black uppercase text-white tracking-wider">
                Acceso Restringido
              </h2>

              <p className="text-xs text-zinc-400 mt-2 leading-relaxed">
                Debes iniciar sesión o registrar tu cuenta para acceder a las
                salas de juego en vivo y apostar.
              </p>
            </div>

            <Link
              href="/"
              className="block w-full py-3 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase tracking-wider rounded-xl transition-all shadow-lg active:scale-95"
            >
              Iniciar Sesión / Registrarse
            </Link>
          </div>
        </main>

        <footer className="py-6 text-center text-[10px] text-zinc-600 font-bold uppercase tracking-widest">
          AXIOM
        </footer>
      </div>
    );
  }

  // ==========================================================
  // INTERFAZ ORIGINAL
  // ==========================================================

  return (
    <div className="min-h-screen bg-black text-white flex flex-col justify-between select-none font-sans">
      <Header />

      {modal.isOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-zinc-950 border border-zinc-800 w-full max-w-sm rounded-2xl p-6 shadow-2xl text-center space-y-4 animate-in fade-in zoom-in-95">
            <h3 className="text-lg font-black uppercase text-emerald-400 tracking-wider">
              {modal.title}
            </h3>

            <p className="text-xs text-zinc-300 leading-relaxed">
              {modal.message}
            </p>

            <button
              onClick={closeModal}
              className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs uppercase tracking-wider rounded-xl transition-all shadow-lg active:scale-95"
            >
              Entendido
            </button>
          </div>
        </div>
      )}

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-8 flex flex-col items-center justify-center">
        {!activeRoomId ? (
          <div className="w-full max-w-3xl flex flex-col gap-3">
            <div className="bg-black border border-zinc-800 rounded-2xl p-4 shadow-2xl">
              <Link
                href="/"
                className="flex items-center gap-2 w-fit mb-4 text-zinc-500 hover:text-emerald-400 text-xs font-black uppercase tracking-widest transition-colors"
              >
                <span className="text-xl leading-none">‹</span>
                <span>Volver</span>
              </Link>

              <div className="text-center mb-6 border-b border-zinc-900 pb-4">
                <h2 className="text-2xl font-black tracking-wider text-emerald-400 uppercase">
                  X vs O
                </h2>

                <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mt-1">
                  Arena P2P
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="flex flex-col gap-4">
                  <div>
                    <label className="text-[10px] font-black text-zinc-400 uppercase tracking-wider block mb-1">
                      Tu Jugador
                    </label>

                    <input
                      type="text"
                      value={username}
                      readOnly
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none font-bold cursor-not-allowed"
                    />
                  </div>

                  <div className="bg-zinc-900/40 p-4 rounded-xl border border-zinc-800">
                    <h3 className="text-[11px] font-black text-zinc-300 uppercase tracking-wider mb-3">
                      Crear Partida
                    </h3>

                    <div className="mb-3">
                      <label className="text-[10px] text-zinc-400 block mb-1">
                        ¿De dónde deseas apostar?
                      </label>

                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedWallet("play")}
                          className={`py-2 rounded-xl text-[11px] font-black uppercase tracking-wide transition-all border ${selectedWallet === "play"
                              ? "bg-emerald-500 text-black border-emerald-400"
                              : "bg-black text-zinc-400 border-zinc-800"
                            }`}
                        >
                          Saldo Jugar (${playBalance.toFixed(2)})
                        </button>

                        <button
                          type="button"
                          onClick={() => setSelectedWallet("bonus")}
                          className={`py-2 rounded-xl text-[11px] font-black uppercase tracking-wide transition-all border ${selectedWallet === "bonus"
                              ? "bg-yellow-400 text-black border-yellow-300"
                              : "bg-black text-zinc-400 border-zinc-800"
                            }`}
                        >
                          Saldo Bono (${bonusBalance.toFixed(2)})
                        </button>
                      </div>
                    </div>

                    <div className="mb-3">
                      <label className="text-[10px] text-zinc-400 block mb-1">
                        Apuesta ($ Min: $0.25)
                      </label>

                      <input
                        type="number"
                        step="0.01"
                        min="0.25"
                        value={betAmount}
                        onChange={(e) => setBetAmount(e.target.value)}
                        autoComplete="off"
                        className="w-full bg-black border border-zinc-700 rounded-xl px-3.5 py-2.5 text-xs text-emerald-400 font-bold outline-none focus:border-emerald-500 transition-all"
                      />

                      <p className="text-[10px] text-zinc-500 mt-1">
                        Comisión del 6% solo al ganar. En empate se devuelve tu apuesta.
                      </p>
                    </div>

                    <div className="mb-3">
                      <label className="text-[10px] text-zinc-400 block mb-1">
                        Privacidad
                      </label>

                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setIsPublic(true)}
                          className={`py-2 rounded-xl text-[11px] font-black uppercase tracking-wide transition-all border ${isPublic
                              ? "bg-emerald-500 text-black border-emerald-400"
                              : "bg-black text-zinc-400 border-zinc-800"
                            }`}
                        >
                          Pública
                        </button>

                        <button
                          type="button"
                          onClick={() => setIsPublic(false)}
                          className={`py-2 rounded-xl text-[11px] font-black uppercase tracking-wide transition-all border ${!isPublic
                              ? "bg-emerald-500 text-black border-emerald-400"
                              : "bg-black text-zinc-400 border-zinc-800"
                            }`}
                        >
                          Privada
                        </button>
                      </div>
                    </div>

                    {!isPublic && (
                      <div className="mb-3">
                        <label className="text-[10px] text-zinc-400 block mb-1">
                          Contraseña de la Sala
                        </label>

                        <input
                          type="text"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="Escribe la clave..."
                          autoComplete="off"
                          spellCheck="false"
                          className="w-full bg-black border border-zinc-700 rounded-xl px-3.5 py-2.5 text-xs text-white outline-none focus:border-emerald-500 transition-all"
                        />
                      </div>
                    )}

                    <button
                      onClick={createRoom}
                      disabled={isProcessing}
                      className="w-full py-3 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-black font-black text-xs uppercase tracking-wider rounded-xl transition-all shadow-lg active:scale-95 mt-2"
                    >
                      {isProcessing ? "Procesando..." : "Crear Partida"}
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <div className="flex justify-between items-center">
                    <h3 className="text-[11px] font-black text-zinc-300 uppercase tracking-wider">
                      Salas Disponibles
                    </h3>

                    <span className="text-emerald-400 font-mono text-[10px] bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800">
                      {filteredRooms.length} activas
                    </span>
                  </div>

                  <div>
                    <input
                      type="text"
                      placeholder="Buscar jugador..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      autoComplete="off"
                      spellCheck="false"
                      className="w-full bg-zinc-900/80 border border-zinc-800 rounded-xl px-3.5 py-2 text-xs text-zinc-200 placeholder-zinc-500 outline-none focus:border-emerald-500 transition-all"
                    />
                  </div>

                  <div className="space-y-2.5 max-h-[340px] overflow-y-auto pr-1">
                    {filteredRooms.length === 0 ? (
                      <p className="text-xs text-zinc-500 text-center py-10 bg-zinc-900/30 rounded-xl border border-zinc-900">
                        {searchQuery
                          ? "No se encontraron salas para ese apodo."
                          : "No hay salas activas en este momento."}
                      </p>
                    ) : (
                      filteredRooms.map((r) => (
                        <div
                          key={r.room_id}
                          className="bg-zinc-900 p-3.5 rounded-xl border border-zinc-800 flex flex-col gap-2"
                        >
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="flex items-center gap-1.5">
                                <p className="text-xs font-bold text-zinc-200">
                                  {r.creator}
                                </p>

                                {!r.is_public && (
                                  <span className="text-[10px] text-yellow-400 font-bold">
                                    [Privada]
                                  </span>
                                )}
                              </div>

                              <p className="text-[11px] text-emerald-400 font-semibold">
                                ${Number(r.bet).toFixed(2)}
                              </p>
                            </div>

                            {r.is_public && (
                              <button
                                disabled={isProcessing}
                                onClick={() =>
                                  connectToGame(
                                    r.room_id,
                                    "",
                                    selectedWallet,
                                    Number(r.bet),
                                    true,
                                    r.creator
                                  )
                                }
                                className="px-3.5 py-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black text-[11px] font-black uppercase tracking-wider rounded-lg transition-all active:scale-95"
                              >
                                Unirse
                              </button>
                            )}
                          </div>

                          {!r.is_public && (
                            <div className="flex gap-2 pt-1.5 border-t border-zinc-800">
                              <input
                                type="text"
                                placeholder="Contraseña..."
                                value={roomPasswords[r.room_id] || ""}
                                onChange={(e) =>
                                  setRoomPasswords((previous) => ({
                                    ...previous,
                                    [r.room_id]: e.target.value,
                                  }))
                                }
                                autoComplete="off"
                                spellCheck="false"
                                className="flex-1 bg-black border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-emerald-500"
                              />

                              <button
                                disabled={isProcessing}
                                onClick={() =>
                                  connectToGame(
                                    r.room_id,
                                    roomPasswords[r.room_id] || "",
                                    selectedWallet,
                                    Number(r.bet),
                                    true,
                                    r.creator
                                  )
                                }
                                className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black text-[11px] font-black uppercase tracking-wider rounded-lg active:scale-95"
                              >
                                Entrar
                              </button>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="w-full max-w-md flex flex-col gap-4">
            <div className="bg-black border border-zinc-800 rounded-2xl p-6 shadow-2xl text-center">
              <h2 className="text-2xl font-black mb-1 uppercase tracking-wider text-emerald-400">
                X vs O
              </h2>

              <p
                className={`text-sm mb-5 font-black uppercase tracking-wider transition-all ${status === "EMPATE"
                    ? "text-yellow-400"
                    : status.startsWith("WIN")
                      ? "text-emerald-400 text-base animate-pulse"
                      : status === "GAME OVER" || status === "ABANDONASTE LA SALA"
                        ? "text-red-500"
                        : "text-zinc-300"
                  }`}
              >
                {status}
              </p>

              {status.startsWith("WIN") && (
                <div className="mb-5 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4">
                  <p className="text-xs font-bold uppercase tracking-widest text-emerald-400">
                    ¡Has ganado la partida!
                  </p>

                  <p className="mt-2 text-3xl font-black text-emerald-400">
                    +${winnerPrize.toFixed(2)}
                  </p>

                  <p className="mt-1 text-[10px] text-zinc-400 uppercase">
                    Premio acreditado
                  </p>
                </div>
              )}

              {status === "EMPATE" && (
                <div className="mb-5 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4">
                  <p className="text-xs font-bold uppercase tracking-widest text-yellow-400">
                    La partida terminó en empate
                  </p>
                  <p className="mt-1 text-xs text-zinc-300">
                    Apuesta devuelta: +${(refundedAmount || gameBet).toFixed(2)} (sin comisión)
                  </p>
                </div>
              )}

              <div className="flex justify-between mb-5 bg-zinc-900 p-3.5 rounded-xl border border-zinc-800 text-xs">
                <span>
                  Tu Ficha:{" "}
                  <strong className="text-emerald-400 font-black">
                    {symbol || "?"}
                  </strong>
                </span>

                <span>
                  Turno Actual:{" "}
                  <strong className="text-white font-black">{turn}</strong>
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2.5 mb-5">
                {board.map((cell: string | null, index: number) => (
                  <button
                    key={index}
                    onClick={() => handleClick(index)}
                    disabled={
                      !!winner ||
                      symbol !== turn ||
                      !!cell ||
                      !gameSocketRef.current ||
                      gameSocketRef.current.readyState !== WebSocket.OPEN
                    }
                    className={`h-24 rounded-xl text-4xl font-black flex items-center justify-center transition-all border ${!cell && symbol === turn && !winner
                        ? "bg-zinc-900 hover:bg-zinc-800 border-zinc-700 cursor-pointer text-white"
                        : "bg-zinc-900/40 border-zinc-900 cursor-not-allowed"
                      }`}
                  >
                    <span
                      className={
                        cell === "X" ? "text-emerald-400" : "text-cyan-400"
                      }
                    >
                      {cell}
                    </span>
                  </button>
                ))}
              </div>

              <button
                onClick={() => leaveGame(true)}
                className="w-full py-2.5 bg-zinc-900 hover:bg-red-950/50 text-zinc-300 hover:text-red-400 font-black text-xs uppercase tracking-wider rounded-xl transition-all border border-zinc-800 active:scale-95"
              >
                Abandonar Sala
              </button>
            </div>
          </div>
        )}
      </main>

      <footer className="py-6 text-center text-[10px] text-zinc-600 font-bold uppercase tracking-widest">
        AXIOM P2P ARENA
      </footer>
    </div>
  );
}