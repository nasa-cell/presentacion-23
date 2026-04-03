# 🚀 CONESION 2.0 - Render Deployment Guide

## 🎬 Wireless Multimedia Presentation System

**Features:**
- Images + Video MP4/WEBM streaming
- Real-time sync control ↔ screen
- Delete × button
- 500MB uploads
- Manual navigation (no auto-advance)

## ☁️ RENDER DEPLOY (5 min)

### 1. GitHub Repo
```
git init
git add .
git commit -m "CONESION 2.0 Render ready"
git branch -M main
git remote add origin https://github.com/TU_USER/conesion.git
git push -u origin main
```

### 2. Render.com
1. render.com → New Web Service
2. Connect GitHub repo `conesion`
3. **Settings:**
   - Runtime: `Node`
   - Build: `npm install`
   - Start: `npm start`
   - Plan: Free

4. **Deploy → LIVE URL** (ej: conesion-abc.onrender.com)

### 3. USO en Render
```
📱 Control: https://tu-app.onrender.com/control
📺 Pantalla: https://tu-app.onrender.com/pantalla
```

**Nota:** Render storage temporal (uploads perdidos en restarts). Para persistente: Add PostgreSQL + Prisma.

## 🏠 Local Dev
```
npm install
node server.js
Control: http://localhost:3000/control
Pantalla: http://localhost:3000/pantalla
WiFi: http://192.168.x.x:3000/*
```

## 📱 Mobile WiFi
```
ipconfig  # Windows IP
Control: http://192.168.1.x:3000/control (celular)
Pantalla: http://192.168.1.x:3000/pantalla (TV)
```

**¡Render LIVE en minutos!** ☁️🎬
