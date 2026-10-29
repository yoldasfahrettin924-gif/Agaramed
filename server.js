const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

const PORT = process.env.PORT || 3000;

// Statik dosyaları hem ana dizinden hem de public klasöründen sun
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Ana sayfaya girildiğinde index.html'i aç
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
        if (err) {
            res.sendFile(path.join(__dirname, 'index.html'));
        }
    });
});

// Oyun sunucu mantığı (Agar.io tarzı hücre verileri)
const players = {};
const foods = [];
const MAP_SIZE = 2000;

// Başlangıç yemlerini oluştur
for (let i = 0; i < 200; i++) {
    foods.push({
        id: i,
        x: Math.floor(Math.random() * MAP_SIZE),
        y: Math.floor(Math.random() * MAP_SIZE),
        color: `hsl(${Math.random() * 360}, 100%, 50%)`
    });
}

io.on('connection', (socket) => {
    console.log('Yeni oyuncu bağlandı:', socket.id);

    // Yeni oyuncuyu ekle
    players[socket.id] = {
        x: Math.floor(Math.random() * MAP_SIZE),
        y: Math.floor(Math.random() * MAP_SIZE),
        radius: 20,
        color: `hsl(${Math.random() * 360}, 100%, 50%)`,
        name: 'Oyuncu'
    };

    // İlk verileri gönder
    socket.emit('init', { id: socket.id, players, foods, mapSize: MAP_SIZE });
    socket.broadcast.emit('newPlayer', { id: socket.id, player: players[socket.id] });

    // Oyuncu hareket girişi
    socket.on('playerMove', (data) => {
        if (players[socket.id]) {
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            socket.broadcast.emit('playerMoved', { id: socket.id, x: data.x, y: data.y });
        }
    });

    // Oyuncu ayrıldığında
    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

http.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
});
