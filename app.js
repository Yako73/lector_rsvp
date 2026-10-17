/**
 * RSVP Speed Reader UltraFast Pro — Motor Auditado Multi-Entorno (Cloudflare Pages y Local)
 */
const STORAGE_KEY_SETTINGS = 'rsvp_pro_settings_v4';
const IDB_NAME = 'RSVPReaderDB_v4';
const IDB_STORE = 'booksStore';
const IDB_BOOK_KEY = 'activeBook';
const PDF_WORKER_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

const state = {
  words: [],
  pageMap: [],
  currentIndex: 0,
  isPlaying: false,
  wpm: 400,
  targetWpm: 400,
  fontSize: 48,
  chunkSize: 1,
  rampingEnabled: false,
  smartPauses: true,
  bookTitle: 'Guía Rápida RSVP',
  timerId: null,
  rampingTimerId: null,
  wakeLockSentinel: null,
  theme: 'dark'
};

const defaultDemoText = "Bienvenido a tu lector de alta velocidad RSVP Pro. Pulsa el botón Cargar Libro arriba a la derecha o arrastra cualquier archivo PDF, EPUB, Word DOCX o TXT directamente sobre esta pantalla. La letra roja central marca el Punto Óptimo de Reconocimiento para leer sin mover los ojos ni subvocalizar.";

const dom = {
  wLeft: document.getElementById('wLeft'),
  wOrp: document.getElementById('wOrp'),
  wRight: document.getElementById('wRight'),
  wordStage: document.getElementById('wordStage'),
  reticleBox: document.getElementById('reticleBox'),
  btnOpenFile: document.getElementById('btnOpenFile'),
  fileInput: document.getElementById('fileInput'),
  btnPlayPause: document.getElementById('btnPlayPause'),
  displayWpm: document.getElementById('displayWpm'),
  displayFontSize: document.getElementById('displayFontSize'),
  progressHitbox: document.getElementById('progressHitbox'),
  progressTrack: document.getElementById('progressTrack'),
  progressFill: document.getElementById('progressFill'),
  metricWords: document.getElementById('metricWords'),
  metricPercent: document.getElementById('metricPercent'),
  metricEta: document.getElementById('metricEta'),
  bookTitleDisplay: document.getElementById('bookTitleDisplay'),
  pageTrackerDisplay: document.getElementById('pageTrackerDisplay'),
  wakeLockBadge: document.getElementById('wakeLockBadge'),
  toast: document.getElementById('toast'),
  readerArea: document.getElementById('readerArea'),
  modalGoto: document.getElementById('modalGoto'),
  modalSettings: document.getElementById('modalSettings'),
  modalLoading: document.getElementById('modalLoading'),
  loaderTitle: document.getElementById('loaderTitle'),
  loaderSubtitle: document.getElementById('loaderSubtitle'),
  loaderBarFill: document.getElementById('loaderBarFill'),
  gotoValueInput: document.getElementById('gotoValueInput'),
  gotoContextPreview: document.getElementById('gotoContextPreview'),
  btnApplyGoto: document.getElementById('btnApplyGoto'),
  selectChunkSize: document.getElementById('selectChunkSize'),
  checkRamping: document.getElementById('checkRamping'),
  checkSmartPauses: document.getElementById('checkSmartPauses')
};

let toastTimeout;
function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => dom.toast.classList.remove('show'), 2500);
}

let pdfWorkerConfigured = false;
async function ensurePdfWorkerReady() {
  if (!window.pdfjsLib) {
    throw new Error('La librería PDF.js no se cargó. Verifica tu conexión a internet.');
  }
  if (pdfWorkerConfigured) return;

  try {
    const res = await fetch(PDF_WORKER_CDN);
    if (res.ok) {
      const workerCode = await res.text();
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
      pdfWorkerConfigured = true;
      return;
    }
  } catch (_) {}

  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_CDN;
  pdfWorkerConfigured = true;
}

// --- WAKE LOCK API ---
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      state.wakeLockSentinel = await navigator.wakeLock.request('screen');
      dom.wakeLockBadge.hidden = false;
      state.wakeLockSentinel.addEventListener('release', () => {
        dom.wakeLockBadge.hidden = true;
      });
    } catch (_) {
      dom.wakeLockBadge.hidden = true;
    }
  }
}

async function releaseWakeLock() {
  if (state.wakeLockSentinel) {
    try { await state.wakeLockSentinel.release(); } catch (_) {}
    state.wakeLockSentinel = null;
  }
  dom.wakeLockBadge.hidden = true;
}

