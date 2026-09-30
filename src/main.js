import { createFile, DataStream } from 'mp4box';
import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const pad = (value) => String(value).padStart(2, '0');

class CircularFrameBuffer {
  constructor(capacity = 72) {
    this.capacity = capacity;
    this.slots = new Array(capacity);
    this.cursor = 0;
    this.size = 0;
  }

  add(frame, segment, time = frame.timestamp / 1_000_000) {
    const previous = this.slots[this.cursor];
    if (previous) previous.frame.close();
    this.slots[this.cursor] = { frame, segment, time };
    this.cursor = (this.cursor + 1) % this.capacity;
    this.size = Math.min(this.size + 1, this.capacity);
  }

  nearest(time) {
    let match = null;
    let distance = Infinity;
    for (const item of this.slots) {
      if (!item) continue;
      const nextDistance = Math.abs(item.time - time);
      if (nextDistance < distance) {
        distance = nextDistance;
        match = item;
      }
    }
    return match;
  }

  keepSegments(segments) {
    for (let index = 0; index < this.slots.length; index += 1) {
      const item = this.slots[index];
      if (item && !segments.has(item.segment)) {
        item.frame.close();
        this.slots[index] = undefined;
      }
    }
  }

  clear() {
    for (const item of this.slots) item?.frame.close();
    this.slots.fill(undefined);
  }
}

class SegmentedScrollVideo {
  constructor({ hero, canvas, fallback, status }) {
    this.hero = hero;
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.fallback = fallback;
    this.status = status;
    this.buffer = new CircularFrameBuffer(matchMedia('(max-width: 760px)').matches ? 60 : 120);
    this.loaded = new Set();
    this.loading = new Map();
    this.target = 0;
    this.current = 0;
    this.direction = 1;
    this.lastTarget = 0;
    this.lastDrawn = -1;
    this.lastFrame = null;
    this.lastTick = 0;
    this.mode = 'poster';
    this.manifest = null;
    this.profile = 'medium';
    this.raf = 0;
    this.destroyed = false;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.fallback.addEventListener('loadedmetadata', () => this.updateFallback());
    this.fallback.addEventListener('seeked', () => this.updateFallback());
  }

