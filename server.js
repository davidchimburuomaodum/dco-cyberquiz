const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 9000;
const rooms = new Map();

app.use(express.static(__dirname));

app.get("/health", (req, res) => {
  res.json({ status: "online", service: "DCO CyberQuiz Multiplayer" });
});

const bank = {
  Beginner: [
    ["What does CPU stand for?", ["Central Processing Unit", "Computer Personal Utility", "Central Program User"], 0],
    ["What is phishing?", ["A programming language", "A deceptive attempt to steal information", "A firewall"], 1],
    ["What does antivirus detect?", ["Malware", "Keyboard errors", "Screen brightness"], 0],
    ["Which is a strong password?", ["123456", "password", "A long unique combination"], 2],
    ["What does HTTPS help provide?", ["Encrypted communication", "More storage", "Free internet"], 0],
    ["What is malware?", ["Computer hardware", "Malicious software", "A browser"], 1],
    ["What is a firewall?", ["Network traffic filter", "Photo editor", "Storage device"], 0],
    ["What is two-factor authentication?", ["Two usernames", "An extra identity verification step", "Two browsers"], 1],
    ["What should you do with suspicious links?", ["Click immediately", "Share them", "Avoid and verify them"], 2],
    ["What is a backup?", ["A copy of data", "A virus", "A password"], 0]
  ],
  Intermediate: [
    ["What is a brute-force attack?", ["Repeated password guessing", "Data backup", "Software update"], 0],
    ["What does SHA-256 produce?", ["A hash digest", "An IP address", "A username"], 0],
    ["What is SQL injection?", ["An attack on unsafe database queries", "A backup method", "An encryption standard"], 0],
    ["What does DNS translate?", ["Domain names into IP addresses", "Passwords into usernames", "Files into folders"], 0],
    ["What is a VPN?", ["An encrypted network connection", "A browser", "An antivirus"], 0],
    ["What is a zero-day vulnerability?", ["A flaw unknown to the vendor or without a fix", "An expired password", "A backup"], 0],
    ["Which protocol commonly uses port 443?", ["HTTPS", "FTP", "Telnet"], 0],
    ["What is social engineering?", ["Manipulating people", "Building websites", "Encrypting disks"], 0],
    ["What is MFA?", ["Multiple verification factors", "Multiple file archives", "A firewall"], 0],
    ["What is a security patch?", ["An update fixing vulnerabilities", "A network cable", "A password list"], 0]
  ],
  Advanced: [
    ["What is digital forensics?", ["Examining digital evidence", "Deleting logs", "Building websites"], 0],
    ["What does chain of custody record?", ["Evidence handling and transfers", "Employee attendance", "Website traffic"], 0],
    ["What is memory forensics?", ["Examining volatile memory", "Repairing a hard drive", "Scanning paper"], 0],
    ["What is a hash collision?", ["Different inputs producing the same hash", "A server crash", "A password reset"], 0],
    ["What is an IOC in cybersecurity?", ["Indicator of Compromise", "Internet Operating Code", "Internal Online Connection"], 0],
    ["What is the principle of least privilege?", ["Giving only necessary access", "Giving everyone admin rights", "Sharing passwords"], 0],
    ["What is SIEM used for?", ["Collecting and analyzing security events", "Editing images", "Compressing files"], 0],
    ["What is a sandbox?", ["An isolated environment for testing", "A password manager", "A network cable"], 0],
    ["What is an incident response plan?", ["A documented approach to handling security incidents", "A marketing plan", "A backup drive"], 0],
    ["What is file integrity monitoring?", ["Detecting unauthorized file changes", "Improving internet speed", "Creating accounts"], 0]
  ]
};

function cleanName(value) {
  return String(value || "Player").trim().replace(/[<>]/g, "").slice(0, 20) || "Player";
}

function makeCode() {
  let code;
  do {
    code = crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
}

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    name: p.name,
    score: p.score,
    isHost: p.id === room.hostId,
    answered: p.answered
  }));
}

function sendRoomUpdate(room) {
  io.to(room.code).emit("room:update", {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    players: publicPlayers(room),
    level: room.level
  });

  clearTimeout(room.expiryTimer);

  room.expiryTimer = setTimeout(() => {
    if (rooms.get(room.code) !== room) return;

    clearTimeout(room.timer);
    io.to(room.code).emit("room:expired", {
      message: "This room expired due to inactivity."
    });

    rooms.delete(room.code);
  }, 30 * 60 * 1000);

  room.expiryTimer.unref?.();
}

function sendQuestion(room) {
  const q = room.questions[room.index];
  room.status = "playing";
  room.players.forEach(p => p.answered = false);

  io.to(room.code).emit("round:question", {
    number: room.index + 1,
    total: room.questions.length,
    question: q[0],
    options: q[1],
    seconds: 30
  });

  clearTimeout(room.timer);
  room.timer = setTimeout(() => revealAnswer(room), 30000);
  sendRoomUpdate(room);
}

function revealAnswer(room) {
  if (!room || room.status !== "playing") return;

  clearTimeout(room.timer);
  room.status = "review";
  const q = room.questions[room.index];

  io.to(room.code).emit("round:result", {
    correctIndex: q[2],
    correctAnswer: q[1][q[2]],
    leaderboard: publicPlayers(room)
      .sort((a, b) => b.score - a.score)
  });

  sendRoomUpdate(room);
}