// --- INDEXEDDB ---
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB no soportado'));
      return;
    }
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function saveBookToIDB(bookTitle, cleanText, pageMap) {
  try {
    const db = await openDatabase();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ bookTitle, cleanText, pageMap }, IDB_BOOK_KEY);
  } catch (e) {
    console.warn('Aviso IndexedDB:', e);
  }
}

async function loadBookFromIDB() {
  try {
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_BOOK_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return null;
  }
}

async function clearBookFromIDB() {
  try {
    const db = await openDatabase();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(IDB_BOOK_KEY);
  } catch (_) {}
}

// --- MOTOR ORP Y PROCESAMIENTO DE TEXTO ---
function getOrpIndex(word) {
  const leadingMatch = word.match(/^[¿¡"'«([{]+/);
  const offset = leadingMatch ? leadingMatch[0].length : 0;
  const cleanWord = word.slice(offset).replace(/[.,;:?!'"»)\]}…]+$/, '');
  const len = cleanWord.length;

  if (len <= 0) return 0;
  let orpLocal = 0;
  if (len <= 1) orpLocal = 0;
  else if (len <= 5) orpLocal = 1;
  else if (len <= 9) orpLocal = 2;
  else if (len <= 13) orpLocal = 3;
  else orpLocal = 4;

  return Math.min(word.length - 1, offset + orpLocal);
}

function computePauseFactor(word) {
  if (!state.smartPauses) return 1.0;
  if (/[.?!…]$/.test(word) || /[.?!…]["'»)\]]$/.test(word)) return 2.0;
  if (/[,;:—–]$/.test(word)) return 1.5;
  if (word.length > 10) return 1.25;
  return 1.0;
}

function recalculatePauseFactors() {
  for (let i = 0; i < state.words.length; i++) {
    state.words[i].pauseFactor = computePauseFactor(state.words[i].word);
  }
}

function processRawText(rawText, pagesIndices = null, initialIndex = 0, shouldCacheBook = true) {
  const dehyphenated = (rawText || '').replace(/([a-záéíóúñüA-ZÁÉÍÓÚÑÜ])-\s+(\r\n|\n|\r)\s*([a-záéíóúñü])/g, '$1$3');
  const clean = dehyphenated.replace(/(\r\n|\n|\r)/gm, ' ').replace(/\s+/g, ' ').trim();
  const rawWords = clean.split(' ').filter(w => w.length > 0);

  if (rawWords.length === 0) {
    showToast('⚠️ El archivo no tiene texto extraíble (posible PDF escaneado como imagen sin OCR).');
    return false;
  }

  state.words = rawWords.map((w) => {
    const orp = getOrpIndex(w);
    return {
      word: w,
      left: w.substring(0, orp),
      orp: w.charAt(orp) || '',
      right: w.substring(orp + 1),
      pauseFactor: computePauseFactor(w)
    };
  });

  if (pagesIndices && pagesIndices.length > 0) {
    state.pageMap = pagesIndices;
  } else {
    state.pageMap = [];
    const totalPages = Math.max(1, Math.ceil(state.words.length / 250));
    for (let p = 1; p <= totalPages; p++) {
      state.pageMap.push({ page: p, wordIndex: (p - 1) * 250 });
    }
  }

  state.currentIndex = Math.max(0, Math.min(state.words.length - 1, initialIndex));
  dom.bookTitleDisplay.textContent = state.bookTitle;

  if (shouldCacheBook && state.bookTitle !== 'Guía Rápida RSVP') {
    saveBookToIDB(state.bookTitle, clean, state.pageMap);
  }

  saveProgress();
  updateStage();
  updateMetrics();
  return true;
}

function updateStage() {
  if (state.words.length === 0) return;

  dom.wordStage.style.fontSize = `${state.fontSize}px`;

  if (state.chunkSize === 1) {
    const token = state.words[state.currentIndex] || { left: '', orp: '-', right: '' };
    dom.wLeft.textContent = token.left;
    dom.wOrp.textContent = token.orp;
    dom.wRight.textContent = token.right;

    dom.wordStage.style.left = '38%';
    dom.wordStage.style.transform = 'none';
    const boxWidth = dom.reticleBox.clientWidth || 320;
    const stageWidth = dom.wordStage.scrollWidth || 1;
    const leftWidth = dom.wLeft.getBoundingClientRect().width;
    const orpWidth = dom.wOrp.getBoundingClientRect().width;

    const maxAllowed = boxWidth * 0.88;
    const scale = stageWidth > maxAllowed ? (maxAllowed / stageWidth) : 1;
    const offsetPx = (leftWidth + (orpWidth / 2)) * scale;

    dom.wordStage.style.transform = `translateX(-${offsetPx}px) scale(${scale})`;
  } else {
    const chunk = state.words
      .slice(state.currentIndex, state.currentIndex + state.chunkSize)
      .map(t => t.word)
      .join(' ');
    dom.wLeft.textContent = '';
    dom.wOrp.textContent = chunk;
    dom.wRight.textContent = '';

    dom.wordStage.style.transform = 'none';
    const boxWidth = dom.reticleBox.clientWidth || 320;
    const stageWidth = dom.wordStage.scrollWidth || 1;
    const maxAllowed = boxWidth * 0.9;
    const scale = stageWidth > maxAllowed ? (maxAllowed / stageWidth) : 1;

    dom.wordStage.style.left = '50%';
    dom.wordStage.style.transform = `translateX(-50%) scale(${scale})`;
  }
}

function updateMetrics() {
  const total = state.words.length;
  if (total === 0) return;

  const current = Math.min(total, state.currentIndex + 1);
  const percent = total > 1 ? Math.floor((state.currentIndex / (total - 1)) * 100) : 100;

  dom.progressFill.style.width = `${percent}%`;
  dom.progressHitbox.setAttribute('aria-valuenow', String(percent));
  dom.metricWords.textContent = `Palabra: ${current} / ${total}`;
  dom.metricPercent.textContent = `${percent}%`;

  const wordsLeft = Math.max(0, total - current);
  const effectiveWpm = Math.max(1, state.wpm);
  const minsLeft = Math.ceil(wordsLeft / effectiveWpm);
  dom.metricEta.textContent = `Restante: ${minsLeft} min`;

  let currentPage = 1;
  for (let i = state.pageMap.length - 1; i >= 0; i--) {
    if (state.currentIndex >= state.pageMap[i].wordIndex) {
      currentPage = state.pageMap[i].page;
      break;
    }
  }
  dom.pageTrackerDisplay.textContent = `Pág. ${currentPage} / ${state.pageMap.length}`;
}

function scheduleNextTick() {
  if (!state.isPlaying) return;

  let pauseMultiplier = 1.0;
  const endSlice = Math.min(state.words.length, state.currentIndex + state.chunkSize);
  for (let i = state.currentIndex; i < endSlice; i++) {
    if (state.words[i] && state.words[i].pauseFactor > pauseMultiplier) {
      pauseMultiplier = state.words[i].pauseFactor;
    }
  }

  const baseDelay = (60000 / Math.max(50, state.wpm)) * state.chunkSize;
  const finalDelay = baseDelay * pauseMultiplier;

  state.timerId = setTimeout(() => {
    if (!state.isPlaying) return;

    const nextIndex = state.currentIndex + state.chunkSize;
    if (nextIndex >= state.words.length) {
      state.currentIndex = state.words.length - 1;
      updateStage();
      updateMetrics();
      pause();
      showToast('🎉 ¡Has finalizado la lectura!');
      return;
    }

    state.currentIndex = nextIndex;
    updateStage();
    updateMetrics();

    if (state.currentIndex % 25 === 0) {
      saveProgress();
    }

    scheduleNextTick();
  }, finalDelay);
}

function play() {
  if (state.words.length === 0) return;

  if (state.currentIndex >= state.words.length - 1) {
    state.currentIndex = 0;
  }

  clearTimeout(state.timerId);
  clearInterval(state.rampingTimerId);

  state.isPlaying = true;
  dom.btnPlayPause.textContent = '⏸ Pausa';
  requestWakeLock();

  updateStage();
  updateMetrics();

  if (state.rampingEnabled) {
    state.wpm = Math.max(100, state.targetWpm - 50);
    dom.displayWpm.textContent = `${state.wpm} PPM`;
    state.rampingTimerId = setInterval(() => {
      if (state.wpm < state.targetWpm) {
        state.wpm = Math.min(state.targetWpm, state.wpm + 10);
        dom.displayWpm.textContent = `${state.wpm} PPM`;
      } else {
        clearInterval(state.rampingTimerId);
      }
    }, 5000);
  } else {
    state.wpm = state.targetWpm;
    dom.displayWpm.textContent = `${state.wpm} PPM`;
  }

  scheduleNextTick();
}

function pause() {
  state.isPlaying = false;
  dom.btnPlayPause.textContent = '▶ Iniciar';
  clearTimeout(state.timerId);
  clearInterval(state.rampingTimerId);
  releaseWakeLock();
  state.wpm = state.targetWpm;
  dom.displayWpm.textContent = `${state.wpm} PPM`;
  saveProgress();
}

function togglePlay() {
  if (state.isPlaying) pause();
  else play();
}

function jumpWords(delta) {
  if (state.words.length === 0) return;
  state.currentIndex = Math.max(0, Math.min(state.words.length - 1, state.currentIndex + delta));
  updateStage();
  updateMetrics();
  saveProgress();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.isPlaying) {
    pause();
  }
});

function saveProgress() {
  if (!state.bookTitle || state.words.length === 0) return;
  try {
    const data = {
      bookTitle: state.bookTitle,
      currentIndex: state.currentIndex,
      wpm: state.targetWpm,
      fontSize: state.fontSize,
      chunkSize: state.chunkSize,
      rampingEnabled: state.rampingEnabled,
      smartPauses: state.smartPauses,
      theme: state.theme
    };
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(data));
  } catch (_) {}
}

async function initApplicationState() {
  let savedIndex = 0;
  let savedBookTitle = null;

  const rawSettings = localStorage.getItem(STORAGE_KEY_SETTINGS);
  if (rawSettings) {
    try {
      const data = JSON.parse(rawSettings);
      if (typeof data.wpm === 'number') {
        state.wpm = Math.max(100, Math.min(1000, data.wpm));
        state.targetWpm = state.wpm;
        dom.displayWpm.textContent = `${state.wpm} PPM`;
      }
      if (typeof data.fontSize === 'number') {
        state.fontSize = Math.max(24, Math.min(84, data.fontSize));
        dom.displayFontSize.textContent = `${state.fontSize}px`;
      }
      if (typeof data.chunkSize === 'number') {
        state.chunkSize = [1, 2, 3].includes(data.chunkSize) ? data.chunkSize : 1;
        dom.selectChunkSize.value = String(state.chunkSize);
      }
      if (typeof data.rampingEnabled === 'boolean') {
        state.rampingEnabled = data.rampingEnabled;
        dom.checkRamping.checked = data.rampingEnabled;
      }
      if (typeof data.smartPauses === 'boolean') {
        state.smartPauses = data.smartPauses;
        dom.checkSmartPauses.checked = data.smartPauses;
      }
      if (typeof data.currentIndex === 'number') {
        savedIndex = data.currentIndex;
      }
      if (data.bookTitle) {
        savedBookTitle = data.bookTitle;
      }
      if (data.theme) {
        applyTheme(data.theme);
      }
    } catch (e) {
      console.error('Error al cargar ajustes:', e);
    }
  }

  const cachedBook = await loadBookFromIDB();
  if (cachedBook && cachedBook.cleanText && cachedBook.cleanText.length > 0) {
    state.bookTitle = cachedBook.bookTitle || savedBookTitle || 'Libro en curso';
    const resumeIndex = (savedBookTitle === state.bookTitle) ? savedIndex : 0;
    processRawText(cachedBook.cleanText, cachedBook.pageMap || null, resumeIndex, false);
    return;
  }

  state.bookTitle = 'Guía Rápida RSVP';
  const demoIndex = (savedBookTitle === 'Guía Rápida RSVP') ? savedIndex : 0;
  processRawText(defaultDemoText, null, demoIndex, false);
}

// --- EXTRACTORES RESILIENTES (PDF, EPUB, DOCX, TXT) ---
async function extractPdf(arrayBuffer) {
  await ensurePdfWorkerReady();

  let pdf = null;
  try {
    const loadingTask = window.pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer.slice(0)),
      cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/cmaps/',
      cMapPacked: true
    });
    pdf = await loadingTask.promise;
  } catch (workerErr) {
    console.warn('Worker bloqueado; usando modo directo:', workerErr);
    const fallbackTask = window.pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer.slice(0)),
      disableWorker: true
    });
    pdf = await fallbackTask.promise;
  }

  try {
    const numPages = pdf.numPages;
    const textChunks = [];
    const pageMap = [];
    let currentWordCount = 0;

    dom.loaderTitle.textContent = `Procesando PDF (${numPages} páginas)`;

    for (let i = 1; i <= numPages; i++) {
      dom.loaderSubtitle.textContent = `Extrayendo página ${i} de ${numPages}...`;
      dom.loaderBarFill.style.width = `${Math.floor((i / numPages) * 100)}%`;

      pageMap.push({ page: i, wordIndex: currentWordCount });

      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str || '').join(' ').trim();

      if (pageText.length > 0) {
        const pageWords = pageText.split(/\s+/).filter(w => w.length > 0);
        currentWordCount += pageWords.length;
        textChunks.push(pageText);
      }

      page.cleanup();
      if (i % 3 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    return { fullText: textChunks.join(' '), pageMap };
  } finally {
    if (pdf && typeof pdf.destroy === 'function') {
      await pdf.destroy();
    }
  }
}