  async init() {
    this.manifest = await fetch('./media/hero-manifest.json').then((response) => {
      if (!response.ok) throw new Error('Manifest unavailable');
      return response.json();
    });

    this.profile = this.selectProfile();
    this.resizeObserver.observe(this.canvas);
    this.resize();

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window) || reducedMotion) {
      this.activateFallback(reducedMotion ? 'Immagine statica: movimento ridotto attivo.' : 'Riproduzione MP4 compatibile attiva.');
      return;
    }

    try {
      await Promise.race([
        this.loadSegment(0),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Decoder startup timeout')), 3500)),
      ]);
      document.body.classList.add('webcodecs-ready');
      this.mode = 'webcodecs';
      this.status.textContent = `Hero interattiva attiva, profilo ${this.profile}.`;
      this.loadSegment(1).catch(() => {});
      this.loadSegment(2).catch(() => {});
      this.tick();
    } catch (error) {
      console.warn('WebCodecs fallback:', error);
      this.activateFallback('Riproduzione MP4 compatibile attiva.');
    }
  }

  selectProfile() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const constrained = connection?.saveData || ['slow-2g', '2g', '3g'].includes(connection?.effectiveType);
    const lowMemory = navigator.deviceMemory && navigator.deviceMemory < 4;
    if (constrained || lowMemory || innerWidth < 700) return 'medium';
    if (innerWidth < 1024) return 'high';
    return 'full';
  }

  update(progress) {
    this.target = clamp(progress);
    this.direction = this.target >= this.lastTarget ? 1 : -1;
    this.lastTarget = this.target;
  }

  resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const width = Math.round(this.canvas.clientWidth * ratio);
    const height = Math.round(this.canvas.clientHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.context.imageSmoothingEnabled = true;
      this.context.imageSmoothingQuality = 'high';
      this.lastDrawn = -1;
      this.lastFrame = null;
    }
  }

  segmentUrl(index) {
    return this.manifest.profiles[this.profile].template.replace('{index}', pad(index));
  }

  async loadSegment(index) {
    const safeIndex = clamp(index, 0, this.manifest.segmentCount - 1);
    if (this.loaded.has(safeIndex)) return;
    if (this.loading.has(safeIndex)) return this.loading.get(safeIndex);

    const task = this.decodeSegment(safeIndex)
      .then(() => this.loaded.add(safeIndex))
      .finally(() => this.loading.delete(safeIndex));
    this.loading.set(safeIndex, task);
    return task;
  }

  decoderDescription(file, trackId) {
    const track = file.getTrackById(trackId);
    const entry = track?.mdia?.minf?.stbl?.stsd?.entries?.[0];
    const configBox = entry?.avcC || entry?.hvcC || entry?.vpcC || entry?.av1C;
    if (!configBox) return undefined;
    const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
    configBox.write(stream);
    return new Uint8Array(stream.buffer.slice(8));
  }

  async decodeSegment(index) {
    const response = await fetch(this.segmentUrl(index));
    if (!response.ok) throw new Error(`Segment ${index} unavailable`);
    const arrayBuffer = await response.arrayBuffer();
    arrayBuffer.fileStart = 0;

    await new Promise((resolve, reject) => {
      const file = createFile();
      let decoder;
      let completed = false;
      const bitmapCopies = [];

      file.onError = (message) => reject(new Error(message));
      file.onReady = (info) => {
        const track = info.videoTracks[0];
        if (!track) return reject(new Error('No video track'));
        const config = {
          codec: track.codec,
          codedWidth: track.video.width,
          codedHeight: track.video.height,
          description: this.decoderDescription(file, track.id),
          optimizeForLatency: true,
        };
        decoder = new VideoDecoder({
          output: (frame) => {
            const time = frame.timestamp / 1_000_000;
            const copy = createImageBitmap(frame)
              .then((bitmap) => this.buffer.add(bitmap, index, time))
              .finally(() => frame.close());
            bitmapCopies.push(copy);
          },
          error: reject,
        });
        decoder.configure(config);

        file.onSamples = async (_trackId, _user, samples) => {
          if (completed) return;
          completed = true;
          try {
            for (const sample of samples) {
              const timestamp = Math.round((index * this.manifest.segmentDuration + sample.cts / sample.timescale) * 1_000_000);
              decoder.decode(new EncodedVideoChunk({
                type: sample.is_sync ? 'key' : 'delta',
                timestamp,
                duration: Math.round((sample.duration / sample.timescale) * 1_000_000),
                data: sample.data,
              }));
            }
            await decoder.flush();
            await Promise.all(bitmapCopies);
            decoder.close();
            resolve();
          } catch (error) {
            reject(error);
          }
        };

        file.setExtractionOptions(track.id, null, { nbSamples: 1000, rapAlignement: true });
        file.start();
        file.flush();
      };

      file.appendBuffer(arrayBuffer);
      file.flush();
    });
  }

  drawFrame(frame) {
    if (!frame) return;
    const sourceWidth = frame.width;
    const sourceHeight = frame.height;
    const scale = Math.max(this.canvas.width / sourceWidth, this.canvas.height / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    this.context.drawImage(frame, (this.canvas.width - width) / 2, (this.canvas.height - height) / 2, width, height);
  }

  tick = (now = performance.now()) => {
    if (this.destroyed || this.mode !== 'webcodecs') return;
    const deltaTime = this.lastTick ? clamp((now - this.lastTick) / 1000, 0.001, 0.05) : 1 / 60;
    this.lastTick = now;
    const delta = this.target - this.current;
    const smoothing = 1 - Math.exp(-deltaTime * 9.5);
    const maxStep = (innerWidth < 760 ? 1.55 : 1.15) * deltaTime;
    this.current += Math.sign(delta) * Math.min(Math.abs(delta) * smoothing + deltaTime * 0.018, maxStep);

    const time = this.current * this.manifest.duration;
    const segment = Math.min(this.manifest.segmentCount - 1, Math.floor(time / this.manifest.segmentDuration));
    const offsets = this.direction >= 0 ? [-1, 0, 1, 2] : [-2, -1, 0, 1];
    const keep = new Set(offsets.map((offset) => clamp(segment + offset, 0, this.manifest.segmentCount - 1)));
    this.buffer.keepSegments(keep);
    for (const loaded of [...this.loaded]) if (!keep.has(loaded)) this.loaded.delete(loaded);

    for (const index of keep) {
      this.loadSegment(index).catch(() => {
        if (index === segment) this.activateFallback('Riproduzione MP4 compatibile attiva.');
      });
    }

    const nearest = this.buffer.nearest(time);
    if (nearest && nearest.frame !== this.lastFrame) {
      this.drawFrame(nearest.frame);
      this.lastFrame = nearest.frame;
      this.lastDrawn = nearest.time;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  activateFallback(message) {
    if (this.mode === 'fallback') return;
    this.mode = 'fallback';
    cancelAnimationFrame(this.raf);
    this.buffer.clear();
    document.body.classList.remove('webcodecs-ready');
    document.body.classList.add('fallback-active');
    this.status.textContent = message;
    this.fallback.pause();
    this.fallback.currentTime = this.target * (this.manifest?.duration || this.fallback.duration || 0);
  }

  updateFallback() {
    if (this.mode !== 'fallback' || !this.fallback.duration) return;
    const targetTime = this.target * this.fallback.duration;
    if (!this.fallback.seeking && Math.abs(this.fallback.currentTime - targetTime) > 0.025) {
      this.fallback.currentTime = targetTime;
    }
  }
}

const hero = document.querySelector('[data-hero]');
const scrubVideo = new SegmentedScrollVideo({
  hero,
  canvas: document.querySelector('#hero-canvas'),
  fallback: document.querySelector('#hero-fallback'),
  status: document.querySelector('#video-status'),
});

const beats = {
  one: document.querySelector('[data-beat="one"]'),
  two: document.querySelector('[data-beat="two"]'),
  three: document.querySelector('[data-beat="three"]'),
};
const progressBar = document.querySelector('[data-progress]');
const header = document.querySelector('[data-header]');
const darkSurfaces = [...document.querySelectorAll('.manifesto, .process, .path, .closing, .site-footer')];
const pathWords = document.querySelector('[data-path-words]');

const updateHeaderTheme = () => {
  const headerLine = header.getBoundingClientRect().height / 2;
  const overDarkSurface = darkSurfaces.some((surface) => {
    const bounds = surface.getBoundingClientRect();
    return bounds.top <= headerLine && bounds.bottom > headerLine;
  });
  header.classList.toggle('is-dark', overDarkSurface);
};

const updatePathProgress = () => {
  const bounds = pathWords.getBoundingClientRect();
  const progress = clamp((innerHeight * 0.82 - bounds.top) / (innerHeight * 0.65));
  const topProgress = clamp(progress / 0.36);
  const bottomProgress = clamp((progress - 0.36) / 0.34);
  const finalProgress = clamp((progress - 0.7) / 0.3);
  pathWords.style.setProperty('--path-progress', progress);
  pathWords.style.setProperty('--path-progress-top', topProgress);
  pathWords.style.setProperty('--path-progress-bottom', bottomProgress);
  pathWords.style.setProperty('--path-progress-final', finalProgress);
  pathWords.classList.toggle('is-complete', progress >= 0.96);
};

const envelope = (progress, start, peakStart, peakEnd, end) => {
  if (progress <= start || progress >= end) return 0;
  if (progress < peakStart) return (progress - start) / (peakStart - start);
  if (progress <= peakEnd) return 1;
  return 1 - (progress - peakEnd) / (end - peakEnd);
};

let ticking = false;
const updatePage = () => {
  ticking = false;
  const maxScroll = Math.max(1, hero.offsetHeight - innerHeight);
  const progress = clamp(-hero.getBoundingClientRect().top / maxScroll);
  scrubVideo.update(progress);
  scrubVideo.updateFallback();
  progressBar.style.transform = `scaleX(${progress})`;

  const values = {
    one: envelope(progress, -0.03, 0, 0.19, 0.3),
    two: envelope(progress, 0.25, 0.34, 0.5, 0.62),
    three: envelope(progress, 0.58, 0.67, 0.8, 0.91),
  };

  for (const [key, element] of Object.entries(beats)) {
    const value = values[key];
    element.style.opacity = value;
    element.style.transform = `translateY(${(1 - value) * 28}px)`;
    element.style.pointerEvents = value > 0.75 ? 'auto' : 'none';
  }
  updateHeaderTheme();
  updatePathProgress();
};

addEventListener('scroll', () => {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(updatePage);
  }
}, { passive: true });
addEventListener('resize', updatePage, { passive: true });

const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) entry.target.classList.add('is-visible');
}, { threshold: 0.14, rootMargin: '0px 0px -6% 0px' });
document.querySelectorAll('.reveal').forEach((element) => observer.observe(element));

const replayObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) entry.target.classList.toggle('is-in-view', entry.isIntersecting);
}, { threshold: 0.24 });
document.querySelectorAll('[data-replay-image], [data-replay-section]').forEach((element) => replayObserver.observe(element));

const menuToggle = document.querySelector('[data-menu-toggle]');
const closeMenu = () => {
  document.body.classList.remove('menu-open');
  menuToggle.setAttribute('aria-expanded', 'false');
};
menuToggle.addEventListener('click', () => {
  const open = document.body.classList.toggle('menu-open');
  menuToggle.setAttribute('aria-expanded', String(open));
});
document.querySelectorAll('[data-nav] a').forEach((link) => link.addEventListener('click', closeMenu));
addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });

const projectModal = document.querySelector('[data-project-modal]');
const projectForm = document.querySelector('[data-project-form]');
let modalTrigger = null;

const closeProjectModal = () => {
  if (!projectModal.open) return;
  projectModal.close();
};

const openProjectModal = (trigger) => {
  closeMenu();
  modalTrigger = trigger;
  if (!projectModal.open) projectModal.showModal();
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => projectForm.elements.nome.focus());
};

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-open-project-modal]');
  if (!trigger) return;
  event.preventDefault();
  openProjectModal(trigger);
});
document.querySelector('[data-close-project-modal]').addEventListener('click', closeProjectModal);
projectModal.addEventListener('click', (event) => {
  const bounds = projectModal.getBoundingClientRect();
  const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (outside) closeProjectModal();
});
projectModal.addEventListener('close', () => {
  document.body.classList.remove('modal-open');
  modalTrigger?.focus();
});

projectForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(projectForm);
  const lines = [
    `Nome: ${data.get('nome')}`,
    `Email: ${data.get('email')}`,
    `Brand / attività: ${data.get('brand')}`,
    `Sito attuale: ${data.get('sito') || 'Non indicato'}`,
    `Di cosa ha bisogno: ${data.get('bisogno')}`,
    `Obiettivo principale: ${data.get('obiettivo')}`,
    `Budget indicativo: ${data.get('budget') || 'Non indicato'}`,
    '',
    'Progetto:',
    data.get('progetto') || 'Nessuna descrizione aggiuntiva.',
  ];
  const subject = `Nuovo progetto W Motion — ${data.get('brand')}`;
  location.href = `mailto:hello@wmotion.it?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
  closeProjectModal();
});

updatePage();
scrubVideo.init().catch((error) => {
  console.warn('Hero initialization fallback:', error);
  scrubVideo.activateFallback('Riproduzione MP4 compatibile attiva.');
});
