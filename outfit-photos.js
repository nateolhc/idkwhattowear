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

        // In photo-only mode, synthesize colour-bearing ghost items so the
        // existing analysis pipeline has something to work with.
        if (photoOnly) {
          const photoItems = [];
          photos.forEach(p => (p.colors || []).forEach(c => {
            photoItems.push({
              id: 'photo-' + Math.random().toString(36).slice(2),
              category: 'tops', name: 'outfit colour', tier: 'decent',
              color: c, brand: '', occasion: []
            });
          }));
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
        if (catColorWrap && catColorWrap.parentElement) {
          catColorWrap.parentElement.style.display = photoOnly ? 'none' : '';
        }
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

        // Remove foundation pieces card in photo-only mode (needs item names)
        if (photoOnly) {
          document.querySelectorAll('.opt-card.gap').forEach(card => {
            if (/foundation pieces? missing/i.test(card.textContent || '')) card.remove();
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

      // Always append photos to the existing collection. No prompts, no surprise
      // wipes. To clear everything (manual items, photos, ratings), use Start Over.
      if (!Array.isArray(state.outfitPhotos)) state.outfitPhotos = [];

      const progress = document.getElementById('photoProgress');
      if (progress) progress.style.display = 'block';

      let done = 0;
      for (const file of files) {
        if (!file.type.startsWith('image/')) { done++; continue; }
        if (progress) progress.textContent = `Processing ${done + 1} of ${files.length}…`;
        try {
          const photo = await processPhoto(file);
          if (photo) state.outfitPhotos.push(photo);
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

      const maxDim = 800;
      const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * ratio));
      const h = Math.max(1, Math.round(img.height * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);

      const colors = extractDominantColors(ctx, w, h);
      const resized = canvas.toDataURL('image/jpeg', 0.72);

      return {
        id: uid(),
        filename: file.name,
        image: resized,
        colors,
        createdAt: Date.now()
      };
    }

    function extractDominantColors(ctx, w, h) {
      const data = ctx.getImageData(0, 0, w, h).data;
      const buckets = {};
      for (let i = 0; i < data.length; i += 16) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 200) continue;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 242 || lum < 16) continue;
        const key = `${r >> 5}|${g >> 5}|${b >> 5}`;
        buckets[key] = (buckets[key] || 0) + 1;
      }
      const top = Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 12);
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