async function extractEpub(arrayBuffer) {
  if (!window.JSZip) {
    throw new Error('La librería JSZip no está cargada.');
  }

  dom.loaderTitle.textContent = 'Procesando libro EPUB...';
  dom.loaderSubtitle.textContent = 'Abriendo contenedor comprimido';
  dom.loaderBarFill.style.width = '15%';

  const zip = await window.JSZip.loadAsync(arrayBuffer.slice(0));
  const parser = new DOMParser();

  let opfPath = null;
  const containerFile = zip.file('META-INF/container.xml');
  if (containerFile) {
    const containerXml = await containerFile.async('text');
    const containerDoc = parser.parseFromString(containerXml, 'application/xml');
    const rootfile = containerDoc.querySelector('rootfile');
    if (rootfile) {
      opfPath = rootfile.getAttribute('full-path');
    }
  }

  let orderedFiles = [];
  if (opfPath && zip.file(opfPath)) {
    const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
    const opfXml = await zip.file(opfPath).async('text');
    const opfDoc = parser.parseFromString(opfXml, 'application/xml');

    const manifestMap = {};
    opfDoc.querySelectorAll('manifest > item').forEach(item => {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (id && href) manifestMap[id] = opfDir + decodeURIComponent(href);
    });

    opfDoc.querySelectorAll('spine > itemref').forEach(ref => {
      const idref = ref.getAttribute('idref');
      if (idref && manifestMap[idref] && zip.file(manifestMap[idref])) {
        orderedFiles.push(manifestMap[idref]);
      }
    });
  }

  if (orderedFiles.length === 0) {
    orderedFiles = Object.keys(zip.files)
      .filter(name => /\.(xhtml|html|htm)$/i.test(name) && !zip.files[name].dir)
      .sort();
  }

  const textChunks = [];
  const pageMap = [];
  let currentWordCount = 0;
  let pageNum = 1;
  const totalItems = Math.max(1, orderedFiles.length);

  for (let i = 0; i < orderedFiles.length; i++) {
    const itemPath = orderedFiles[i];
    dom.loaderSubtitle.textContent = `Extrayendo capítulo ${i + 1} de ${totalItems}...`;
    dom.loaderBarFill.style.width = `${Math.floor(((i + 1) / totalItems) * 100)}%`;

    const rawHtml = await zip.file(itemPath).async('text');
    const doc = parser.parseFromString(rawHtml, 'text/html');
    doc.querySelectorAll('script, style, nav').forEach(el => el.remove());

    const sectionText = ((doc.body ? doc.body.textContent : doc.documentElement.textContent) || '')
      .replace(/\s+/g, ' ')
      .trim();

    if (sectionText.length > 0) {
      pageMap.push({ page: pageNum++, wordIndex: currentWordCount });
      const sectionWords = sectionText.split(/\s+/).filter(w => w.length > 0);
      currentWordCount += sectionWords.length;
      textChunks.push(sectionText);
    }

    if (i % 3 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return { fullText: textChunks.join(' '), pageMap };
}

async function extractDocx(arrayBuffer) {
  if (!window.mammoth) {
    throw new Error('La librería Mammoth (Word DOCX) no está disponible.');
  }
  dom.loaderTitle.textContent = 'Procesando documento Word...';
  dom.loaderSubtitle.textContent = 'Extrayendo párrafos de .DOCX';
  dom.loaderBarFill.style.width = '50%';

  const result = await window.mammoth.extractRawText({ arrayBuffer: arrayBuffer.slice(0) });
  dom.loaderBarFill.style.width = '100%';
  return { fullText: result.value || '' };
}

async function handleFile(file) {
  if (!file) return;
  pause();

  dom.modalLoading.classList.add('active');
  dom.loaderBarFill.style.width = '5%';

  const previousTitle = state.bookTitle;
  state.bookTitle = file.name.replace(/\.[^/.]+$/, '');
  const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  const mime = (file.type || '').toLowerCase();

  try {
    let success = false;
    if (ext === 'txt' || ext === 'md' || mime === 'text/plain') {
      dom.loaderTitle.textContent = 'Cargando texto...';
      dom.loaderSubtitle.textContent = file.name;
      dom.loaderBarFill.style.width = '100%';
      const text = await file.text();
      success = processRawText(text, null, 0, true);
      if (success) showToast(`✅ Texto cargado: ${state.bookTitle}`);
    } else if (ext === 'pdf' || mime === 'application/pdf') {
      const arrayBuffer = await file.arrayBuffer();
      const { fullText, pageMap } = await extractPdf(arrayBuffer);
      success = processRawText(fullText, pageMap, 0, true);
      if (success) showToast(`✅ PDF listo (${pageMap.length} páginas)`);
    } else if (ext === 'epub' || mime === 'application/epub+zip') {
      const arrayBuffer = await file.arrayBuffer();
      const { fullText, pageMap } = await extractEpub(arrayBuffer);
      success = processRawText(fullText, pageMap, 0, true);
      if (success) showToast(`✅ EPUB listo (${pageMap.length} capítulos)`);
    } else if (ext === 'docx' || mime.includes('wordprocessingml')) {
      const arrayBuffer = await file.arrayBuffer();
      const { fullText } = await extractDocx(arrayBuffer);
      success = processRawText(fullText, null, 0, true);
      if (success) showToast(`✅ Word DOCX listo: ${state.bookTitle}`);
    } else if (ext === 'doc') {
      showToast('⚠️ Formato .doc antiguo. Guárdalo como .docx o .pdf primero.');
    } else {
      showToast('⚠️ Formato no compatible. Usa .pdf, .epub, .docx, .txt o .md');
    }

    if (!success) {
      state.bookTitle = previousTitle;
      dom.bookTitleDisplay.textContent = state.bookTitle;
    }
  } catch (err) {
    state.bookTitle = previousTitle;
    dom.bookTitleDisplay.textContent = state.bookTitle;
    console.error('Error detallado al cargar archivo:', err);
    showToast('❌ No se pudo procesar: ' + (err.message || 'Archivo dañado'));
  } finally {
    dom.modalLoading.classList.remove('active');
    dom.fileInput.value = '';
  }
}

// --- NAVEGACIÓN "IR A..." ---
let activeGotoTab = 'percent';

function setupGotoModal() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      activeGotoTab = e.currentTarget.getAttribute('data-tab');

      if (activeGotoTab === 'percent') dom.gotoValueInput.placeholder = 'Porcentaje (0 - 100)';
      else if (activeGotoTab === 'page') dom.gotoValueInput.placeholder = `Página (1 - ${state.pageMap.length})`;
      else if (activeGotoTab === 'word') dom.gotoValueInput.placeholder = `Palabra (1 - ${state.words.length})`;
      updateGotoPreview();
    });
  });

  dom.gotoValueInput.addEventListener('input', updateGotoPreview);
  dom.gotoValueInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyGotoJump();
      dom.modalGoto.classList.remove('active');
    }
  });

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', (e) => {
      const val = parseFloat(e.currentTarget.getAttribute('data-jump'));
      activeGotoTab = 'percent';
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      const percentTab = document.querySelector('[data-tab="percent"]');
      if (percentTab) percentTab.classList.add('active');
      dom.gotoValueInput.value = val;
      updateGotoPreview();
    });
  });

  dom.btnApplyGoto.addEventListener('click', () => {
    applyGotoJump();
    dom.modalGoto.classList.remove('active');
  });
}

