const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// In-Memory Card Catalog (No MongoDB needed)
const CARD_CATALOG = [
    { id: 'knight', name: '🛡️ Knight', hp: 140, atk: 18, spd: 2, icon: '🛡️' },
    { id: 'archer', name: '🏹 Archer', hp: 70, atk: 22, spd: 4, icon: '🏹' },
    { id: 'tnt', name: '💣 TNT', hp: 40, atk: 60, spd: 1, icon: '💣' },
    { id: 'goose', name: '🪿 Goose Army', hp: 55, atk: 10, spd: 5, icon: '🪿' }
];

let waitingPlayer = null;
let rooms = {};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Matchmaking Queue
    socket.on('joinMatchmaking', (username) => {
        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            const roomId = `room_${Date.now()}`;
            const player1 = waitingPlayer;
            const player2 = { id: socket.id, name: username || 'Player 2' };

            rooms[roomId] = {
                id: roomId,
                p1: { id: player1.id, name: player1.name, hp: 3, deck: [], chosen: null },
                p2: { id: player2.id, name: player2.name, hp: 3, deck: [], chosen: null },
                round: 1,
                draftOptions: {},
                phase: 'draft',
                draftCount: 0
            };

            player1.socket.join(roomId);
            socket.join(roomId);

            waitingPlayer = null;
            generateDraftChoices(roomId);
        } else {
            waitingPlayer = { id: socket.id, name: username || 'Player 1', socket: socket };
            socket.emit('waiting', 'Searching for an opponent...');
        }
    });

    // Handle Draft Picks
    socket.on('pickCard', ({ roomId, cardId }) => {
        const room = rooms[roomId];
        if (!room || room.phase !== 'draft') return;

        const isP1 = socket.id === room.p1.id;
        const player = isP1 ? room.p1 : room.p2;

        if (player.chosen) return; // Prevent double selecting

        const selectedCard = CARD_CATALOG.find(c => c.id === cardId);
        if (selectedCard) {
            player.deck.push({ ...selectedCard, currentHP: selectedCard.hp });
            player.chosen = selectedCard;
            
            io.to(roomId).emit('playerPicked', { playerId: socket.id });
            checkDraftCompletion(roomId);
        }
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
        }
        console.log(`User disconnected: ${socket.id}`);
    });
});

function generateDraftChoices(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.p1.chosen = null;
    room.p2.chosen = null;

    // Give random cards to pick from
    room.draftOptions = {
        p1Options: [CARD_CATALOG[Math.floor(Math.random() * CARD_CATALOG.length)], CARD_CATALOG[Math.floor(Math.random() * CARD_CATALOG.length)]],
        p2Options: [CARD_CATALOG[Math.floor(Math.random() * CARD_CATALOG.length)], CARD_CATALOG[Math.floor(Math.random() * CARD_CATALOG.length)]]
    };

    io.to(roomId).emit('startDraftPhase', {
        roomId: room.id,
        round: room.round,
        p1: { id: room.p1.id, name: room.p1.name, hp: room.p1.hp, deck: room.p1.deck },
        p2: { id: room.p2.id, name: room.p2.name, hp: room.p2.hp, deck: room.p2.deck },
        options: room.draftOptions
    });
}

function checkDraftCompletion(roomId) {
    const room = rooms[roomId];
    if (room.p1.chosen && room.p2.chosen) {
        room.draftCount++;
        if (room.draftCount >= 3) {
            // Completed 3 drafting rounds -> Start Battle execution
            room.draftCount = 0;
            runBattleSimulation(roomId);
        } else {
            // Go to next drafting draw item
            generateDraftChoices(roomId);
        }
    }
}

function runBattleSimulation(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.phase = 'battle';
    let p1BattleDeck = room.p1.deck.map(c => ({ ...c, team: 'p1' }));
    let p2BattleDeck = room.p2.deck.map(c => ({ ...c, team: 'p2' }));
    let combatLog = [];
    let limit = 0;

    while (p1BattleDeck.length > 0 && p2BattleDeck.length > 0 && limit < 30) {
        limit++;
        let activeUnits = [...p1BattleDeck, ...p2BattleDeck].sort((a, b) => b.spd - a.spd);

        for (let unit of activeUnits) {
            if (unit.currentHP <= 0) continue;

            if (unit.team === 'p1' && p2BattleDeck.length > 0) {
                let target = p2BattleDeck[0];
                target.currentHP -= unit.atk;
                combatLog.push({ text: `${unit.name} attacks Enemy ${target.name} for ${unit.atk} DMG!` });
                if (target.currentHP <= 0) {
                    combatLog.push({ text: `💀 Enemy ${target.name} fell in combat!` });
                    p2BattleDeck.shift();
                }
            } else if (unit.team === 'p2' && p1BattleDeck.length > 0) {
                let target = p1BattleDeck[0];
                target.currentHP -= unit.atk;
                combatLog.push({ text: `❌ Enemy ${unit.name} attacks Your ${target.name} for ${unit.atk} DMG!` });
                if (target.currentHP <= 0) {
                    combatLog.push({ text: `💀 Your ${target.name} fell in combat!` });
                    p1BattleDeck.shift();
                }
            }
        }
    }

    // Process HP Deduction
    let roundWinner = 'draw';
    if (p1BattleDeck.length > 0 && p2BattleDeck.length === 0) {
        room.p2.hp--;
        roundWinner = 'p1';
    } else if (p2BattleDeck.length > 0 && p1BattleDeck.length === 0) {
        room.p1.hp--;
        roundWinner = 'p2';
    }

    io.to(roomId).emit('battleResults', {
        log: combatLog,
        winner: roundWinner,
        p1Hp: room.p1.hp,
        p2Hp: room.p2.hp
    });

    // Next round reset logic or terminal ending check
    if (room.p1.hp <= 0 || room.p2.hp <= 0) {
        io.to(roomId).emit('gameOver', { winner: room.p1.hp > 0 ? room.p1.name : room.p2.name });
        delete rooms[roomId];
    } else {
        room.round++;
        room.p1.deck = [];
        room.p2.deck = [];
        room.phase = 'draft';
        setTimeout(() => { generateDraftChoices(roomId); }, 6000); // 6s window for viewing log animations
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Game engine live on port ${PORT}`));
