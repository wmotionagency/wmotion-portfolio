import { createFile, DataStream } from 'mp4box';
import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const pad = (value) => String(value).padStart(2, '0');

class CircularFrameBuffer {
  constructor({ capacity = 24, maxBytes = 128 * 1024 * 1024 } = {}) {
    this.capacity = capacity;
    this.maxBytes = maxBytes;
    this.slots = new Array(capacity);
    this.cursor = 0;
    this.size = 0;
    this.bytes = 0;
    this.evictions = 0;
  }

  add(frame, segment, time, focus = time, direction = 1) {
    const frameWidth = frame.displayWidth || frame.codedWidth || frame.width;
    const frameHeight = frame.displayHeight || frame.codedHeight || frame.height;
    const bytes = frameWidth * frameHeight * 4;
    const score = (frameTime) => {
      const distance = Math.abs(frameTime - focus);
      const isBehind = frameTime < focus;
      const isWrongSide = direction >= 0 ? isBehind : !isBehind;
      return distance * (isWrongSide ? 1.35 : 1);
    };

    let slot = this.slots.findIndex((item) => !item);
    if (slot < 0 || this.bytes + bytes > this.maxBytes) {
      let worstScore = -1;
      let worstSlot = this.cursor;
      for (let index = 0; index < this.slots.length; index += 1) {
        const item = this.slots[index];
        if (!item) {
          worstSlot = index;
          worstScore = Infinity;
          break;
        }
        const itemScore = score(item.time);
        if (itemScore > worstScore) {
          worstScore = itemScore;
          worstSlot = index;
        }
      }
      if (this.size >= this.capacity && score(time) >= worstScore) {
        frame.close();
        this.evictions += 1;
        return false;
      }
      slot = worstSlot;
    }

    const previous = this.slots[slot];
    if (previous) {
      previous.frame.close();
      this.bytes -= previous.bytes;
      this.evictions += 1;
    } else {
      this.size += 1;
    }
    this.slots[slot] = { frame, segment, time, bytes };
    this.bytes += bytes;
    this.cursor = (slot + 1) % this.capacity;
    return true;
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
        this.bytes -= item.bytes;
        this.size -= 1;
        this.slots[index] = undefined;
      }
    }
  }

  hasSegment(segment) {
    return this.slots.some((item) => item?.segment === segment);
  }

  hasNear(time, tolerance) {
    return this.slots.some((item) => item && Math.abs(item.time - time) <= tolerance);
  }

  residentSegments() {
    return new Set(this.slots.filter(Boolean).map((item) => item.segment));
  }

  clear() {
    for (const item of this.slots) item?.frame.close();
    this.slots.fill(undefined);
    this.size = 0;
    this.bytes = 0;
  }
}

class SegmentedScrollVideo {
  constructor({ hero, canvas, fallback, status }) {
    this.hero = hero;
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.fallback = fallback;
    this.status = status;
    this.buffer = null;
    this.loaded = new Set();
    this.loading = new Map();
    this.compressed = new Map();
    this.downloading = new Map();
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
    this.started = false;
    this.destroyed = false;
    this.activeDecode = null;
    this.queuedDecode = null;
    this.lastRenderedFrameIndex = -1;
    this.lastFallbackFrameIndex = -1;
    this.metrics = {
      decodedSegments: 0,
      renderedFrames: 0,
      compressedBytes: 0,
      decodeTime: 0,
      discardedFrames: 0,
      supersededDecodes: 0,
    };
    this.resizeObserver = new ResizeObserver(() => this.resize());
  }