function resolveGotoTargetIndex(val) {
  if (isNaN(val) || state.words.length === 0) return null;

  if (activeGotoTab === 'percent') {
    const clamped = Math.max(0, Math.min(100, val));
    return Math.floor((clamped / 100) * (state.words.length - 1));
  }
  if (activeGotoTab === 'page') {
    const targetPage = Math.max(1, Math.min(state.pageMap.length, Math.round(val)));
    const pageObj = state.pageMap.find(p => p.page === targetPage) || state.pageMap[state.pageMap.length - 1];
    return pageObj ? pageObj.wordIndex : 0;
  }
  if (activeGotoTab === 'word') {
    return Math.max(0, Math.min(state.words.length - 1, Math.round(val) - 1));
  }
  return 0;
}

function updateGotoPreview() {
  const val = parseFloat(dom.gotoValueInput.value);
  const targetIndex = resolveGotoTargetIndex(val);

  if (targetIndex === null) {
    dom.gotoContextPreview.textContent = '"Introduce un valor para previsualizar el texto..."';
    return;
  }

  const snippet = state.words.slice(targetIndex, targetIndex + 15).map(t => t.word).join(' ');
  dom.gotoContextPreview.textContent = `"${snippet}..."`;
}

function applyGotoJump() {
  const val = parseFloat(dom.gotoValueInput.value);
  const targetIndex = resolveGotoTargetIndex(val);
  if (targetIndex === null) return;

  state.currentIndex = targetIndex;
  updateStage();
  updateMetrics();
  saveProgress();
  showToast('🎯 Posición actualizada');
}

