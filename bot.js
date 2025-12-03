const fs = require('fs');
const tmi = require('tmi.js');
const { Client } = require('pg');

// ⚙️ Variables de entorno (Railway)
const BOT_USERNAME = process.env.BOT_USERNAME || 'Amsius';   // Usuario del bot
const OAUTH_TOKEN  = process.env.OAUTH_TOKEN  || 'oauth:TOKEN';
const CHANNEL_NAME = process.env.CHANNEL_NAME || 'Neranyel'; // Canal donde funcionará
const DATABASE_URL = process.env.DATABASE_URL || null;

// --- Memoria del bot en RAM ---
const memoriaChat = [];
const LIMITE_MEMORIA = 20000;
const PATH_MEMORIA = './memoria.json';

// Contador de mensajes de otros usuarios
let contadorMensajes = 0;

// Historial de últimos mensajes que el bot ha dicho (anti-repetición)
let ultimosMensajesBot = []; // guarda últimos 5 mensajes enviados por el bot

// --- Base de datos PostgreSQL ---
let dbClient = null;
let usaDB = false;

function initDB() {
  if (!DATABASE_URL) {
    console.log('DATABASE_URL no configurado, usando archivo como memoria.');
    cargarMemoriaDesdeArchivo();
    return;
  }

  dbClient = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  dbClient.connect((err) => {
    if (err) {
      console.error('Error al conectar a la DB. Usando archivo:', err);
      cargarMemoriaDesdeArchivo();
      return;
    }

    console.log('✅ Conectado a la base de datos.');
    usaDB = true;

    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS mensajes (
        id SERIAL PRIMARY KEY,
        texto TEXT NOT NULL,
        creado_en TIMESTAMPTZ DEFAULT NOW()
      );
    `;

    dbClient.query(createTableSQL, (err2) => {
      if (err2) {
        console.error('Error creando/verificando tabla. Usando archivo:', err2);
        usaDB = false;
        cargarMemoriaDesdeArchivo();
        return;
      }

      console.log('Tabla mensajes lista.');
      cargarMemoriaDesdeDB();
    });
  });
}

function cargarMemoriaDesdeArchivo() {
  if (!fs.existsSync(PATH_MEMORIA)) {
    console.log('No hay memoria previa. Empezando limpio.');
    return;
  }

  try {
    const data = fs.readFileSync(PATH_MEMORIA, 'utf8');
    const arr = JSON.parse(data);

    if (Array.isArray(arr)) {
      memoriaChat.push(...arr.slice(-LIMITE_MEMORIA));
      console.log(`Memoria cargada desde archivo: ${memoriaChat.length} mensajes.`);
    }
  } catch (err) {
    console.error('Error leyendo memoria, eliminando archivo dañado:', err);
    try { fs.unlinkSync(PATH_MEMORIA); } catch {}
  }
}

function guardarMemoriaEnArchivo() {
  const data = JSON.stringify(memoriaChat, null, 2);
  fs.writeFile(PATH_MEMORIA, data, (err) => {
    if (err) console.error('Error guardando memoria en archivo:', err);
  });
}

function cargarMemoriaDesdeDB() {
  const sql = `
    SELECT texto
    FROM mensajes
    ORDER BY id DESC
    LIMIT $1;
  `;

  dbClient.query(sql, [LIMITE_MEMORIA], (err, res) => {
    if (err) {
      console.error('Error cargando memoria de DB:', err);
      cargarMemoriaDesdeArchivo();
      return;
    }

    for (let i = res.rows.length - 1; i >= 0; i--) {
      memoriaChat.push(res.rows[i].texto);
    }

    console.log(`Memoria cargada desde DB: ${memoriaChat.length} mensajes.`);
  });
}

function guardarMensaje(msg) {
  memoriaChat.push(msg);
  if (memoriaChat.length > LIMITE_MEMORIA) memoriaChat.shift();

  if (usaDB && dbClient) {
    dbClient.query('INSERT INTO mensajes (texto) VALUES ($1);', [msg], (err) => {
      if (err) console.error('Error guardando mensaje en DB:', err);
    });
  } else {
    guardarMemoriaEnArchivo();
  }
}

// 🧠 Lógica de aprendizaje con tus reglas
function aprender(msg, lower, botLower) {
  if (msg.length < 2) return;

  // ❌ No aprender comandos que empiezan con "!"
  if (msg.startsWith('!')) return;

  // ❌ No aprender mensajes que mencionen al bot (@Amsius)
  if (lower.includes('@' + botLower)) return;

  guardarMensaje(msg);
}

// 🧠 Seleccionar una frase aprendida evitando repeticiones recientes
function fraseAprendida() {
  if (memoriaChat.length === 0) return null;

  // Filtrar mensajes que NO estén en los últimos 5 enviados
  const disponibles = memoriaChat.filter(msg => !ultimosMensajesBot.includes(msg));

  // Si no hay suficientes, usar toda la memoria
  const lista = disponibles.length > 0 ? disponibles : memoriaChat;

  const idx = Math.floor(Math.random() * lista.length);
  const frase = lista[idx];

  // Guardar la frase en el historial anti-repetición
  ultimosMensajesBot.push(frase);
  if (ultimosMensajesBot.length > 5) {
    ultimosMensajesBot.shift(); // mantener tamaño máximo 5
  }

  return frase;
}

// Inicializar DB / memoria
initDB();

// 🧠 Cliente del bot
const client = new tmi.Client({
  identity: {
    username: BOT_USERNAME,
    password: OAUTH_TOKEN
  },
  channels: [CHANNEL_NAME],
  options: { debug: true }
});

client.connect();

// 🗨️ Evento de mensaje
client.on('message', (channel, tags, message, self) => {
  if (self) return;

  // ❌ Ignorar mensajes de otros bots
  const username = (tags.username || '').toLowerCase();
  const botsIgnorados = ['nightbot', 'streamelements', 'tangiabot'];
  if (botsIgnorados.includes(username)) return;

  const msg = message.trim();
  const lower = msg.toLowerCase();
  const botLower = BOT_USERNAME.toLowerCase();

  // Contar mensajes de usuarios (no bots, no el bot mismo)
  contadorMensajes++;

  // Aprender con filtros
  aprender(msg, lower, botLower);

  // Si mencionan al bot → responde con algo aprendido inmediatamente
  if (lower.includes('@' + botLower)) {
    const frase = fraseAprendida();
    if (frase) client.say(channel, frase);
    return;
  }

  // 📌 Modo contador: cada 15 mensajes manda algo aprendido
  if (contadorMensajes >= 15) {
    const frase = fraseAprendida();
    if (frase) {
      client.say(channel, frase);
    }
    contadorMensajes = 0; // reiniciar contador
  }
});