  async init() {
    this.manifest = await fetch('./media/hero-manifest.json').then((response) => {
      if (!response.ok) throw new Error('Manifest unavailable');
      return response.json();
    });

    this.profile = this.selectProfile();
    this.buffer = new CircularFrameBuffer(this.bufferPolicy());
    this.resizeObserver.observe(this.canvas);
    this.resize();

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window) || reducedMotion) {
      this.activateFallback(reducedMotion ? 'Immagine statica: movimento ridotto attivo.' : 'Riproduzione MP4 compatibile attiva.');
      this.start();
      return;
    }

    try {
      await Promise.race([
        this.loadSegment(0, { priority: 0 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Decoder startup timeout')), 3500)),
      ]);

      const firstFrame = this.buffer.nearest(0);
      if (!firstFrame) throw new Error('Initial frame unavailable');
      this.drawFrame(firstFrame.frame);
      this.lastFrame = firstFrame.frame;
      this.lastDrawn = firstFrame.time;
      this.lastRenderedFrameIndex = Math.round(firstFrame.time * this.manifest.fps);

      document.body.classList.add('webcodecs-ready');
      this.mode = 'webcodecs';
      this.status.textContent = `Hero interattiva attiva, profilo ${this.profile}.`;
      this.prefetchCompressed([1, 2]);
      this.start();
    } catch (error) {
      console.warn('WebCodecs fallback:', error);
      this.activateFallback('Riproduzione MP4 compatibile attiva.');
      this.start();
    }
  }

  bufferPolicy() {
    const mobile = matchMedia('(max-width: 760px)').matches;
    const memory = navigator.deviceMemory || (mobile ? 4 : 8);
    const maxBytes = mobile
      ? (memory < 4 ? 36 : 52) * 1024 * 1024
      : (this.profile === 'full' ? (memory >= 8 ? 176 : 128) : 96) * 1024 * 1024;
    const profile = this.manifest.profiles[this.profile];
    const bytesPerFrame = profile.width * profile.height * 4;
    const capacity = Math.max(12, Math.min(mobile ? 26 : 22, Math.floor(maxBytes / bytesPerFrame)));
    return { capacity, maxBytes };
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
    const clientWidth = this.canvas.clientWidth;
    const clientHeight = this.canvas.clientHeight;
    const targetWidth = Math.round(clientWidth * ratio);
    const targetHeight = Math.round(clientHeight * ratio);
    const profile = this.manifest?.profiles[this.profile];
    const sourceWidth = profile?.width || targetWidth;
    const sourceHeight = profile?.height || targetHeight;
    const canvasAspect = clientWidth / Math.max(1, clientHeight);
    const sourceAspect = sourceWidth / sourceHeight;
    const nativeWidth = canvasAspect <= sourceAspect ? sourceHeight * canvasAspect : sourceWidth;
    const nativeHeight = canvasAspect <= sourceAspect ? sourceHeight : sourceWidth / canvasAspect;
    const nativeScale = Math.min(1, nativeWidth / targetWidth, nativeHeight / targetHeight);
    const width = Math.round(targetWidth * nativeScale);
    const height = Math.round(targetHeight * nativeScale);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.context.imageSmoothingEnabled = true;
      this.context.imageSmoothingQuality = 'high';
      this.lastDrawn = -1;
      this.lastFrame = null;
      this.lastRenderedFrameIndex = -1;
    }
  }

  segmentUrl(index) {
    return this.manifest.profiles[this.profile].template.replace('{index}', pad(index));
  }

  async fetchSegment(index) {
    if (this.compressed.has(index)) {
      return this.compressed.get(index);
    }
    if (this.downloading.has(index)) return this.downloading.get(index);

    const task = (async () => {
      const response = await fetch(this.segmentUrl(index), { cache: 'force-cache' });
      if (!response.ok) throw new Error(`Segment ${index} unavailable`);
      const data = await response.arrayBuffer();
      this.compressed.set(index, data);
      this.metrics.compressedBytes += data.byteLength;
      return data;
    })().finally(() => this.downloading.delete(index));
    this.downloading.set(index, task);
    return task;
  }

  prefetchCompressed(indices) {
    for (const index of indices) {
      if (index < 0 || index >= this.manifest.segmentCount) continue;
      this.fetchSegment(index).catch(() => {});
    }
  }

  loadSegment(index, { force = false, priority = 1 } = {}) {
    const safeIndex = clamp(index, 0, this.manifest.segmentCount - 1);
    if (!force && this.loaded.has(safeIndex) && this.buffer.hasSegment(safeIndex)) return Promise.resolve(true);
    if (this.activeDecode?.index === safeIndex) return this.activeDecode.promise;
    if (this.queuedDecode?.index === safeIndex) return Promise.resolve(false);

    if (this.activeDecode) {
      return new Promise((resolve, reject) => {
        const request = { index: safeIndex, force, priority, resolve, reject };
        const targetSegment = Math.min(
          this.manifest.segmentCount - 1,
          Math.floor((this.target * this.manifest.duration) / this.manifest.segmentDuration),
        );
        const currentDistance = this.queuedDecode ? Math.abs(this.queuedDecode.index - targetSegment) : Infinity;
        const nextDistance = Math.abs(safeIndex - targetSegment);
        const shouldReplace = !this.queuedDecode
          || priority < this.queuedDecode.priority
          || (priority === this.queuedDecode.priority && nextDistance < currentDistance);
        if (shouldReplace) {
          this.queuedDecode?.resolve(false);
          if (this.queuedDecode) this.metrics.supersededDecodes += 1;
          this.queuedDecode = request;
        } else {
          resolve(false);
        }
      });
    }

    return this.startDecode(safeIndex, { force, priority });
  }

  startDecode(index, options) {
    const startedAt = performance.now();
    const task = this.decodeSegment(index)
      .then(() => {
        this.loaded.add(index);
        this.metrics.decodedSegments += 1;
        return true;
      })
      .finally(() => {
        this.metrics.decodeTime += performance.now() - startedAt;
        this.loading.delete(index);
        this.activeDecode = null;
        const next = this.queuedDecode;
        this.queuedDecode = null;
        if (next) {
          this.startDecode(next.index, next)
            .then(next.resolve, next.reject);
        }
      });
    this.activeDecode = { index, promise: task, ...options };
    this.loading.set(index, task);
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
    const compressed = await this.fetchSegment(index);
    const arrayBuffer = compressed.slice(0);
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
              .then((bitmap) => {
                const retained = this.buffer.add(
                  bitmap,
                  index,
                  time,
                  this.current * this.manifest.duration,
                  this.direction,
                );
                if (!retained) this.metrics.discardedFrames += 1;
              })
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
    const sourceWidth = frame.displayWidth || frame.codedWidth || frame.width;
    const sourceHeight = frame.displayHeight || frame.codedHeight || frame.height;
    const scale = Math.max(this.canvas.width / sourceWidth, this.canvas.height / sourceHeight);
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    this.context.drawImage(frame, (this.canvas.width - width) / 2, (this.canvas.height - height) / 2, width, height);
    this.metrics.renderedFrames += 1;
  }

  tick = (now = performance.now()) => {
    if (this.destroyed || !this.started) return;
    const deltaTime = this.lastTick ? clamp((now - this.lastTick) / 1000, 0.001, 0.05) : 1 / 60;
    this.lastTick = now;
    const delta = this.target - this.current;
    const smoothing = 1 - Math.exp(-deltaTime * 9.5);
    const maxStep = (innerWidth < 760 ? 1.55 : 1.15) * deltaTime;
    this.current += Math.sign(delta) * Math.min(Math.abs(delta), Math.abs(delta) * smoothing + deltaTime * 0.012, maxStep);

    const duration = this.manifest?.duration || this.fallback.duration || 0;
    const fps = this.manifest?.fps || 24;
    const targetFrameIndex = Math.round(this.current * duration * fps);
    const targetTime = duration ? Math.min(duration, targetFrameIndex / fps) : 0;

    if (this.mode === 'fallback') {
      if (
        this.fallback.duration
        && !this.fallback.seeking
        && targetFrameIndex !== this.lastFallbackFrameIndex
        && Math.abs(this.fallback.currentTime - targetTime) >= 0.5 / fps
      ) {
        this.fallback.currentTime = targetTime;
        this.lastFallbackFrameIndex = targetFrameIndex;
      }
      this.raf = requestAnimationFrame(this.tick);
      return;
    }

    if (this.mode !== 'webcodecs') {
      this.raf = requestAnimationFrame(this.tick);
      return;
    }

    const time = targetTime;
    const segment = Math.min(this.manifest.segmentCount - 1, Math.floor(time / this.manifest.segmentDuration));
    const segmentProgress = (time - segment * this.manifest.segmentDuration) / this.manifest.segmentDuration;
    const neighbor = this.direction >= 0 ? segment + 1 : segment - 1;
    const keep = new Set([segment - 1, segment, segment + 1].filter((index) => (
      index >= 0 && index < this.manifest.segmentCount
    )));
    this.buffer.keepSegments(keep);
    const resident = this.buffer.residentSegments();
    for (const loaded of [...this.loaded]) if (!resident.has(loaded)) this.loaded.delete(loaded);

    const targetSegment = Math.min(
      this.manifest.segmentCount - 1,
      Math.floor((this.target * this.manifest.duration) / this.manifest.segmentDuration),
    );
    if (Math.abs(this.target - this.current) > 0.08 && targetSegment !== segment) {
      this.loadSegment(targetSegment, { priority: 0 }).catch(() => {});
    }

    const forceCurrent = !this.buffer.hasNear(time, 1.5 / fps);
    this.loadSegment(segment, { force: forceCurrent, priority: 0 }).catch(() => {
      this.activateFallback('Riproduzione MP4 compatibile attiva.');
    });

    const shouldDecodeNeighbor = this.direction >= 0 ? segmentProgress > 0.34 : segmentProgress < 0.66;
    if (shouldDecodeNeighbor && neighbor >= 0 && neighbor < this.manifest.segmentCount) {
      this.loadSegment(neighbor, { priority: 1 }).catch(() => {});
    }
    this.prefetchCompressed([segment - 2, segment + 2, targetSegment - 1, targetSegment, targetSegment + 1]);

    const nearest = this.buffer.nearest(time);
    const nearestFrameIndex = nearest ? Math.round(nearest.time * fps) : -1;
    if (nearest && nearestFrameIndex !== this.lastRenderedFrameIndex) {
      this.drawFrame(nearest.frame);
      this.lastFrame = nearest.frame;
      this.lastDrawn = nearest.time;
      this.lastRenderedFrameIndex = nearestFrameIndex;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  activateFallback(message) {
    if (this.mode === 'fallback') return;
    this.mode = 'fallback';
    this.buffer?.clear();
    document.body.classList.remove('webcodecs-ready');
    document.body.classList.add('fallback-active');
    this.status.textContent = message;
    this.fallback.pause();
    this.fallback.preload = 'auto';
    const duration = this.manifest?.duration || this.fallback.duration || 0;
    if (duration && this.fallback.readyState >= 1) {
      this.fallback.currentTime = this.target * duration;
    }
    if (this.fallback.readyState === 0) this.fallback.load();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.lastTick = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  diagnostics() {
    return {
      mode: this.mode,
      profile: this.profile,
      ready: this.mode === 'webcodecs' ? Boolean(this.lastFrame) : this.fallback.readyState >= 2,
      targetProgress: this.target,
      currentProgress: this.current,
      compressedSegments: this.compressed.size,
      compressedBytes: this.metrics.compressedBytes,
      decodedSegments: this.metrics.decodedSegments,
      averageDecodeMs: this.metrics.decodedSegments ? this.metrics.decodeTime / this.metrics.decodedSegments : 0,
      renderedFrames: this.metrics.renderedFrames,
      discardedFrames: this.metrics.discardedFrames,
      supersededDecodes: this.metrics.supersededDecodes,
      bufferFrames: this.buffer?.size || 0,
      bufferBytes: this.buffer?.bytes || 0,
      bufferLimitBytes: this.buffer?.maxBytes || 0,
      bufferEvictions: this.buffer?.evictions || 0,
      canvasSize: [this.canvas.width, this.canvas.height],
    };
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
const darkSurfaces = [...document.querySelectorAll('.services, .process, .path, .closing, .site-footer')];
const pathWords = document.querySelector('[data-path-words]');
const layout = {
  heroTop: 0,
  heroRange: 1,
  headerLine: 0,
  darkRanges: [],
  pathTop: 0,
};
let headerIsDark = null;
let lastPathProgress = -1;
let lastHeroProgress = -1;

const documentTop = (element) => element.getBoundingClientRect().top + scrollY;

const updateHeaderTheme = (scrollPosition) => {
  const line = scrollPosition + layout.headerLine;
  const overDarkSurface = layout.darkRanges.some(([top, bottom]) => top <= line && bottom > line);
  if (overDarkSurface === headerIsDark) return;
  headerIsDark = overDarkSurface;
  header.classList.toggle('is-dark', overDarkSurface);
};

const updatePathProgress = (scrollPosition) => {
  const viewportTop = layout.pathTop - scrollPosition;
  const progress = clamp((innerHeight - viewportTop) / (innerHeight * 0.58));
  if (Math.abs(progress - lastPathProgress) < 0.001) return;
  lastPathProgress = progress;
  const topProgress = clamp(progress / 0.36);
  const bottomProgress = clamp((progress - 0.36) / 0.34);
  const finalProgress = clamp((progress - 0.7) / 0.3);
  pathWords.style.setProperty('--path-progress', progress);
  pathWords.style.setProperty('--path-progress-top', topProgress);
  pathWords.style.setProperty('--path-progress-bottom', bottomProgress);
  pathWords.style.setProperty('--path-progress-final', finalProgress);
  pathWords.classList.toggle('is-complete', finalProgress >= 0.995);
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
  const scrollPosition = scrollY;
  const progress = clamp((scrollPosition - layout.heroTop) / layout.heroRange);
  scrubVideo.update(progress);
  if (Math.abs(progress - lastHeroProgress) >= 0.0001) {
    lastHeroProgress = progress;
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
  }
  updateHeaderTheme(scrollPosition);
  updatePathProgress(scrollPosition);
};

const measureLayout = () => {
  layout.heroTop = documentTop(hero);
  layout.heroRange = Math.max(1, hero.offsetHeight - innerHeight);
  layout.headerLine = header.offsetHeight / 2;
  layout.darkRanges = darkSurfaces.map((surface) => {
    const top = documentTop(surface);
    return [top, top + surface.offsetHeight];
  });
  layout.pathTop = documentTop(pathWords);
  lastHeroProgress = -1;
  lastPathProgress = -1;
  scrubVideo.resize();
  updatePage();
};

addEventListener('scroll', () => {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(updatePage);
  }
}, { passive: true });
let resizeTicking = false;
addEventListener('resize', () => {
  if (resizeTicking) return;
  resizeTicking = true;
  requestAnimationFrame(() => {
    resizeTicking = false;
    measureLayout();
  });
}, { passive: true });

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

const bootstrap = async () => {
  measureLayout();
  await scrubVideo.init().catch((error) => {
    console.warn('Hero initialization fallback:', error);
    scrubVideo.activateFallback('Riproduzione MP4 compatibile attiva.');
    scrubVideo.start();
  });
  measureLayout();
  document.documentElement.dataset.heroProfile = scrubVideo.profile;
  document.documentElement.dataset.heroMode = scrubVideo.mode;
  window.__WMotionHeroDiagnostics = () => scrubVideo.diagnostics();
};

bootstrap().catch((error) => {
  console.error('Hero recovery:', error);
  scrubVideo.activateFallback('Riproduzione MP4 compatibile attiva.');
  scrubVideo.start();
});

document.fonts.ready.then(measureLayout).catch(() => {});
addEventListener('load', measureLayout, { once: true });