function adjustWpm(delta) {
  state.targetWpm = Math.max(100, Math.min(1000, state.targetWpm + delta));
  state.wpm = state.targetWpm;
  dom.displayWpm.textContent = `${state.wpm} PPM`;
  updateMetrics();
  saveProgress();
  showToast(`Velocidad: ${state.wpm} PPM`);
}

// --- GESTOS TÁCTILES ---
let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;
let longPressTimer = null;
let isLongPress = false;
let wasPlayingBeforeLongPress = false;

dom.readerArea.addEventListener('touchstart', (e) => {
  if (e.touches.length > 1) return;
  touchStartX = e.changedTouches[0].clientX;
  touchStartY = e.changedTouches[0].clientY;
  touchStartTime = Date.now();
  isLongPress = false;
  wasPlayingBeforeLongPress = state.isPlaying;

  clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    isLongPress = true;
    if (state.isPlaying) {
      pause();
      showToast('⏸ Pausa momentánea');
    }
  }, 350);
}, { passive: true });

dom.readerArea.addEventListener('touchmove', (e) => {
  const moveX = Math.abs(e.changedTouches[0].clientX - touchStartX);
  const moveY = Math.abs(e.changedTouches[0].clientY - touchStartY);
  if (moveX > 15 || moveY > 15) {
    clearTimeout(longPressTimer);
  }
}, { passive: true });

