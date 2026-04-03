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
  cors: { origin: '*', methods: ['GET', 'POST', 'DELETE', 'PUT'] }
});

// === MULTER CONFIG - 500MB limit, allowed types ===
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg', 'image/png', 'image/webp',
      'video/mp4', 'video/webm', 'video/quicktime'
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Tipo no permitido: ${file.mimetype}`), false);
  }
});

// === MIDDLEWARE ===
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      connectSrc: ["'self'", 'ws:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'"]
    }
  }
}));
app.use(compression());
app.use(express.static('.'));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// === DB INIT ===
let db;
async function initDb() {
  const adapter = new JSONFile('db.json');
  db = new Low(adapter, { files: [], currentIndex: 0 });
  await db.read();
  if (!db.data || !db.data.files) {
    db.data = { files: [], currentIndex: 0 };
  } else if (db.data.images) {
    // Migrate old schema
    db.data.files = db.data.images.map(img => ({
      id: img.id,
      filename: path.basename(img.url),
      type: img.type,
      path: img.url
    }));
    db.data.currentIndex = 0;
    delete db.data.images;
  }
  await db.write();
  console.log(`🗄️ DB ready: ${db.data.files.length} files`);
}

// === ROUTES ===
app.get('/', (req, res) => res.redirect('/pantalla.html'));
app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'control.html')));
app.get('/pantalla.html', (req, res) => res.sendFile(path.join(__dirname, 'pantalla.html')));
app.get('/pantalla', (req, res) => res.redirect('/pantalla.html'));
app.get('/test-upload', (req, res) => res.sendFile(path.join(__dirname, 'test-upload.html')));

// API: Get all files + current index
app.get('/api/media', async (req, res) => {
  await db.read();
  res.json(db.data);
});

// API: Set current index
app.put('/api/media/current', async (req, res) => {
  const { index } = req.body;
  await db.read();
  db.data.currentIndex = Math.max(0, Math.min(index, db.data.files.length - 1));
  await db.write();
  io.emit('media:current', db.data.currentIndex);
  res.json({ success: true });
});

// UPLOAD
app.post('/api/upload', upload.array('files', 10), async (req, res) => {
  try {
    await db.read();
    console.log(`📤 Upload: ${req.files.length} files`);
    const results = [];
    
    await fs.mkdir('uploads', { recursive: true });
    
    for (const file of req.files) {
      const id = uuidv4();
      const ext = path.extname(file.originalname).toLowerCase();
      const filename = `${id}${ext}`;
      const filepath = path.join('uploads', filename);
      const type = file.mimetype.startsWith('video/') ? 'video' : 'image';
      
      await fs.writeFile(filepath, file.buffer);
      db.data.files.push({ id, filename, type, path: `/uploads/${filename}` });
      results.push({ id, filename, type });
    }
    
    await db.write();
    io.to('screen').emit('media:list', db.data.files);
    io.to('control').emit('media:list', db.data.files);
    console.log(`✅ ${results.length} files uploaded`);
    res.json({ success: true, files: results });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE file
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

// 🎥 VIDEO STREAMING - CRITICAL RANGE SUPPORT
app.get('/media/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filepath = path.join(__dirname, 'uploads', filename);
    
    const stat = await fs.stat(filepath);
    const range = req.headers.range;
    
    if (!range) {
      // Full file
      const stream = require('fs').createReadStream(filepath);
      res.set({
        'Cache-Control': 'public, max-age=3600',

        'Content-Type': filename.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      });
      stream.pipe(res);
      return;
    }
    
    // Partial range request (video seeking)
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunksize = (end - start) + 1;
    
    const stream = require('fs').createReadStream(filepath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': filename.includes('.mp4') ? 'video/mp4' : 'image/jpeg',
      'Cache-Control': 'no-cache'
    });
    stream.pipe(res);
  } catch (err) {
    console.error('Media stream error:', err);
    res.status(404).send('Media not found');
  }
});

// === SOCKET.IO - ROOMS: 'control' & 'screen' ===
io.on('connection', (socket) => {
  console.log('👤 Client connected:', socket.id);
  
  // Auto-assign room based on path
  const url = socket.handshake.headers.referer || '';
  if (url.includes('/control')) {
    socket.join('control');
    socket.emit('role', 'control');
    console.log('📱 Control joined');
  } else {
    socket.join('screen');
    socket.emit('role', 'screen');
    console.log('📺 Screen joined');
  }
  
  // Load initial state
  socket.emit('media:state', db.data);
  
  // CONTROL events
  socket.on('nav:next', async () => {
    await db.read();
    if (db.data.files && db.data.files.length > 0) {
      db.data.currentIndex = (db.data.currentIndex + 1) % db.data.files.length;
      await db.write();
      io.emit('media:set', db.data.currentIndex);
    }
  });
  
  socket.on('nav:prev', async () => {
    await db.read();
    if (db.data.files && db.data.files.length > 0) {
      db.data.currentIndex = (db.data.currentIndex - 1 + db.data.files.length) % db.data.files.length;
      await db.write();
      io.emit('media:set', db.data.currentIndex);
    }
  });
  
  socket.on('media:set', (index) => {
    db.data.currentIndex = index;
    db.write();
    io.emit('media:set', index);
  });
  
  socket.on('video:play', () => io.to('screen').emit('video:play'));
  socket.on('video:pause', () => io.to('screen').emit('video:pause'));
  
  socket.on('disconnect', () => console.log('👋 Disconnected:', socket.id));
});

initDb().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 CONESION ready on http://localhost:${PORT}`);
    console.log('📱 Control: /control');
    console.log('📺 Screen: /pantalla');
  });
});