function finishRoom(room) {
  clearTimeout(room.timer);
  room.status = "finished";

  const leaderboard = publicPlayers(room).sort((a, b) => b.score - a.score);

  io.to(room.code).emit("game:finished", {
    leaderboard,
    winner: leaderboard[0] || null
  });

  sendRoomUpdate(room);
}

io.on("connection", socket => {
  socket.data.dcoRateLimits = new Map();

  socket.use((packet, next) => {
    const event = packet[0];
    const now = Date.now();
    const limits = {
      "room:create": { max: 5, window: 60000 },
      "room:join": { max: 10, window: 60000 },
      "round:answer": { max: 15, window: 60000 },
      "room:start": { max: 5, window: 60000 },
      "room:next": { max: 10, window: 60000 }
    };

    const rule = limits[event];
    if (!rule) return next();

    const previous = socket.data.dcoRateLimits.get(event) || [];
    const recent = previous.filter(t => now - t < rule.window);

    if (recent.length >= rule.max) {
      return next(new Error("Too many requests. Please wait and try again."));
    }

    recent.push(now);
    socket.data.dcoRateLimits.set(event, recent);
    next();
  });

  console.log("Player connected:", socket.id);

  socket.on("room:create", (data = {}, reply = () => {}) => {
    const code = makeCode();
    const name = cleanName(data.name);

    const room = {
      code,
      hostId: socket.id,
      players: new Map(),
      status: "waiting",
      level: ["Beginner", "Intermediate", "Advanced"].includes(data.level)
        ? data.level : "Beginner",
      questions: [],
      index: 0,
      timer: null
    };

    room.players.set(socket.id, {
      id: socket.id,
      name,
      score: 0,
      answered: false
    });

    rooms.set(code, room);
    socket.join(code);
    reply({ ok: true, code });
    sendRoomUpdate(room);
  });

  socket.on("room:join", (data = {}, reply = () => {}) => {
    const code = String(data.code || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) return reply({ ok: false, message: "Room not found." });
    if (room.status !== "waiting") return reply({ ok: false, message: "This game has already started." });
    if (room.players.size >= 20) return reply({ ok: false, message: "Room is full." });

    const player = {
      id: socket.id,
      name: cleanName(data.name),
      score: 0,
      answered: false
    };

    room.players.set(socket.id, player);
    socket.join(code);
    reply({ ok: true, code });
    sendRoomUpdate(room);
  });

  socket.on("room:start", (data = {}, reply = () => {}) => {
    const room = rooms.get(String(data.code || "").toUpperCase());

    if (!room) return reply({ ok: false, message: "Room not found." });
    if (room.hostId !== socket.id) return reply({ ok: false, message: "Only the host can start." });
    if (room.players.size < 2) return reply({ ok: false, message: "At least two players are required." });
    if (room.status !== "waiting") return reply({ ok: false, message: "Game already started." });

    room.questions = [...bank[room.level]];
    for (let i = room.questions.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [room.questions[i], room.questions[j]] = [room.questions[j], room.questions[i]];
    }

    room.index = 0;
    room.players.forEach(p => p.score = 0);
    reply({ ok: true });
    sendQuestion(room);
  });

  socket.on("round:answer", (data = {}, reply = () => {}) => {
    const room = rooms.get(String(data.code || "").toUpperCase());
    if (!room || room.status !== "playing") return reply({ ok: false, message: "No active question." });

    const player = room.players.get(socket.id);
    if (!player || player.answered) return reply({ ok: false, message: "Answer already submitted or player not found." });

    const choice = Number(data.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice > 2) {
      return reply({ ok: false, message: "Invalid answer." });
    }

    player.answered = true;
    const correct = choice === room.questions[room.index][2];
    if (correct) player.score += 10;

    reply({ ok: true });

    if ([...room.players.values()].every(p => p.answered)) {
      revealAnswer(room);
    } else {
      sendRoomUpdate(room);
    }
  });

  socket.on("room:next", (data = {}, reply = () => {}) => {
    const room = rooms.get(String(data.code || "").toUpperCase());

    if (!room) return reply({ ok: false, message: "Room not found." });
    if (room.hostId !== socket.id) return reply({ ok: false, message: "Only the host can continue." });
    if (room.status !== "review") return reply({ ok: false, message: "Wait for the round to finish." });

    room.index++;
    if (room.index >= room.questions.length) {
      finishRoom(room);
    } else {
      sendQuestion(room);
    }

    reply({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      if (!room.players.has(socket.id)) continue;

      room.players.delete(socket.id);

      if (room.players.size === 0) {
        clearTimeout(room.timer);
        rooms.delete(code);
        continue;
      }

      if (room.hostId === socket.id) {
        room.hostId = room.players.keys().next().value;
        io.to(code).emit("room:host-changed", { message: "The host role has been transferred." });
      }

      if (room.status === "playing" && [...room.players.values()].every(p => p.answered)) {
        revealAnswer(room);
      }

      sendRoomUpdate(room);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`DCO CyberQuiz server running on port ${PORT}`);
});