dom.readerArea.addEventListener('touchcancel', () => {
  clearTimeout(longPressTimer);
  isLongPress = false;
}, { passive: true });

dom.readerArea.addEventListener('touchend', (e) => {
  clearTimeout(longPressTimer);
  const diffX = e.changedTouches[0].clientX - touchStartX;
  const diffY = e.changedTouches[0].clientY - touchStartY;
  const elapsed = Date.now() - touchStartTime;

  if (isLongPress) {
    if (wasPlayingBeforeLongPress) play();
    isLongPress = false;
    return;
  }

  if (Math.abs(diffX) > 40 && Math.abs(diffY) < 35) {
    if (diffX > 0) { jumpWords(-15); showToast('◀ -15 Palabras'); }
    else { jumpWords(15); showToast('+15 Palabras ▶'); }
    return;
  }

  if (Math.abs(diffY) > 40 && Math.abs(diffX) < 35) {
    if (diffY < 0) adjustWpm(25);
    else adjustWpm(-25);
    return;
  }

  if (elapsed < 300 && Math.abs(diffX) < 12 && Math.abs(diffY) < 12) {
    if (e.cancelable) e.preventDefault();
    togglePlay();
  }
});

dom.readerArea.addEventListener('click', () => {
  togglePlay();
});

// --- BARRA DE PROGRESO DESLIZABLE ---
let isScrubbing = false;
function scrubToClientX(clientX) {
  if (state.words.length === 0) return;
  const rect = dom.progressTrack.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  state.currentIndex = Math.floor(ratio * (state.words.length - 1));
  updateStage();
  updateMetrics();
}

