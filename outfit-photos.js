// ─────────────────────────────────────────────────────────────────────────────
// outfit-photos.js
//
// Drop-in plugin that adds a third inventory option to "idk what to wear":
// users can upload photos of outfits they've already worn. The plugin extracts
// dominant colours from each photo client-side and feeds them into the existing
// analysis pipeline.
//
// INSTALL (in your index.html):
//   1. After the const state = { ... }; declaration, add:
//        window.__idkBridge = { state, save, COLORS, colorHex, uid };
//   2. Just before </body>, add:
//        <script src="outfit-photos.js"></script>
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  function whenReady(cb) {
    if (window.__idkBridge && window.__idkBridge.state && window.__idkBridge.COLORS) cb();
    else setTimeout(() => whenReady(cb), 50);
  }
  whenReady(init);

  function init() {
    const bridge = window.__idkBridge;
    const state = bridge.state;
    const COLORS = bridge.COLORS;
    const colorHex = bridge.colorHex;
    const uid = bridge.uid;
    const save = bridge.save;

    if (!Array.isArray(state.outfitPhotos)) state.outfitPhotos = [];

    // ─── 1. Inject CSS ───
    const css = `
      .photo-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 10px;
        margin-top: 18px;
      }
      .photo-grid .ph {
        position: relative; aspect-ratio: 3 / 4;
        border: 1px solid var(--w-rule); border-radius: 4px;
        overflow: hidden; background: var(--w-paper);
      }
      .photo-grid .ph img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .photo-grid .ph .rm {
        position: absolute; top: 6px; right: 6px;
        width: 24px; height: 24px;
        background: var(--w-ink); color: var(--w-paper);
        border: none; border-radius: 50%;
        cursor: pointer; font-size: 13px; line-height: 1;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.15s;
      }
      .photo-grid .ph:hover .rm { opacity: 1; }
      .photo-grid .ph .colors {
        position: absolute; bottom: 0; left: 0; right: 0;
        height: 8px; display: flex; pointer-events: none;
      }
      .photo-grid .ph .colors span { flex: 1; height: 100%; }
      .photo-count {
        text-align: center; margin-top: 12px;
        font-family: var(--display); font-style: italic;
        color: var(--w-ink-faint); font-size: 14px;
      }
      .photo-progress {
        text-align: center; margin: 10px 0;
        font-family: var(--mono); font-size: 11px;
        letter-spacing: 0.14em; text-transform: uppercase;
        color: var(--w-accent);
      }
    `;
    const styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    // ─── 2. Add the third tab button ───
    const tabsRow = document.querySelector('#screen-input .tabs');
    if (tabsRow) {
      const btn = document.createElement('button');
      btn.className = 'tab';
      btn.dataset.tab = 'photos';
      btn.textContent = 'Upload outfit photos';
      btn.onclick = () => window.switchTab('photos');
      tabsRow.appendChild(btn);
    }

    // ─── 3. Insert the photos tab content after #tab-csv ───
    const csvTab = document.getElementById('tab-csv');
    if (csvTab && csvTab.parentNode) {
      const photosTab = document.createElement('div');
      photosTab.id = 'tab-photos';
      photosTab.className = 'hidden';
      photosTab.innerHTML = `
        <div class="upload-zone" id="photoDropZone">
          <div class="big-icon">⌘</div>
          <p><strong>Drop outfit photos here, or click to browse</strong></p>
          <p class="small" style="font-family:var(--display);font-style:italic">Bring 10–30 photos of looks you've actually worn</p>
          <p class="small" style="font-family:var(--display);font-style:italic">JPG · PNG · WebP · HEIC accepted</p>
          <input type="file" id="photoInput" accept="image/*" multiple style="display:none">
        </div>
        <div class="photo-progress" id="photoProgress" style="display:none"></div>
        <div class="photo-grid" id="photoGrid"></div>
        <div class="photo-count" id="photoCount"></div>
      `;
      csvTab.parentNode.insertBefore(photosTab, csvTab.nextSibling);

      const dropZone = photosTab.querySelector('#photoDropZone');
      const fileInput = photosTab.querySelector('#photoInput');
      dropZone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', e => handlePhotoUpload(e.target.files, fileInput));

      ['dragenter', 'dragover'].forEach(evt => {
        dropZone.addEventListener(evt, e => {
          e.preventDefault();
          dropZone.style.background = 'var(--w-accent-tint)';
          dropZone.style.borderColor = 'var(--w-accent)';
        });
      });
      ['dragleave', 'drop'].forEach(evt => {
        dropZone.addEventListener(evt, e => {
          e.preventDefault();
          dropZone.style.background = '';
          dropZone.style.borderColor = '';
        });
      });
      dropZone.addEventListener('drop', e => {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files) handlePhotoUpload(e.dataTransfer.files);
      });
    }

    // ─── 4. Hook into switchTab ───
    const originalSwitchTab = window.switchTab;
    window.switchTab = function (tab) {
      if (typeof originalSwitchTab === 'function') originalSwitchTab(tab);
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
      const photosTab = document.getElementById('tab-photos');
      if (photosTab) photosTab.classList.toggle('hidden', tab !== 'photos');
      if (tab === 'photos') renderPhotoGrid();
    };

    // ─── 5. Hook submitWardrobe — photos also count ───
    const originalSubmit = window.submitWardrobe;
    window.submitWardrobe = function () {
      const validItems = state.items.filter(i => i.name && i.color && i.tier);
      const photoCount = (state.outfitPhotos || []).length;
      if (validItems.length >= 3) return originalSubmit && originalSubmit();
      if (photoCount >= 3) {
        save();
        if (typeof window.goTo === 'function') window.goTo('analysis');
        return;
      }
      alert('Add at least three complete items or three outfit photos before producing a report.');
    };

    // ─── 6. Hook updateCount ───
    const originalUpdate = window.updateCount;
    window.updateCount = function () {
      const itemCount = state.items.filter(i => i.name && i.color && i.tier).length;
      const photoCount = (state.outfitPhotos || []).length;
      const el = document.getElementById('totalCount');
      if (el) el.textContent = itemCount + photoCount;
    };

    // ─── 7. Hook renderAnalysis to adapt the report for photo mode ───
    const originalRender = window.renderAnalysis;
    if (typeof originalRender === 'function') {
      window.renderAnalysis = function () {
        const photos = (state.outfitPhotos || []).filter(p => p.image);
        const realItems = state.items;
        const photoOnly = realItems.length === 0 && photos.length > 0;

        // In photo-only mode, synthesize ghost items so the existing analysis
        // pipeline has something to work with. When the AI returned real
        // garment categories for a photo, we use those; otherwise we default
        // to 'tops' which is just enough for colour aggregation.
        if (photoOnly) {
          const photoItems = [];
          photos.forEach(p => {
            const cats = (p.categories && p.categories.length) ? p.categories : ['tops'];
            const cols = (p.colors && p.colors.length) ? p.colors : ['black'];
            // Create one ghost per (category, primary colour) so category
            // counts reflect what's actually in the photos.
            const primary = cols[0];
            cats.forEach(cat => {
              photoItems.push({
                id: 'photo-' + Math.random().toString(36).slice(2),
                category: cat,
                name: 'outfit piece',
                tier: 'decent',
                color: primary,
                brand: '',
                occasion: []
              });
            });
            // Also add secondary colours as 'tops' ghost items so they still
            // appear in the colour donut without inflating category counts.
            cols.slice(1).forEach(c => {
              photoItems.push({
                id: 'photo-' + Math.random().toString(36).slice(2),
                category: 'tops',
                name: 'accent colour',
                tier: 'decent',
                color: c,
                brand: '',
                occasion: []
              });
            });
          });
          state.items = photoItems;
        }

        originalRender();
        state.items = realItems;

        // Hide brand-, name-, tier-, occasion-dependent sections
        const brandCard = document.querySelector('.chart-card.c2');
        const catColorWrap = document.getElementById('catColorCharts');
        const catChart = document.getElementById('catChart');
        const pairingsSection = document.querySelector('.section-h.s2');
        const pairingsCard = pairingsSection && pairingsSection.nextElementSibling;

        if (brandCard) brandCard.style.display = photoOnly ? 'none' : '';

        // Per-category colour donuts: SHOW in photo mode when AI categorised
        // the photos. Otherwise hide.
        const photosHaveCategories = photos.some(p => p.categories && p.categories.length);
        if (catColorWrap && catColorWrap.parentElement) {
          const showPerCat = !photoOnly || photosHaveCategories;
          catColorWrap.parentElement.style.display = showPerCat ? '' : 'none';
        }
        // Category & tier chart: needs tier data; hide in photo mode
        if (catChart) {
          const card = catChart.closest('.chart-card');
          if (card) card.style.display = photoOnly ? 'none' : '';
        }
        if (pairingsSection) pairingsSection.style.display = photoOnly ? 'none' : '';
        if (pairingsCard) pairingsCard.style.display = photoOnly ? 'none' : '';

        // Update stat labels
        const labels = document.querySelectorAll('#screen-analysis .stat .label');
        if (labels.length === 4) {
          labels[0].textContent = photoOnly ? 'Outfits' : 'Total pieces';
          labels[1].textContent = photoOnly ? 'Photos' : 'Favourites';
        }
        const statTotal = document.getElementById('stat-total');
        const statFaves = document.getElementById('stat-faves');
        if (photoOnly && statTotal) statTotal.textContent = photos.length;
        if (photoOnly && statFaves) statFaves.textContent = photos.length;

        injectPhotoGallery(photos);

        // In photo-only mode, suppress recommendations that depend on item
        // metadata (categories, names, tiers) — they generate false positives
        // because we don't know the garment type from a colour alone.
        if (photoOnly) {
          document.querySelectorAll('#optList .opt-card').forEach(card => {
            const t = (card.textContent || '').toLowerCase();
            const isFalsePositive =
              /no .* on record/.test(t) ||                  // "No bottoms on record"
              /foundation pieces? missing/.test(t) ||       // foundation list
              /top[- ]to[- ]bottom ratio/.test(t) ||        // ratio cards
              /skewed ratio/.test(t) ||
              /top[- ]heavy|top[- ]light/.test(t) ||
              /trouser[- ]forward/.test(t) ||
              /gentle edit is overdue/.test(t) ||           // tier-based
              /closet clean[- ]?out/.test(t) ||
              /zero .* on file/.test(t);
            if (isFalsePositive) card.remove();
          });
        }
      };
    }

    function injectPhotoGallery(photos) {
      const existing = document.getElementById('photo-gallery-block');
      if (existing) existing.remove();
      if (!photos.length) return;

      const sectionH = document.querySelector('#screen-analysis .section-h');
      if (!sectionH) return;

      const block = document.createElement('div');
      block.id = 'photo-gallery-block';
      block.style.cssText = 'margin-top:36px;';
      block.innerHTML = `
        <div class="section-h" style="margin-top:0">
          <div class="num">~</div>
          <h2>Your outfits</h2>
          <div class="meta">The Source Material</div>
        </div>
        <div class="photo-grid" style="margin-top:0">
          ${photos.map(p => `
            <div class="ph" style="cursor:default">
              <img src="${p.image}" alt="">
              <div class="colors">${(p.colors || []).map(c => {
                const hex = colorHex(c);
                const fill = typeof hex === 'string' && hex.startsWith('#') ? hex : '#bbb';
                return `<span style="background:${fill}"></span>`;
              }).join('')}</div>
            </div>
          `).join('')}
        </div>
      `;
      sectionH.parentNode.insertBefore(block, sectionH);
    }

    // ─── 8. Hook startOver to clear photos ───
    const originalStartOver = window.startOver;
    if (typeof originalStartOver === 'function') {
      window.startOver = function () {
        const ok = confirm('Clear the wardrobe and start fresh?');
        if (!ok) return;
        try { localStorage.removeItem('idkwtw-state'); } catch (e) {}
        state.items = [];
        state.outfitPhotos = [];
        try { originalStartOver(); } catch (e) {}
      };
    }

    // ─── 9. Photo upload pipeline ───
    async function handlePhotoUpload(fileList, fileInput) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      if (fileInput) fileInput.value = '';

      if (!Array.isArray(state.outfitPhotos)) state.outfitPhotos = [];

      // First photo upload of this session: silently clear any lingering manual
      // items (e.g. demo data from "See a sample report") so they don't pollute
      // the photo-mode analysis. Subsequent uploads append without clearing.
      if (state.outfitPhotos.length === 0 && state.items.length > 0) {
        state.items = [];
        if (state.outfits) state.outfits.length = 0;
        if (state.ratings) Object.keys(state.ratings).forEach(k => delete state.ratings[k]);
      }

      const progress = document.getElementById('photoProgress');
      if (progress) progress.style.display = 'block';

      const hasAi = !!getGeminiKey();
      let done = 0;
      for (const file of files) {
        if (!file.type.startsWith('image/')) { done++; continue; }
        if (progress) {
          progress.textContent = hasAi
            ? `Analysing photo ${done + 1} of ${files.length} with Gemini vision…`
            : `Processing ${done + 1} of ${files.length}…`;
        }
        try {
          const photo = await processPhoto(file);
          if (photo) state.outfitPhotos.push(photo);
          // Render after each photo so users see progress
          renderPhotoGrid();
        } catch (err) {
          console.warn('Photo failed:', file.name, err);
        }
        done++;
      }

      if (progress) progress.style.display = 'none';
      save();
      renderPhotoGrid();
      if (typeof window.updateCount === 'function') window.updateCount();
    }

    async function processPhoto(file) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = ev => resolve(ev.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });

      // Two output sizes:
      // - 800px stored for display
      // - 600px sent to vision AI (smaller payload, still plenty of detail)
      const renderCanvas = drawResized(img, 800);
      const heuristicColors = extractDominantColors(
        renderCanvas.getContext('2d'),
        renderCanvas.width,
        renderCanvas.height
      );
      const resized = renderCanvas.toDataURL('image/jpeg', 0.78);

      // Try real vision AI for accurate clothing colours + garment categories.
      let aiColors = null, aiCategories = null;
      try {
        const visionCanvas = drawResized(img, 600);
        const visionData = visionCanvas.toDataURL('image/jpeg', 0.72);
        const ai = await analyzePhotoWithAI(visionData);
        if (ai) {
          aiColors = ai.colors;
          aiCategories = ai.categories;
        }
      } catch (e) {
        console.warn('Vision AI failed for', file.name, '— falling back to heuristic', e);
      }

      return {
        id: uid(),
        filename: file.name,
        image: resized,
        colors: (aiColors && aiColors.length) ? aiColors : heuristicColors,
        categories: aiCategories || [],
        aiAnalyzed: !!aiColors,
        createdAt: Date.now()
      };
    }

    function drawResized(img, maxDim) {
      const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * ratio));
      const h = Math.max(1, Math.round(img.height * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      return canvas;
    }

    // ─── Vision AI via Google Gemini (free tier, no proxy needed) ───
    // The user provides their own API key from aistudio.google.com.
    // Stored in localStorage and reused; cleared if the API rejects it.

    const GEMINI_KEY_STORAGE = 'idkwtw-gemini-key';
    const GEMINI_REFUSED_STORAGE = 'idkwtw-gemini-refused'; // user said "no thanks" this session

    function getGeminiKey() {
      try { return localStorage.getItem(GEMINI_KEY_STORAGE) || ''; }
      catch (e) { return ''; }
    }
    function setGeminiKey(k) {
      try {
        if (k) localStorage.setItem(GEMINI_KEY_STORAGE, k);
        else localStorage.removeItem(GEMINI_KEY_STORAGE);
      } catch (e) {}
    }
    function userRefusedGemini() {
      try { return sessionStorage.getItem(GEMINI_REFUSED_STORAGE) === '1'; }
      catch (e) { return false; }
    }
    function setUserRefused() {
      try { sessionStorage.setItem(GEMINI_REFUSED_STORAGE, '1'); } catch (e) {}
    }

    function promptForGeminiKey() {
      const existing = getGeminiKey();
      const msg =
        'Enable real vision AI for outfit photo analysis?\n\n' +
        'You\'ll need a free Google Gemini API key (no credit card required):\n' +
        '  1. Open https://aistudio.google.com\n' +
        '  2. Sign in with Google → click "Get API key" → "Create API key"\n' +
        '  3. Paste the key below.\n\n' +
        'The key stays in your browser and is only sent to Google\'s API.\n' +
        'Click Cancel to skip and use the colour-only heuristic.';
      const k = window.prompt(msg, existing);
      if (k === null || !k.trim()) {
        setUserRefused();
        return '';
      }
      const trimmed = k.trim();
      setGeminiKey(trimmed);
      return trimmed;
    }

    async function analyzePhotoWithAI(dataUrl) {
      let key = getGeminiKey();
      if (!key && !userRefusedGemini()) key = promptForGeminiKey();
      if (!key) return null;

      const m = dataUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
      if (!m) return null;
      const mimeType = m[1];
      const data = m[2];

      const colourPalette = COLORS.map(c => c[0]).filter(n => !!n).join(', ');
      const prompt = `You are looking at a photo of an outfit a person is wearing. Identify:

1. The 1-3 dominant colours of the CLOTHING ONLY. Ignore backgrounds, walls, floors, skin, hair, hands, accessories like sunglasses, and reflections. Use ONLY these exact colour names (no variants): ${colourPalette}.

2. The garment categories visible in the outfit. Pick from these exact strings: tops, bottoms, onePieces, outerwear, shoes. Notes:
   - "tops" = shirt, blouse, tee, tank, sweater (worn as the top layer alone), crop top
   - "bottoms" = pants, jeans, shorts, trousers, skirt
   - "onePieces" = dress, jumpsuit, romper, gown
   - "outerwear" = cardigan, sweater (layered over a top), jacket, coat, blazer
   - "shoes" = anything on the feet
   - Don't list "outerwear" if the sweater IS the top layer; only when it's clearly over a shirt/top.

Respond as JSON only, no other text:
{"colors": ["...", "..."], "categories": ["...", "..."]}`;

      // Try a sequence of models — Google sometimes deprecates older ones.
      // The new AQ.-prefixed keys (April 2026 format) work with both the
      // x-goog-api-key header AND the ?key= query string on the native endpoint.
      // We send via header which is the more modern convention and works for
      // both AIza and AQ key formats.
      const models = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-flash-latest'];
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout')), 20000));

      const requestBody = JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: data } },
            { text: prompt }
          ]
        }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.3 }
      });

      try {
        let res = null, errText = '', lastStatus = 0;
        for (const model of models) {
          const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
          const call = fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': key
            },
            body: requestBody
          });
          res = await Promise.race([call, timeout]);
          lastStatus = res.status;
          if (res.ok) break;
          errText = await res.text();
          console.warn(`Gemini ${model} returned ${res.status}:`, errText.slice(0, 200));
          // If it's a model-not-found, try the next one
          if (res.status === 404) continue;
          // For auth errors, no point trying other models — same key
          if (res.status === 400 || res.status === 401 || res.status === 403) break;
        }

        if (!res || !res.ok) {
          // Bad key — clear it so the user gets re-prompted
          if (lastStatus === 400 || lastStatus === 401 || lastStatus === 403) {
            console.warn('Gemini rejected the key (will re-prompt). Detail:', errText);
            setGeminiKey('');
          }
          return null;
        }

        const json = await res.json();
        const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const jm = text.match(/\{[\s\S]*\}/);
        if (!jm) {
          console.warn('Gemini returned no JSON. Full text:', text);
          return null;
        }
        const parsed = JSON.parse(jm[0]);
        const colors = Array.isArray(parsed.colors)
          ? parsed.colors.filter(c => typeof c === 'string').map(normaliseColorName).filter(Boolean).slice(0, 3)
          : [];
        const cats = Array.isArray(parsed.categories)
          ? parsed.categories.filter(c => typeof c === 'string')
              .map(c => c.trim())
              .filter(c => ['tops','bottoms','onePieces','outerwear','shoes'].includes(c))
          : [];
        return (colors.length || cats.length) ? { colors, categories: cats } : null;
      } catch (e) {
        console.warn('analyzePhotoWithAI:', e);
        return null;
      }
    }

    // Map AI-returned colour names back to our exact palette names
    function normaliseColorName(name) {
      const s = String(name).toLowerCase().trim();
      // Direct match
      for (const [palette] of COLORS) if (palette.toLowerCase() === s) return palette;
      // Strip common modifiers
      const stripped = s.replace(/^(light|dark|deep|pale|bright|dusty|soft|hot|pastel)\s+/, '');
      for (const [palette] of COLORS) if (palette.toLowerCase() === stripped) return palette;
      // Aliases
      const map = {
        'beige': 'cream/beige', 'cream': 'cream/beige', 'ivory': 'cream/beige', 'champagne': 'cream/beige',
        'gray': 'grey', 'silver': 'metallic', 'gold': 'metallic',
        'denim': 'denim/light blue', 'light blue': 'denim/light blue',
        'tan': 'tan/camel', 'camel': 'tan/camel', 'khaki': 'tan/camel',
        'multi': 'multi/print', 'multicolor': 'multi/print', 'multicolour': 'multi/print',
        'patterned': 'multi/print', 'pattern': 'multi/print', 'print': 'floral / print',
        'floral': 'floral / print', 'striped': 'multi/print', 'plaid': 'multi/print'
      };
      if (map[s]) return map[s];
      if (map[stripped]) return map[stripped];
      return null;
    }

    function extractDominantColors(ctx, w, h) {
      const data = ctx.getImageData(0, 0, w, h).data;

      // ─── Step 1: Learn the background ───
      // Sample the four corner regions of the photo — these are almost always
      // background (walls, floors, sky). Cluster their colours into "background
      // signature" so we can subtract pixels that match them in the main pass.
      const bgSignature = sampleBackgroundCorners(data, w, h);

      // ─── Step 2: Sample the centre region, excluding background-matching pixels ───
      const padX = Math.floor(w * 0.15);
      const padY = Math.floor(h * 0.10);
      const buckets = {};
      const cx = w / 2, cy = h * 0.55; // clothing usually sits below the face
      const maxDist = Math.hypot(w / 2, h / 2);

      for (let y = padY; y < h - padY; y += 2) {
        for (let x = padX; x < w - padX; x += 2) {
          const i = (y * w + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
          if (a < 200) continue;

          // Drop extreme highlights and deep shadows
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          if (lum > 240 || lum < 18) continue;

          // Drop low-saturation light pixels — typical of walls/paper/white furniture
          const max = Math.max(r, g, b), min = Math.min(r, g, b);
          const sat = max ? (max - min) / max : 0;
          if (sat < 0.10 && lum > 160) continue;

          // Skin tone filter
          const isSkin =
            r > g && g >= b &&
            (r - b) > 28 && (r - b) < 130 &&
            (g - b) >= 6 && (g - b) < 70 &&
            sat > 0.18 && sat < 0.65 &&
            lum > 80 && lum < 230;
          if (isSkin) continue;

          // ★ Background subtraction: skip pixels that match a corner sample.
          // This is the biggest accuracy win — if your room is beige, a beige
          // wall behind you won't pollute the colour extraction anymore.
          if (matchesBackground(r, g, b, bgSignature)) continue;

          // Centre weighting
          const dx = (x - cx) / maxDist;
          const dy = (y - cy) / maxDist;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const weight = Math.max(0.25, 1 - dist * 1.2);

          const key = `${r >> 5}|${g >> 5}|${b >> 5}`;
          buckets[key] = (buckets[key] || 0) + weight;
        }
      }

      const top = Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 14);
      const byName = {};
      for (const [key, count] of top) {
        const [rq, gq, bq] = key.split('|').map(Number);
        const r = rq * 32 + 16, g = gq * 32 + 16, b = bq * 32 + 16;
        const name = nearestNamedColor(r, g, b);
        byName[name] = (byName[name] || 0) + count;
      }
      return Object.entries(byName)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(e => e[0]);
    }

    // Sample 4 corner regions (15% × 15% each) and return the dominant colour
    // clusters found there. These represent the photo's background.
    function sampleBackgroundCorners(data, w, h) {
      const regions = [
        { x0: 0,            y0: 0,            x1: w * 0.18, y1: h * 0.18 }, // top-left
        { x0: w * 0.82,     y0: 0,            x1: w,         y1: h * 0.18 }, // top-right
        { x0: 0,            y0: h * 0.82,     x1: w * 0.18, y1: h          }, // bottom-left
        { x0: w * 0.82,     y0: h * 0.82,     x1: w,         y1: h          }  // bottom-right
      ];
      const cornerBuckets = {};
      for (const reg of regions) {
        for (let y = Math.floor(reg.y0); y < Math.floor(reg.y1); y += 3) {
          for (let x = Math.floor(reg.x0); x < Math.floor(reg.x1); x += 3) {
            const i = (y * w + x) * 4;
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 200) continue;
            // Quantize coarsely so similar shades cluster
            const key = `${r >> 4}|${g >> 4}|${b >> 4}`;
            cornerBuckets[key] = (cornerBuckets[key] || 0) + 1;
          }
        }
      }
      // Keep the top 6 colour clusters — that's our background signature
      return Object.entries(cornerBuckets)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([key]) => {
          const [rq, gq, bq] = key.split('|').map(Number);
          return { r: rq * 16 + 8, g: gq * 16 + 8, b: bq * 16 + 8 };
        });
    }

    // Returns true if (r,g,b) is close to any background sample within a
    // perceptual distance threshold. Tighter threshold → less aggressive
    // subtraction (preserves clothing similar in tone to background).
    function matchesBackground(r, g, b, bgSignature) {
      for (const bg of bgSignature) {
        const d = Math.abs(bg.r - r) + Math.abs(bg.g - g) + Math.abs(bg.b - b);
        if (d < 45) return true;
      }
      return false;
    }

    function nearestNamedColor(r, g, b) {
      let best = 'black', bestDist = Infinity;
      for (const [name, hex] of COLORS) {
        if (typeof hex !== 'string' || !hex.startsWith('#')) continue;
        const cr = parseInt(hex.slice(1, 3), 16);
        const cg = parseInt(hex.slice(3, 5), 16);
        const cb = parseInt(hex.slice(5, 7), 16);
        const d = (cr - r) * (cr - r) + (cg - g) * (cg - g) + (cb - b) * (cb - b);
        if (d < bestDist) { bestDist = d; best = name; }
      }
      return best;
    }

    function renderPhotoGrid() {
      const grid = document.getElementById('photoGrid');
      if (!grid) return;
      grid.innerHTML = '';
      (state.outfitPhotos || []).forEach(p => {
        const cell = document.createElement('div');
        cell.className = 'ph';
        const swatches = (p.colors || []).map(c => {
          const hex = colorHex(c);
          const fill = typeof hex === 'string' && hex.startsWith('#') ? hex : '#bbb';
          return `<span style="background:${fill}"></span>`;
        }).join('');
        cell.innerHTML = `
          <img src="${p.image}" alt="">
          <button class="rm" data-remove-photo="${p.id}" title="Remove">×</button>
          <div class="colors">${swatches}</div>
        `;
        grid.appendChild(cell);
      });
      grid.querySelectorAll('[data-remove-photo]').forEach(btn => {
        btn.onclick = e => {
          const id = e.currentTarget.dataset.removePhoto;
          state.outfitPhotos = (state.outfitPhotos || []).filter(p => p.id !== id);
          save();
          renderPhotoGrid();
          if (typeof window.updateCount === 'function') window.updateCount();
        };
      });
      const countEl = document.getElementById('photoCount');
      if (countEl) {
        const n = (state.outfitPhotos || []).length;
        countEl.textContent = n ? `${n} outfit${n === 1 ? '' : 's'} logged` : '';
      }
    }

    window.__photoPluginRender = renderPhotoGrid;
    renderPhotoGrid();
    if (typeof window.updateCount === 'function') window.updateCount();
  }
})();
