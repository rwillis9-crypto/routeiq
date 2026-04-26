# 🗺️ RouteIQ — AI Sales Trip Planner

A mobile-friendly web app for planning daily sales routes from your Google My Maps data. Built with React + Vite, powered by Groq AI (free), deployed on GitHub Pages.

---

## 🚀 One-Time Setup (15 minutes)

### Step 1 — Install Node.js
Download and install from [nodejs.org](https://nodejs.org) (LTS version).
Verify: open Terminal / Command Prompt and run:
```
node --version
```

---

### Step 2 — Create your GitHub repository
1. Go to [github.com](https://github.com) → sign in or create a free account
2. Click **"New repository"**
3. Name it `routeiq` (or whatever you like)
4. Set to **Public**
5. **Do NOT** check "Add a README" — leave it empty
6. Click **Create repository**

---

### Step 3 — Update the repo name in vite.config.js
Open `vite.config.js` and change `'/routeiq/'` to match your repository name:
```js
base: '/your-repo-name/',
```

---

### Step 4 — Enable GitHub Pages
1. In your GitHub repo → **Settings** → **Pages**
2. Under **Source**, select **GitHub Actions**
3. Click Save

---

### Step 5 — Push the project to GitHub
Open Terminal / Command Prompt in the `routeiq` folder and run:
```bash
npm install
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/routeiq.git
git push -u origin main
```
Replace `YOUR_USERNAME` with your GitHub username.

---

### Step 6 — Wait ~2 minutes, then open your app
GitHub will automatically build and deploy your app.
Your URL will be: **https://YOUR_USERNAME.github.io/routeiq/**

Check progress: GitHub repo → **Actions** tab → watch the workflow run.

---

## 📱 Using the App

### First time:
1. **📂 Data tab** → Upload your `Rob_FY26_GA_Mapping.kml`
2. Click **"Geocode Addresses"** → ~25 min (leave tab open, progress is saved every 20 addresses)
3. Add your **Groq API key** (free at [console.groq.com/keys](https://console.groq.com/keys)) for AI routing
4. Once geocoded → click **"Export Backup"** and save the JSON file

### Cross-device sync:
After geocoding on your PC, import the backup JSON on your iPad/iPhone so you don't have to re-geocode.
- iPad/iPhone → open your GitHub Pages URL in Safari → Data tab → Import Backup

### Planning a trip:
1. **🗺️ Map tab** → zoom in, click pins, tap "Add to Trip" in popups
2. OR **⚡ Plan tab** → filter by category, set date/start/stops, hit Plan
3. Save trip → view in **📋 History tab**
4. "View on Map" from any saved trip to see the route plotted

---

## 🔑 Groq API Key (Free)
1. Go to [console.groq.com/keys](https://console.groq.com/keys)
2. Sign up with Google or email (free, no credit card)
3. Click **"Create API Key"**
4. Paste it into the app's Data tab → stored locally on your device only

Without a key, the app uses a built-in nearest-neighbor routing algorithm (still useful, just less smart).

---

## 🔄 Updating the App
Any time you make changes and push to GitHub, it auto-deploys:
```bash
git add .
git commit -m "Your change description"
git push
```

---

## 📁 Project Structure
```
routeiq/
├── .github/workflows/deploy.yml  ← Auto-deploy to GitHub Pages
├── src/
│   ├── App.jsx                   ← Main application
│   ├── main.jsx                  ← React entry point
│   └── index.css                 ← Global styles + Tailwind
├── index.html                    ← HTML shell
├── vite.config.js                ← Build config (update base path here)
├── tailwind.config.js
├── postcss.config.js
└── package.json
```

---

## 🗺️ KML Export Instructions (Google My Maps)
1. Open your map at [mymaps.google.com](https://mymaps.google.com)
2. Click the **three-dot menu (⋮)** next to your map title
3. Click **"Export to KML/KMZ"**
4. In the dialog:
   - ✅ Check **"Export as KML instead of KMZ"**
   - ❌ Uncheck "Keep data up to date with network link"
   - Select layer or "Entire map"
5. Click **Download**
6. Upload the `.kml` file in the app's Data tab

---

Built with React, Vite, Tailwind CSS, Leaflet, and Groq AI.