dom.progressHitbox.addEventListener('pointerdown', (e) => {
  isScrubbing = true;
  pause();
  dom.progressHitbox.setPointerCapture(e.pointerId);
  scrubToClientX(e.clientX);
});

dom.progressHitbox.addEventListener('pointermove', (e) => {
  if (!isScrubbing) return;
  scrubToClientX(e.clientX);
});

dom.progressHitbox.addEventListener('pointerup', () => {
  if (isScrubbing) {
    isScrubbing = false;
    saveProgress();
  }
});

// --- DRAG & DROP ---
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('drag-over');
});

window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) {
    document.body.classList.remove('drag-over');
  }
});

window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('drag-over');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    handleFile(e.dataTransfer.files[0]);
  }
});

// --- BOTONES Y EVENTOS ---
dom.btnOpenFile.addEventListener('click', () => {
  dom.fileInput.value = '';
  dom.fileInput.click();
});

dom.fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    handleFile(e.target.files[0]);
  }
});

dom.btnPlayPause.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
document.getElementById('navBack100').addEventListener('click', (e) => { e.stopPropagation(); jumpWords(-100); });
document.getElementById('navBack10').addEventListener('click', (e) => { e.stopPropagation(); jumpWords(-10); });
document.getElementById('navFwd10').addEventListener('click', (e) => { e.stopPropagation(); jumpWords(10); });
document.getElementById('navFwd100').addEventListener('click', (e) => { e.stopPropagation(); jumpWords(100); });

