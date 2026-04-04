const compression = require('compression');
const helmet = require('helmet');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs/promises');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["websocket"]
});

app.set('trust proxy', 1);

// === MULTER ===
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Tipo no permitido: ${file.mimetype}`), false);
  }
});

// === MIDDLEWARE ===
app.use(helmet());
app.use(compression());
app.use(express.static(path.join(__dirname), { 
  etag: false,
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  }
}));
app.use(express.json({ limit: '500mb' }));
app.use('/uploads', express.static('uploads'));

// === DB ===
let db;
async function initDb() {
  const adapter = new JSONFile('db.json');
  db = new Low(adapter, { files: [], currentIndex: 0 });
  await db.read();
  db.data ||= { files: [], currentIndex: 0 };
  await db.write();
  console.log(`🗄️ DB ready: ${db.data.files.length} files`);
}

// === ROUTES ===
app.get('/', (req, res) => res.redirect('/pantalla.html'));
['control', 'pantalla.html', 'pantalla', 'test-upload.html'].forEach(route => {
  app.get(`/${route}`, (req, res) => res.sendFile(path.join(__dirname, route === 'control' ? 'control.html' : route)));
});

app.get('/api/media', async (req, res) => {
  await db.read();
  res.json(db.data);
});

app.put('/api/media/current', async (req, res) => {
  const { index } = req.body;
  await db.read();
  db.data.currentIndex = Math.max(0, Math.min(index, (db.data.files?.length || 0) - 1));
  await db.write();
  io.emit('media:current', db.data.currentIndex);
  res.json({ success: true });
});

app.post('/api/upload', upload.array('files', 10), async (req, res) => {
  try {
    await db.read();
    const results = [];
    await fs.mkdir('uploads', { recursive: true });
    
    for (const file of req.files) {
      const id = uuidv4();
      const ext = path.extname(file.originalname).toLowerCase();
      const filename = `${id}${ext}`;
      await fs.writeFile(path.join('uploads', filename), file.buffer);
      const type = file.mimetype.startsWith('video/') ? 'video' : 'image';
      db.data.files.push({ id, filename, type, path: `/uploads/${filename}` });
      results.push({ id, filename, type });
    }
    
    await db.write();
    io.emit('media:list', db.data.files);
    io.emit('media:state', db.data);
    res.json({ success: true, files: results });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/media/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const index = db.data.files.findIndex(f => f.id === id);
    if (index === -1) return res.status(404).json({ error: 'Not found' });
    
    const file = db.data.files[index];
    await fs.unlink(path.join('uploads', path.basename(file.path)));
    db.data.files.splice(index, 1);
    if (db.data.currentIndex >= db.data.files.length) db.data.currentIndex = 0;
    
    await db.write();
    io.emit('media:list', db.data.files);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/media/:filename', async (req, res) => {
  try {
    const filepath = path.join(__dirname, 'uploads', req.params.filename);
    const stat = await fs.stat(filepath);
    const range = req.headers.range;
    
    if (!range) {
      const stream = require('fs').createReadStream(filepath);
      res.set({
        'Content-Type': req.params.filename.includes('.mp4') ? 'video/mp4' : 'image/jpeg',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      });
      stream.pipe(res);
      return;
    }
    
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunksize = (end - start) + 1;
    
    const stream = require('fs').createReadStream(filepath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache'
    });
    stream.pipe(res);
  } catch (err) {
    res.status(404).send('Not found');
  }
});

// === SOCKET.IO ===
io.on('connection', (socket) => {
  console.log('👤 Connected:', socket.id);
  
  socket.on("register", (role) => {
    socket.join(role);
    socket.emit("role", role);
    console.log("Client registered as:", role);
  });
  
  socket.emit('media:state', db.data);
  
  socket.on('nav:next', async () => {
    await db.read();
    db.data.currentIndex = (db.data.currentIndex + 1) % (db.data.files.length || 1);
    await db.write();
    io.emit('media:set', db.data.currentIndex);
  });
  
  socket.on('nav:prev', async () => {
    await db.read();
    db.data.currentIndex = (db.data.currentIndex - 1 + db.data.files.length) % (db.data.files.length || 1);
    await db.write();
    io.emit('media:set', db.data.currentIndex);
  });
  
  socket.on('media:set', async (index) => {
    await db.read();
    db.data.currentIndex = index;
    await db.write();
    io.emit('media:set', index);
  });
  
  socket.on('video:play', () => io.to('screen').emit('video:play'));
  socket.on('video:pause', () => io.to('screen').emit('video:pause'));
  
  socket.on('disconnect', () => console.log('👋 Disconnected:', socket.id));
});

initDb().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server on port ${PORT}`);
    console.log('Control: /control');
    console.log('Screen: /pantalla.html');
  });
}).catch(console.error);