document.getElementById('btnWpmPlus').addEventListener('click', (e) => { e.stopPropagation(); adjustWpm(25); });
document.getElementById('btnWpmMinus').addEventListener('click', (e) => { e.stopPropagation(); adjustWpm(-25); });

document.getElementById('btnFontPlus').addEventListener('click', (e) => {
  e.stopPropagation();
  state.fontSize = Math.min(84, state.fontSize + 4);
  dom.displayFontSize.textContent = `${state.fontSize}px`;
  updateStage();
  saveProgress();
});

document.getElementById('btnFontMinus').addEventListener('click', (e) => {
  e.stopPropagation();
  state.fontSize = Math.max(24, state.fontSize - 4);
  dom.displayFontSize.textContent = `${state.fontSize}px`;
  updateStage();
  saveProgress();
});

document.getElementById('btnGoto').addEventListener('click', () => {
  pause();
  dom.modalGoto.classList.add('active');
  updateGotoPreview();
  setTimeout(() => dom.gotoValueInput.focus(), 50);
});
document.getElementById('closeGotoModal').addEventListener('click', () => dom.modalGoto.classList.remove('active'));

document.getElementById('btnSettings').addEventListener('click', () => {
  pause();
  dom.modalSettings.classList.add('active');
});
document.getElementById('closeSettingsModal').addEventListener('click', () => dom.modalSettings.classList.remove('active'));

[dom.modalGoto, dom.modalSettings].forEach(modal => {
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('active');
  });
});

document.getElementById('btnSaveSettings').addEventListener('click', () => {
  state.chunkSize = parseInt(dom.selectChunkSize.value, 10) || 1;
  state.rampingEnabled = dom.checkRamping.checked;
  state.smartPauses = dom.checkSmartPauses.checked;
  updateStage();
  dom.modalSettings.classList.remove('active');
  showToast('⚙️ Ajustes guardados correctamente');
});

document.getElementById('btnClearStorage').addEventListener('click', async () => {
  if (confirm('¿Deseas borrar el libro en memoria y restablecer todos los ajustes?')) {
    localStorage.removeItem(STORAGE_KEY_SETTINGS);
    await clearBookFromIDB();
    location.reload();
  }
});

// --- TEMA CLARO / OSCURO ---
function applyTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', state.theme);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = state.theme === 'dark' ? '🌙' : '☀️';
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', state.theme === 'dark' ? '#121214' : '#f6f8fa');
}

document.getElementById('themeToggle').addEventListener('click', () => {
  const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(nextTheme);
  saveProgress();
  showToast(nextTheme === 'dark' ? '🌙 Modo Noche activado' : '☀️ Modo Día activado');
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    dom.modalGoto.classList.remove('active');
    dom.modalSettings.classList.remove('active');
    return;
  }

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); jumpWords(-10); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); jumpWords(10); }
  else if (e.code === 'PageUp') { e.preventDefault(); jumpWords(-100); }
  else if (e.code === 'PageDown') { e.preventDefault(); jumpWords(100); }
  else if (e.code === 'ArrowUp') { e.preventDefault(); adjustWpm(25); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); adjustWpm(-25); }
  else if (e.key === 'g' || e.key === 'G') {
    e.preventDefault();
    pause();
    dom.modalGoto.classList.add('active');
    updateGotoPreview();
    setTimeout(() => dom.gotoValueInput.focus(), 50);
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault();
    const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
    saveProgress();
  }
});

window.addEventListener('resize', () => updateStage());

setupGotoModal();
initApplicationState();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.log('SW no registrado:', err));
  });
}