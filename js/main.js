'use strict';

/* Eagle "GIF Studio" window plugin.
 * Runs inside Eagle's Chromium/Node runtime. Node modules are available via require().
 * Requires the FFmpeg dependency plugin (declared in manifest.json under dependencies).
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const VIDEO_EXTS = new Set([
  'mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpg', 'mpeg', 'wmv',
  'flv', 'ts', 'm2ts', 'mts', '3gp', 'rm', 'rmvb', 'm4a', 'ogv',
]);

let state = {
  ffmpegBin: '',
  ffprobeBin: '',
  selected: [],      // candidate video items from Eagle
  current: null,     // the item being converted
  cancelRequested: false,
  child: null,       // active child process
  previewPath: null, // tmp GIF shown in the preview view
};

const $ = (id) => document.getElementById(id);

function show(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $('view-' + name).classList.remove('hidden');
}

function showError(msg) {
  const bar = $('error-bar');
  bar.textContent = msg;
  bar.classList.remove('hidden');
}

function hideError() {
  $('error-bar').classList.add('hidden');
}

function formatDuration(sec) {
  if (!isFinite(sec) || sec < 0) return '–';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m ${s.toFixed(1)}s`;
  if (m > 0) return `${m}m ${s.toFixed(1)}s`;
  return `${sec.toFixed(1)}s`;
}

// Live estimate for the showcase flow. Renders "… ~1m 20s" for under 2 minutes,
// "… about 3 minutes" otherwise. Passing `final` (encode pass) scales what we
// measure: pass 1 segments are each `per` seconds long, the encode is one pass.
function etaLine(text, estSec, final) {
  const remaining = estSec > 0 ? estSec : 0;
  const preview = final
    ? `Showcase (2/2) — encoding GIF…`
    : `Showcase (1/2) — rendering effects…`;
  const estimate = remaining >= 120
    ? `about ${Math.round(remaining / 60)} minutes`
    : remaining >= 1
      ? `~${formatDuration(remaining)}`
      : '';
  $('eta-line').textContent = `${preview}${estimate ? ` · ${estimate}` : ''}`;
  if (text) $('status').textContent = text;
}

function runProcess(bin, args, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    state.child = proc;
    let stderr = '';
    let progress = 0;

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk) => {
      if (!onProgress) return;
      const m = chunk.match(/out_time_us=(\d+)/);
      if (m) onProgress(Number(m[1]));
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      state.child = null;
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Process exited with code ${code}`));
    });
  });
}

function probeVideo(filePath) {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ];
  // ffprobe's JSON goes to stdout; ffmpeg-style progress lines don't apply here.
  return new Promise((resolve, reject) => {
    const proc = spawn(state.ffprobeBin, args, { windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error('Could not parse ffprobe output: ' + e.message)); }
      } else {
        reject(new Error(err.trim() || `ffprobe exited with code ${code}`));
      }
    });
  });
}

function parseProbe(probe) {
  const info = { duration: null, width: null, height: null, fps: null };
  const stream = (probe.streams || []).find((s) => s.codec_type === 'video');
  if (stream) {
    if (stream.width) info.width = stream.width;
    if (stream.height) info.height = stream.height;
    if (stream.r_frame_rate) {
      const [n, d] = stream.r_frame_rate.split('/').map(Number);
      if (n && d && isFinite(n / d)) info.fps = Math.round(n / d);
    }
  }
  if (probe.format && probe.format.duration) {
    info.duration = parseFloat(probe.format.duration);
  }
  return info;
}

function getVideoItems(items) {
  return (items || []).filter((it) => {
    if (!it || !it.filePath) return false;
    const ext = String(it.ext || '').toLowerCase() || path.extname(it.filePath).replace(/^\./, '').toLowerCase();
    return VIDEO_EXTS.has(ext);
  });
}

function sanitize(name) {
  return String(name || 'gif')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'gif';
}

function safeImport(folders) {
  return Array.isArray(folders) ? folders.filter(Boolean) : [];
}

/* ------------------------------------------------------------------ *
 *  Views
 * ------------------------------------------------------------------ */

function renderSource() {
  const it = state.current;
  $('source-name').textContent = it.name || path.basename(it.filePath || '');
  const parts = [];
  if (it.width && it.height) parts.push(`${it.width}×${it.height}`);
  if (state.probeInfo && state.probeInfo.duration) parts.push(`${formatDuration(state.probeInfo.duration)}`);
  if (state.probeInfo && state.probeInfo.fps) parts.push(`${state.probeInfo.fps} fps`);
  $('source-meta').textContent = parts.join(' · ') || 'Video file';
  $('source-path').textContent = it.filePath || '';

  const picker = $('video-picker');
  picker.innerHTML = '';
  if (state.selected.length > 1) {
    state.selected.forEach((item, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${item.name || path.basename(item.filePath)}${item.ext ? ' .' + item.ext : ''}`;
      picker.appendChild(opt);
    });
    picker.value = String(state.selected.indexOf(it));
    picker.classList.remove('hidden');
  } else {
    picker.classList.add('hidden');
  }
}

async function loadSelected() {
  hideError();
  try {
    const items = await eagle.item.getSelected();
    const videos = getVideoItems(items);
    if (!videos.length) {
      show('no-video');
      return;
    }
    state.selected = videos;
    state.current = videos[0];
    show('ready');
    renderSource();
    await refreshProbe();
  } catch (err) {
    show('error');
    $('fatal-msg').textContent = 'Could not read the Eagle selection: ' + err.message;
  }
}

async function refreshProbe() {
  const it = state.current;
  if (!it) return;
  try {
    const probe = await probeVideo(it.filePath);
    state.probeInfo = parseProbe(probe);
  } catch (err) {
    state.probeInfo = null;
    showError('Could not probe the video. FFmpeg error: ' + err.message);
  }
  if (!state.probeInfo) return;
  if (state.probeInfo.duration && !$('end').value) {
    $('end').value = state.probeInfo.duration.toFixed(1);
  }
  if (state.probeInfo.fps) $('fps').value = String(state.probeInfo.fps);
}

/* ------------------------------------------------------------------ *
 *  Showcase checklist
 * ------------------------------------------------------------------ */

function renderShowcase() {
  const wrap = $('showcase-effects');
  if (!wrap) return;
  wrap.innerHTML = '';
  EFFECT_LIST.forEach((eff) => {
    const label = document.createElement('label');
    label.className = 'effect-chip';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.dataset.effect = eff;
    const span = document.createElement('span');
    span.textContent = EFFECT_LABELS[eff] || eff;
    label.appendChild(cb);
    label.appendChild(span);
    wrap.appendChild(label);
  });
}

/* ------------------------------------------------------------------ *
 *  Conversion
 * ------------------------------------------------------------------ */

const PRESETS = {
  high: 640,
  medium: 480,
  low: 320,
};

// Shared chain metadata: effective fps + output dims after base crop/scale.
function buildChainMeta(it, settings) {
  const fps = settings.fps;
  const speed = parseFloat(settings.speed) || 1;
  const width = settings.width || PRESETS[settings.preset] || 480;
  const srcW = it.width > 0 ? it.width : null;
  const srcH = it.height > 0 ? it.height : null;
  const effFps = fps / (settings.frameSkip > 1 ? settings.frameSkip : 1);
  const shapeAR = settings.shape !== 'original' && srcW && srcH
    ? ({ square: 1, portrait: 9 / 16, landscape: 16 / 9 }[settings.shape] || srcW / srcH)
    : (srcW && srcH ? srcW / srcH : 16 / 9);
  const outW = width;
  const outH = Math.max(2, Math.round(outW / shapeAR));
  return { speed, srcW, srcH, effFps, outW, outH, shapeAR };
}

// Build the filter chain for the main input (pre-style base + one style), as a
// bare chain string (no leading [0:v] label). `parts` is the base chain
// (setpts etc). Everything happens BEFORE the color-quantize step so the
// palette is computed from the final look.
function mainInput(it, settings, style, meta, parts) {
  const st = style ? STYLES[style] : null;
  const { srcW, srcH, effFps, outW, outH, shapeAR } = meta;
  const c = parts.slice();
  c.push(`fps=${effFps}`);
  if (settings.shape !== 'original' && srcW && srcH) {
    const AR = { square: 1, portrait: 9 / 16, landscape: 16 / 9 }[settings.shape] || 1;
    if (srcW / srcH > AR) {
      const cw = Math.round(srcH * AR);
      c.push(`crop=${cw}:${srcH}:(in_w-${cw})/2:0`);
    } else {
      const ch = Math.round(srcW / AR);
      c.push(`crop=${srcW}:${ch}:0:(in_h-${ch})/2`);
    }
    c.push(`scale=${outW}:-2:flags=lanczos`);
  } else if (srcW) {
    c.push(`scale=${outW}:-1:flags=lanczos`);
  }
  // Color filters.
  if (settings.filter !== 'none') c.push(...FILTER_FX[settings.filter]);
  // Style stage: deterministic filters that produce [vmain] directly.
  if (st && st.chain && st.chain.length) c.push(...st.chain);
  let s = c.join(',');
  // Auto downscale keeps per-frame cost bounded for heavy style filters.
  const vw = style && (style === 'ascii' || style === '8bit') ? 96
    : style && (style === 'kaleidoscope' || style === 'zoomburst') ? Math.min(outW, 420)
    : outW;
  const vh = Math.max(2, Math.round(vw / shapeAR));
  if (style && STYLES[style].forceScale) {
    s += `,scale=${vw}:${vh}:flags=neighbor`;
  }
  // Small-format styles (8bit/ascii/kaleidoscope) run at a low working res;
  // upscale to the requested output dims so the GIF isn't tiny.
  if (style && (style === '8bit' || style === 'ascii' || style === 'kaleidoscope')) {
    s += `,scale=${outW}:${outH}:flags=neighbor`;
  }
  return s;
}

// Build the full input graph (from [0:v] to [vmain]) for a specific style,
// including post-main stages (chroma, pads, rounded alpha, bars, caption,
// polaroid, subtitles). Used by the normal conversion AND by the showcase /
// export features so every effect renders identically.
function buildInputChainFor(it, settings, styleKey) {
  const meta = buildChainMeta(it, settings);
  const style = styleKey && styleKey !== 'none' ? styleKey : null;
  const st = style ? STYLES[style] : null;
  const composite = st && st.composite ? st.composite : null;
  const boomerang = settings.motion === 'boomerang';
  const reverse = settings.motion === 'reverse';
  const fwd = meta.speed !== 1 ? [`setpts=PTS/${meta.speed}`] : [];
  const rev = [...fwd, 'reverse'];
  const compositeSrc = composite ? `;${composite}` : '';

  // Every chain that reads the source MUST be prefixed with [0:v]: the file
  // also carries audio, so an implicit input would make ffmpeg fail to resolve
  // the labels ("Stream specifier 'vmain' matches no streams").
  let inputChain;
  if (composite) {
    // Composite styles: main chain -> [vmain0], then split into the base frame
    // [vm0] and the layer input [over0]. The synthetic overlay is produced
    // from [over0] (a source filter can't size itself here) and composited
    // onto [vm0].
    inputChain = `[0:v]${mainInput(it, settings, style, meta, fwd)}[vmain0];[vmain0]split=2[vm0][over0]${compositeSrc}[over];[vm0][over]overlay=0:0:shortest=1[vmain]`;
  } else if (boomerang) {
    inputChain = `[0:v]${mainInput(it, settings, style, meta, fwd)}[fwd];[0:v]${mainInput(it, settings, style, meta, rev)}[rev];[fwd][rev]concat=n=2:v=1:a=0[vmain]`;
  } else if (reverse) {
    inputChain = `[0:v]${mainInput(it, settings, style, meta, rev)}[vmain]`;
  } else {
    inputChain = `[0:v]${mainInput(it, settings, style, meta, fwd)}[vmain]`;
  }

  // Optional chroma key (before overlays).
  if (settings.chroma) {
    const col = settings.chromaColor || '0x00FF00';
    inputChain += `;[vmain]chromakey=color=${col}:similarity=${settings.chromaSim || 0.1}[vmain]`;
  }

  // Post-main composite: style pads, rounded/alpha, cinematic frames,
  // caption, polaroid. Subtitles keep applying via a style-agnostic route.

  // Padding so zoom/lens effects don't show clipped edges.
  if (st && st.pad) inputChain += `;[vmain]pad=${st.pad}[vmain]`;

  // Rounded corners => alpha; also required by any style with a frame/polaroid.
  if (st && st.alpha) {
    const rr = st.rounded || 12;
    // Rounded-corner alpha via geq. The expression MUST be single-quoted: the
    // graph parser splits chains on commas, so an unquoted r(X,Y) or clip(...)
    // would fragment the graph. r/g/b default to identity when omitted. The
    // alpha plane is 8-bit (0-255), so the 0..1 shape must be scaled by 255:
    // unscaled, every pixel rounds to 0 (fully transparent) and the frame
    // vanishes. pow() is required here — `^` is not exponentiation in geq.
    inputChain += `;[vmain]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(1-0.8*pow(max(abs((X-(W/2))/(W/2)),abs((Y-(H/2))/(H/2))),${rr}),0,1)'[vmain]`;
  }

  // Cinematic letterbox bars (pillarbox for portrait).
  if (st && st.bars) {
    const hh = st.bars;
    inputChain += `;[vmain]pad=iw:ih+${hh * 2}:0:${hh}:color=black[vmain]`;
  }

  // Caption overlay (drawn after frame/alpha so text is crisp).
  if (settings.caption && settings.caption.trim()) {
    const size = Math.max(8, parseInt(settings.captionSize, 10) || 32);
    const pos = settings.captionPos || 'middle';
    const y = pos === 'top' ? '20' : pos === 'bottom' ? 'h-th-20' : '(h-th)/2';
    // Animated captions scroll left-to-right; `\,` is ffmpeg's escaped comma.
    const x = settings.captionAnim ? 'mod(t*60\\,w+tw)-tw' : '(w-tw)/2';
    const esc = String(settings.caption).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
    inputChain += `;[vmain]drawtext=${DRAWTEXT_FONT}text='${esc}':fontsize=${size}:fontcolor=${settings.captionColor || 'white'}:x=${x}:y=${y}[vmain]`;
  }

  // Polaroid frame: white border + caption text below the image. The image is
  // padded into the top-left so the white band surrounds it (drawbox t=fill
  // would paint white over the whole frame).
  if (st && st.polaroid) {
    inputChain += `;[vmain]pad=iw+${st.polaroid.padX * 2}:ih+${st.polaroid.padY * 2 + st.polaroid.captionH}:${st.polaroid.padX}:${st.polaroid.padY}:color=white` +
      `,drawtext=${DRAWTEXT_FONT}text='${st.polaroid.caption}':fontcolor=#4a4a55:fontsize=${st.polaroid.font}:x=(w-text_w)/2:y=h-${st.polaroid.captionH - 6}[vmain]`;
  }

  // Subtitles (style-agnostic).
  if (settings.subs && settings.subs.trim()) {
    const sf = subsPath(settings.subs);
    inputChain += `;[vmain]subtitles=${sf}[vmain]`;
  }

  return inputChain;
}

function buildArgs(it, settings) {
  const inPath = it.filePath;
  const style = settings.style && settings.style !== 'none' ? settings.style : null;
  const st = style ? STYLES[style] : null;
  const inputChain = buildInputChainFor(it, settings, style);

  // Quantization (palette) step feeds off [vmain].
  const paletteMode = settings.palette === 'fast' ? '1-pass' : 'best';
  const maxColors = settings.colors || 256;
  const dither = settings.dither && settings.dither !== 'none' ? settings.dither : 'none';
  // Chroma key, transparency, and any alpha style (rounded/polaroid) produce an
  // alpha channel that GIF paletteuse must preserve via alpha_threshold.
  const alpha = settings.transparency || settings.chroma || (st && st.alpha);
  const reserve = alpha ? ':reserve_transparent=1' : '';
  const alphaUse = alpha ? ':alpha_threshold=128' : '';

  // Pass 1 (2-pass): compute the palette from the fully-transformed video.
  const genChain = `${inputChain};[vmain]palettegen=max_colors=${maxColors}${reserve}[pal]`;

  // Pass 2 (2-pass): apply the pre-computed palette. The palette is the second
  // input file, so paletteuse consumes [1:v]. 1-pass regenerates inline.
  let useChain;
  if (paletteMode === 'best') {
    useChain = `${inputChain};[vmain][1:v]paletteuse=dither=${dither}${alphaUse}[vout]`;
  } else {
    useChain = `${inputChain};[vmain]split[qs][qo];[qs]palettegen=max_colors=${maxColors}${reserve}[pal];[qo][pal]paletteuse=dither=${dither}${alphaUse}[vout]`;
  }

  const start = Math.max(0, settings.start || 0);
  let end = settings.end != null && isFinite(settings.end) && settings.end > start ? settings.end : null;
  if (end != null && settings.clipDuration != null) end = Math.min(end, settings.clipDuration);
  const trim = ['-ss', String(start)];
  if (end != null) trim.push('-t', String(end - start));

  const repeat = settings.loopMode === 'forever' ? 0
    : settings.loopMode === 'count' ? Math.max(1, Math.floor(settings.loopCount || 1))
    : -1;

  let pass1 = null;
  if (paletteMode === 'best') {
    pass1 = [
      '-y', ...trim, '-i', inPath,
      '-filter_complex', genChain,
      '-map', '[pal]', '-frames:v', '1',
      '-update', '1',
      settings.palettePath,
    ];
  }

  const pass2 = [
    '-y', '-progress', 'pipe:1', ...trim, '-i', inPath,
    ...(paletteMode === 'best' ? ['-i', settings.palettePath] : []),
    '-filter_complex', useChain,
    '-map', '[vout]',
    '-loop', String(repeat),
    settings.out,
  ];
  return { pass1, pass2 };
}

// Color filter chains (applied AFTER scale, BEFORE quantization).
const FILTER_FX = {
  grayscale: ['hue=s=0'],
  sepia: ['colorchannelmixer=rr=.393:rg=.769:rb=.189:gr=.349:gg=.686:gb=.168:br=.272:bg=.534:bb=.131'],
  warm: ['colorbalance=rs=.2:gs=.05:bs=-.2'],
  cool: ['colorbalance=rs=-.2:gs=.05:bs=.2'],
  vivid: ['eq=saturation=1.6:contrast=1.1'],
  cinematic: ['eq=contrast=1.15:brightness=-0.04:saturation=0.9,colorbalance=rs=.1:gs=.05:bs=-.1'],
  vignette: ['vignette=PI/4'],
  invert: ['negate'],
};

// Vaporwave: use a neon-pink/cyan-duotone LUT via curves.
const VAPORWAVE = 'hue=s=0,colorchannelmixer=rr=1.9:rg=0.4:rb=0.5:gr=0.1:gg=0.55:gb=0.35:br=0.6:bg=0.2:bb=1.5,eq=saturation=2.0:contrast=1.1';

// drawtext needs an explicit font file in the gyan ffmpeg build (fontconfig has
// no default config here, and omitting fontfile segfaults). Arial ships with
// every Windows install. Declared before STYLES because styles embed it.
const DRAWTEXT_FONT = "fontfile='C\\:/Windows/Fonts/arial.ttf':";

// Style effects. Filters that only touch [vmain] use `chain`; composites that
// need a second synthetic input (noise, rain/snow, dust) use `composite` and
// emit `[vout]`. `forceScale` downscales deterministically; `pad` / `bars` /
// `alpha` / `rounded` / `polaroid` drive the post-main stage.
const STYLES = {
  glitch: {
    chain: ['hue=h=6*sin(2*PI*t)*3:s=1.6', 'eq=contrast=1.25:brightness=0.02', 'noise=alls=14:allf=t+u', 'hflip'],
    forceScale: null,
  },
  pixelsort: {
    chain: ['eq=contrast=1.4:saturation=1.5', 'split[a][b];[a]scale=1:ih:flags=neighbor[m];[b][m]overlay=0:0:shortest=1', 'hue=s=1.4'],
  },
  '8bit': {
    chain: ['scale=96:-1:flags=neighbor', 'hue=s=2.2', 'noise=alls=10:allf=t'],
    forceScale: null,
  },
  cinemagraph: {
    chain: ['select=eq(n\\,0),setpts=N', 'noise=alls=18:allf=t+u'],
  },
  vaporwave: {
    chain: [VAPORWAVE, 'eq=saturation=2.2:contrast=1.1'],
    pad: 'iw+80:ih+40:40:20:color=#1b0533',
  },
  duotone: {
    chain: ['hue=s=0,colorchannelmixer=rr=.55:rg=.5:rb=.3:gr=.2:gg=.65:gb=.55:br=.35:bg=.4:bb=.85'],
  },
  ascii: {
    chain: ['scale=96:54:flags=neighbor', 'lutrgb=r=val*1.1:g=val*1.1:b=val*1.1', 'format=gray'],
    forceScale: [96, 54],
  },
  rounded: { alpha: true, rounded: 16 },
  polaroid: {
    alpha: true,
    rounded: 6,
    polaroid: { padX: 16, padY: 16, captionH: 38, font: 18, caption: 'capture' },
  },
  lightleak: {
    // Same geq=lum chroma trap as strobe: cb/cr must be passed through.
    chain: ["geq=lum='lum(X\\,Y)+40*(sin((X+Y)/30+2*PI*T)*0.5+0.5)':cb='cb(X\\,Y)':cr='cr(X\\,Y)'", 'noise=alls=6:allf=t'],
  },
  rain: {
    composite: '[over0]format=rgba,geq=r=\'255*mod((X+Y/3)/8+4*T\\,1)\':g=\'255*mod((X+Y/3)/8+4*T\\,1)\':b=\'255*mod((X+Y/3)/8+4*T\\,1)\':a=\'255*min(0.25\\,mod((X+Y/3)/8+4*T\\,1)*0.5)\'',
    forceScale: null,
  },
  snow: {
    composite: '[over0]format=rgba,geq=r=\'255*(sin(X*3.1+T*9)+1)/2\':g=\'255*(sin(X*3.1+T*9)+1)/2\':b=\'255*(sin(X*3.1+T*9)+1)/2\':a=\'255*0.35*((sin(X*5.3+T*12)+1)/2)\'',
    forceScale: null,
  },
  dust: {
    composite: '[over0]format=rgba,geq=r=\'255*(sin(X*7.7+T*17)+1)/2\':g=\'255*(sin(X*7.7+T*17)+1)/2\':b=\'255*(sin(X*7.7+T*17)+1)/2\':a=\'255*0.12*((sin(X*11.3+T*29)+1)/2)\'',
    forceScale: null,
  },
  kaleidoscope: {
    // 4-way mirror via xstack. The hstack/vstack variant segfaults this ffmpeg
    // build on portrait sources (uneven intermediate dims), and xstack stays
    // even throughout.
    chain: ['scale=240:-2:flags=lanczos,split=4[a][b][c][d];[b]hflip[bx];[c]vflip[cy];[d]hflip,vflip[dx];[a][bx][cy][dx]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0,scale=480:-1:flags=neighbor'],
    forceScale: [480, 240],
  },
  zoomburst: {
    chain: ['scale=iw*1.6:ih*1.6:flags=lanczos', 'crop=iw/1.6:ih/1.6:((iw-iw/1.6)/2)+((iw/1.6)*0.15*sin(2*PI*t*3)):((ih-ih/1.6)/2)'],
  },
  colorcycle: {
    chain: ['hue=h=2*PI*t*10'],
  },
  scanlines: {
    chain: ['drawgrid=w=iw:h=2:t=1:c=black@0.5'],
  },
  rgbshake: {
    chain: ['format=rgb24,rgbashift=rh=9:bh=-9', 'crop=iw-6:ih:3+3*sin(2*PI*t*8):0'],
  },
  thermal: {
    chain: ['hue=s=0,format=rgb24', "lutrgb=r='clip(2*val-120,0,255)':g='clip(1.5*val-40,0,255)':b='clip(200-2*val,0,255)'"],
  },
  nightvision: {
    chain: ['hue=s=0,format=rgb24,colorchannelmixer=rr=0:rg=0.9:rb=0.1:gr=0:gg=1:gb=0:br=0:bg=0.5:bb=0.3',
      'drawgrid=w=iw/2:h=ih/2:t=1:c=green@0.5',
      `drawtext=${DRAWTEXT_FONT}text='REC':fontcolor=green@0.85:fontsize=15:x=12:y=10`,
      `drawtext=${DRAWTEXT_FONT}text='BATT 100%':fontcolor=green@0.85:fontsize=15:x=12:y=h-26`],
  },
  xray: {
    chain: ['negate,eq=contrast=1.6:saturation=0.2'],
  },
  matrix: {
    chain: ['hue=s=0,eq=brightness=-0.3,format=rgb24,colorchannelmixer=rr=0.06:rg=0.45:rb=0.06:gr=0.04:gg=0.4:gb=0.04:br=0.03:bg=0.35:bb=0.06'],
    composite: '[over0]format=rgba,geq=r=\'0\':g=\'255*mod((X+Y/3)/6+6*T\\,1)\':b=\'0\':a=\'255*min(0.45\\,mod((X+Y/3)/6+6*T\\,1)*0.55)\'',
  },
  mirror: {
    chain: ['crop=iw/2:ih:0:0,split[a][b];[a]hflip[x];[b][x]hstack=inputs=2'],
  },
  splitgrid: {
    chain: ['crop=iw/2:ih/2:0:0,split=4[a][b][c][d];[a][b]hstack[h1];[c][d]hstack[h2];[h1][h2]vstack'],
  },
  posterize: {
    chain: ['format=rgb24', "lutrgb=r='round(val/64)*64':g='round(val/64)*64':b='round(val/64)*64'"],
  },
  solarize: {
    chain: ['format=rgb24', "lutrgb=r='if(gt(val,128),255-val,val)':g='if(gt(val,128),255-val,val)':b='if(gt(val,128),255-val,val)'"],
  },
  glow: {
    chain: ['format=rgb24,split=2[m][o];[m]gblur=sigma=10[g];[o][g]blend=all_mode=screen'],
  },
  trails: {
    chain: ['tmix=frames=5'],
  },
  grain: {
    chain: ['noise=alls=22:allf=t+u,eq=contrast=1.05'],
  },
  blueprint: {
    chain: ['format=gray,edgedetect=low=0.05:high=0.15:mode=colormix,negate,format=rgb24', "lutrgb=r='val':g='val':b='clip(val*0.5+60,0,255)'", 'drawgrid=w=iw/4:h=ih/4:t=1:c=blue@0.25'],
  },
  prism: {
    chain: ['format=rgb24,rgbashift=rh=9:bh=-9', 'split=2[m][o];[m]gblur=sigma=6[g];[o][g]blend=all_mode=screen'],
  },
  emberdust: {
    chain: ['eq=contrast=1.1:saturation=1.15'],
    composite: '[over0]format=rgba,geq=r=\'200*(0.7+0.5*sin(X*1.7+Y*2.3+8*T))\':g=\'120*(0.7+0.5*sin(X*1.7+Y*2.3+8*T))\':b=\'30*(0.7+0.5*sin(X*1.7+Y*2.3+8*T))\':a=\'255*0.5*(0.6+0.4*sin(X*2.9+Y*3.7+13*T))\'',
  },
  neonrain: {
    chain: ['eq=saturation=1.4:contrast=1.15'],
    composite: '[over0]format=rgba,geq=r=\'255*(0.4+0.3*sin(X*1.3+Y*3.1+7*T))\':g=\'80*(0.4+0.3*sin(X*1.3+Y*3.1+7*T))\':b=\'255*(0.4+0.3*sin(X*1.3+Y*3.1+7*T))\':a=\'255*0.4*(0.5+0.4*sin(Y*2.7+T*11))\'',
  },
  fog: {
    chain: ['format=rgb24,geq=r=\'r(X,Y)+15*(sin(X*0.02+T*0.8)+1)*0.5\':g=\'g(X,Y)+18*(sin(X*0.02+T*0.8)+1)*0.5\':b=\'b(X,Y)+25*(sin(X*0.02+T*0.8)+1)*0.5\''],
  },
  handheld: {
    chain: ['crop=iw-16:ih-16:8+4*sin(2*PI*t*2.2):6+4*cos(2*PI*t*1.7)'],
  },
  emboss: {
    chain: ['format=gray,colorchannelmixer=rr=.8:rg=.8:rb=.8:gr=1.1:gg=1.1:gb=1.1:br=.5:bg=.5:bb=.5,format=gray,edgedetect=low=0.08:high=0.25:mode=colormix,negate', 'noise=alls=4:allf=t'],
  },
  watercolor: {
    chain: ['split=2[m][o];[m]gblur=sigma=8[g];[o][g]blend=all_mode=lighten', 'noise=alls=6:allf=t'],
  },
  paper: {
    chain: ['noise=alls=14:allf=t+u', 'eq=contrast=0.9:brightness=0.06:saturation=0.7'],
    composite: '[over0]format=rgba,geq=r=\'255*(0.5+0.2*sin(X*0.05*Y*0.04))\':g=\'250*(0.5+0.2*sin(X*0.05*Y*0.04))\':b=\'240*(0.5+0.2*sin(X*0.05*Y*0.04))\':a=\'255*0.18\'',
  },
  aerochrome: {
    chain: ['format=rgb24,colorchannelmixer=rr=0.05:rg=0.7:rb=0.05:gr=0.6:gg=0.2:gb=0.15:br=0.1:bg=0.5:bb=0.5'],
  },
  chromadisp: {
    chain: ['format=rgb24,rgbashift=rh=6:bh=-6', 'crop=iw-4:ih:2+2*sin(2*PI*t*10):0'],
  },
  colorinvert: {
    chain: ['negate'],
  },
  stutter: {
    chain: ['fps=5'],
  },
  strobe: {
    // geq=lum writes only luma, which zeroes the chroma planes -> the frame
    // renders pure green. cb/cr must be passed through explicitly.
    chain: ["geq=lum='lum(X\\,Y)*(0.5+0.5*sin(2*PI*T*6)*1.0)':cb='cb(X\\,Y)':cr='cr(X\\,Y)'"],
  },
  hyperlapse: {
    chain: ['setpts=PTS/20,fps=30'],
  },
  fisheye: {
    chain: ['v360=equirect:fisheye:ih_fov=200:iv_fov=200', 'scale=480:-2:flags=lanczos'],
  },
  glass: {
    chain: ['scale=240:-2:flags=lanczos,split=4[a][b][c][d];[b]hflip[bx];[c]vflip[cy];[d]hflip,vflip[dx];[a][bx][cy][dx]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0,scale=480:-1:flags=neighbor,format=rgb24,rgbashift=rh=10:bh=-10'],
  },
  pushzoom: {
    chain: ['zoompan=z=\'1.15+0.2*sin(2*PI*time*0.5)\':d=1:x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':s=480x270'],
  },
  chalk: {
    chain: ['format=gray,edgedetect=low=0.06:high=0.2:mode=colormix,negate,format=rgb24', "lutrgb=r='val':g='clip(val*0.6+90,0,255)':b='clip(val*0.4+70,0,255)'", 'noise=alls=8:allf=t'],
  },
  linocut: {
    chain: ['format=gray,colorchannelmixer=rr=1.4:rg=1.4:rb=1.4:gr=.8:gg=.8:gb=.8:br=.6:bg=.6:bb=.6,eq=contrast=2.1:brightness=-0.05,format=rgb24,colorchannelmixer=rr=.9:rg=.7:rb=.5:gr=.3:gg=.5:gb=.6:br=.4:bg=.2:bb=.5'],
  },
  phosphor: {
    chain: ['format=rgb24', "lutrgb=r='clip(2*val-150,0,255)':g='clip(2*val-60,0,255)':b='clip(1.8*val-120,0,255)'", 'tmix=frames=4'],
  },
  subsurface: {
    chain: ['format=rgb24,split=2[m][o];[m]gblur=sigma=14[g];[o][g]blend=all_mode=lighten', 'eq=saturation=1.2:brightness=0.06'],
  },
  asyncsplit: {
    chain: ['split=4[a][b][c][d];[a]scale=iw/2:ih/2:flags=lanczos,setpts=PTS+0.0/TB[s0];[b]scale=iw/2:ih/2:flags=lanczos,setpts=PTS+0.08/TB[s1];[c]scale=iw/2:ih/2:flags=lanczos,setpts=PTS+0.16/TB[s2];[d]scale=iw/2:ih/2:flags=lanczos,setpts=PTS+0.24/TB[s3];[s0][s1][s2][s3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0'],
  },
  pixelshuffle: {
    chain: ['split=2[m][o];[o]crop=iw/2:ih/2:abs(sin(0.6*t))*iw/2:abs(sin(0.4*t))*ih/2:exact=1,pad=iw:ih:0:0:black[o1];[m][o1]overlay=abs(sin(1.3*t))*w/2:abs(sin(0.9*t))*h/2:shortest=1,noise=alls=16:allf=t+u,eq=contrast=1.15'],
  },
  vectorscope: {
    chain: ['format=gray,edgedetect=low=0.06:high=0.22:mode=canny,eq=contrast=3.5:brightness=0.05,format=rgb24'],
  },
  crtmoire: {
    chain: ['format=rgb24,rgbashift=rh=2:bh=-2,drawgrid=w=iw/2:h=ih/2:t=1:c=black@0.10,drawgrid=w=iw:h=3:t=1:c=black@0.18,noise=alls=5:allf=t,eq=contrast=1.15:saturation=1.1,vignette=PI/4.5'],
  },
  cyanotype: {
    chain: ['hue=s=0,format=rgb24,colorchannelmixer=rr=0.04:rg=0.08:rb=0.12:gr=0.08:gg=0.18:gb=0.3:br=0.16:bg=0.3:bb=0.6,noise=alls=12:allf=t,eq=contrast=1.2:brightness=0.08'],
  },
  moltenmetal: {
    chain: ['split=2[m][b];[b]gblur=sigma=4,eq=contrast=2.0[bb];[m][bb]blend=all_mode=screen:all_opacity=0.5,format=rgb24,colorchannelmixer=rr=0.9:rg=0.6:rb=0.2:gr=0.55:gg=0.45:gb=0.18:br=0.4:bg=0.3:bb=0.12,eq=contrast=1.25:brightness=-0.02,tmix=frames=4,noise=alls=6:allf=t'],
  },
  crosshatch: {
    chain: ['split=2[tone][line];[tone]format=gray,eq=contrast=0.8:brightness=0.4[t0];[line]edgedetect=low=0.06:high=0.22:mode=canny,negate,format=rgba,colorkey=white:similarity=0.25:blend=0.15,colorchannelmixer=rr=0.9:rg=0.15:rb=0.1:gr=0.1:gg=0.9:gb=0.1:br=0.12:bg=0.1:bb=0.9,split=2[l1][l2];[t0][l1]overlay=0:0[a];[a][l2]overlay=1:1:shortest=1'],
  },
  mimeograph: {
    chain: ['hue=s=0,format=rgb24,colorchannelmixer=rr=0.30:rg=0.15:rb=0.50:gr=0.15:gg=0.08:gb=0.30:br=0.25:bg=0.10:bb=0.75,gblur=sigma=1.5,eq=contrast=1.3:brightness=0.05,noise=alls=10:allf=t'],
  },
  newsprint: {
    chain: ['format=rgb24,scale=iw/5:ih/5:flags=neighbor,scale=iw*5:ih*5:flags=neighbor,rgbashift=rh=4:bh=-4,colorchannelmixer=rr=1.1:rg=0:rb=0:gr=0.1:gg=1.05:gb=-0.1:br=-0.05:bg=0:bb=1.1,eq=saturation=1.5:contrast=1.1,noise=alls=4:allf=t'],
  },
  inkwash: {
    chain: ['tmix=frames=8,split=2[m][b];[b]gblur=sigma=12[g];[m][g]blend=all_mode=darken,noise=alls=6:allf=t+u,eq=contrast=0.95:saturation=1.1'],
  },
  macroblock: {
    chain: ['scale=iw/8:ih/8:flags=neighbor,scale=iw*8:ih*8:flags=neighbor,split=2[m][o];[o]crop=iw/2:ih/3:abs(sin(0.6*t))*iw/2:abs(sin(0.4*t))*ih/3:exact=1[c];[m][c]overlay=abs(sin(1.1*t))*w/2:abs(sin(0.8*t))*h/3:shortest=1,noise=alls=10:allf=t'],
  },
  greenspill: {
    chain: ['eq=saturation=0.9,split=2[m][e];[e]edgedetect=low=0.04:high=0.18:mode=canny,format=rgb24,colorchannelmixer=rr=0.05:rg=0.05:rb=0.05:gr=0.1:gg=1:gb=0.1:br=0.05:bg=0.6:bb=0.05[g];[m][g]overlay=0:0:shortest=1'],
  },
  interlaced: {
    chain: ['interlace=tff'],
  },
  isometric: {
    chain: ['scale=iw:ih*0.58:flags=lanczos,eq=contrast=1.25:saturation=1.15'],
    composite: '[over0]format=rgba,geq=r=\'140+110*gt(abs(mod(X+Y\\,96)-48)\\,42)*gt(abs(mod(X-Y\\,96)-48)\\,42)\':g=\'150+105*gt(abs(mod(X+Y\\,96)-48)\\,42)*gt(abs(mod(X-Y\\,96)-48)\\,42)\':b=\'110+120*gt(abs(mod(X+Y\\,96)-48)\\,42)*gt(abs(mod(X-Y\\,96)-48)\\,42)\':a=\'255*0.5*gt(abs(mod(X+Y\\,96)-48)\\,42)*gt(abs(mod(X-Y\\,96)-48)\\,42)\'',
    forceScale: null,
  },
  sonar: {
    chain: ['eq=brightness=-0.3:saturation=0.55'],
    composite: '[over0]format=rgba,geq=r=\'255*(0.15+0.85*pow(cos(0.05*sqrt(pow(X-W/2\\,2)+pow(Y-H/2\\,2))-2*PI*T)\\,8))\':g=\'255*(0.15+0.85*pow(cos(0.05*sqrt(pow(X-W/2\\,2)+pow(Y-H/2\\,2))-2*PI*T)\\,8))\':b=\'200*(0.15+0.85*pow(cos(0.05*sqrt(pow(X-W/2\\,2)+pow(Y-H/2\\,2))-2*PI*T)\\,8))\':a=\'255*0.55\'',
    forceScale: null,
  },
  nebula: {
    chain: ['eq=contrast=0.75:saturation=1.2,gblur=sigma=8'],
    composite: '[over0]format=rgba,geq=r=\'110+90*sin(X*0.012+Y*0.008+1.2*T)\':g=\'90+80*sin(X*0.015+Y*0.011+1.6*T+2)\':b=\'150+95*sin(X*0.009+Y*0.014+0.8*T+4)\':a=\'255*(0.45+0.2*sin(X*0.02+Y*0.02+0.4*T))\'',
    forceScale: null,
  },
  solarflare: {
    chain: ['eq=brightness=0.03:saturation=1.1'],
    composite: '[over0]format=rgba,geq=r=\'min(255\\,9000/(1+0.12*pow(X-(W/2+W*0.45*sin(0.7*T))\\,2)+0.12*pow(Y-(H/2+H*0.35*cos(0.5*T))\\,2)))\':g=\'min(255\\,7000/(1+0.12*pow(X-(W/2+W*0.45*sin(0.7*T))\\,2)+0.12*pow(Y-(H/2+H*0.35*cos(0.5*T))\\,2)))\':b=\'min(255\\,5000/(1+0.12*pow(X-(W/2+W*0.45*sin(0.7*T))\\,2)+0.12*pow(Y-(H/2+H*0.35*cos(0.5*T))\\,2)))\':a=\'255*0.9\',gblur=sigma=3',
    forceScale: null,
  },
  aurora: {
    chain: ['eq=contrast=0.9:saturation=0.85'],
    composite: '[over0]format=rgba,geq=r=\'150+90*sin(Y*0.03+X*0.008+1.5*T)\':g=\'230+25*sin(Y*0.035+X*0.01+1.9*T+1)\':b=\'190+60*sin(Y*0.028+X*0.012+1.2*T+3)\':a=\'255*(0.55+0.3*sin(Y*0.05+X*0.015+0.7*T))\',gblur=sigma=4',
    forceScale: null,
  },
};

// The style effects that can be showcased/exported, in the order they appear
// in the UI. Kept as { value, label } so the checkboxes and the dropdown stay
// in sync with the actual STYLES definitions.
const EFFECT_LIST = [
  'glitch', 'pixelsort', '8bit', 'cinemagraph', 'vaporwave', 'duotone', 'ascii',
  'rounded', 'polaroid', 'lightleak', 'rain', 'snow', 'dust', 'kaleidoscope',
  'zoomburst', 'colorcycle', 'scanlines', 'rgbshake', 'thermal', 'nightvision',
  'xray', 'matrix', 'mirror', 'splitgrid', 'posterize', 'solarize', 'glow',
  'trails', 'grain', 'blueprint', 'prism', 'emberdust', 'neonrain', 'fog',
  'handheld', 'emboss', 'watercolor', 'paper', 'aerochrome', 'chromadisp',
  'colorinvert', 'stutter', 'strobe', 'hyperlapse', 'fisheye', 'glass',
  'pushzoom', 'chalk', 'linocut', 'phosphor', 'subsurface',
  'asyncsplit', 'pixelshuffle', 'vectorscope', 'crtmoire', 'cyanotype',
  'moltenmetal', 'crosshatch', 'mimeograph', 'newsprint', 'inkwash', 'macroblock',
  'greenspill', 'interlaced', 'isometric', 'sonar', 'nebula', 'solarflare', 'aurora',
].filter((v) => v && STYLES[v]);

const EFFECT_LABELS = {
  glitch: 'Glitch', pixelsort: 'Pixel sort', '8bit': '8-bit', cinemagraph: 'Cinemagraph',
  vaporwave: 'Vaporwave', duotone: 'Duo-tone', ascii: 'ASCII art', rounded: 'Rounded corners',
  polaroid: 'Polaroid', lightleak: 'Light leak', rain: 'Rain', snow: 'Snow', dust: 'Dust',
  kaleidoscope: 'Kaleidoscope', zoomburst: 'Zoom burst', colorcycle: 'Color cycle',
  scanlines: 'Scanlines', rgbshake: 'RGB shake', thermal: 'Thermal', nightvision: 'Night vision',
  xray: 'X-ray', matrix: 'Matrix', mirror: 'Mirror', splitgrid: 'Split grid',
  posterize: 'Posterize', solarize: 'Solarize', glow: 'Glow', trails: 'Trails',
  grain: 'Grain', blueprint: 'Blueprint', prism: 'Prism', emberdust: 'Ember dust',
  neonrain: 'Neon rain', fog: 'Fog', handheld: 'Handheld', emboss: 'Emboss',
  watercolor: 'Watercolor', paper: 'Paper', aerochrome: 'Aerochrome', chromadisp: 'Chroma disp',
  colorinvert: 'Color invert', stutter: 'Stutter', strobe: 'Strobe', hyperlapse: 'Hyperlapse',
  fisheye: 'Fisheye', glass: 'Glass', pushzoom: 'Push zoom', chalk: 'Chalk',
  linocut: 'Linocut', phosphor: 'Phosphor', subsurface: 'Subsurface',
  asyncsplit: 'Async split', pixelshuffle: 'Pixel shuffle', vectorscope: 'Vector scope',
  crtmoire: 'CRT moiré', cyanotype: 'Cyanotype', moltenmetal: 'Molten metal',
  crosshatch: 'Cross-hatch', mimeograph: 'Mimeograph', newsprint: 'Newsprint',
  inkwash: 'Ink wash', macroblock: 'Macroblock', greenspill: 'Green spill',
  interlaced: 'Interlaced', isometric: 'Isometric', sonar: 'Sonar', nebula: 'Nebula',
  solarflare: 'Solar flare', aurora: 'Aurora',
};

// The currently-checked effects in the Showcase card, in UI order.
function selectedEffects() {
  const boxes = document.querySelectorAll('#showcase-effects input[type="checkbox"]');
  const picked = [];
  boxes.forEach((cb) => { if (cb.checked && cb.dataset.effect) picked.push(cb.dataset.effect); });
  return picked;
}

// A per-effect settings snapshot, overriding the palette/dither/colors to the
// "best" defaults so showcase segments and stills match the normal conversion.
function effectSettings(it, baseSettings, extra) {
  return {
    ...baseSettings,
    style: extra.style || 'none',
    filter: 'none',
    frameSkip: 1,
    palette: 'best',
    dither: 'sierra2_4a',
    colors: 256,
    motion: 'normal',
    caption: '',
    subs: '',
    ...extra,
  };
}

// Convert a user-supplied subtitle path into an ffmpeg-safe quoted token.
function subsPath(p) {
  const s = String(p).replace(/\\/g, '/').replace(/'/g, "\\'");
  return `'${s}'`;
}

// Snapshot of every convert setting currently in the UI. Shared by the full
// conversion and the preview so they always render from the same inputs.
function readSettings() {
  const endVal = $('end').value;
  return {
    start: parseFloat($('start').value) || 0,
    end: endVal !== '' && isFinite(parseFloat(endVal)) ? parseFloat(endVal) : null,
    shape: $('shape').value,
    width: parseInt($('width').value, 10) || 0,
    preset: $('preset').value,
    fps: Math.min(60, Math.max(1, parseInt($('fps').value, 10) || 12)),
    speed: parseFloat($('speed').value) || 1,
    palette: $('palette').value,
    loopMode: $('loop-mode').value,
    loopCount: parseInt($('loop-count').value, 10) || 3,
    motion: $('motion').value,
    filter: $('filter').value,
    style: $('style').value,
    caption: $('caption').value,
    captionSize: $('caption-size').value,
    captionColor: $('caption-color').value,
    captionPos: $('caption-pos').value,
    captionAnim: $('caption-anim').checked,
    chroma: $('chroma').checked,
    chromaColor: $('chroma-color').value,
    chromaSim: parseFloat($('chroma-sim').value),
    dither: $('dither').value,
    colors: parseInt($('colors').value, 10) || 256,
    frameSkip: parseInt($('frame-skip').value, 10) || 1,
    subs: $('subs').value,
    transparency: false,
    clipDuration: state.probeInfo && state.probeInfo.duration != null ? state.probeInfo.duration : null,
  };
}

function clearPreview() {
  if (state.previewPath) {
    cleanupFiles([state.previewPath]);
    state.previewPath = null;
  }
}

async function convert() {
  const it = state.current;
  if (!it) return;

  const settings = readSettings();
  clearPreview();
  $('eta-line').textContent = '';

  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const tmpDir = os.tmpdir();
  const shapeTag = settings.shape !== 'original' ? `_${settings.shape}` : '';
  const speedTag = settings.speed !== 1 ? `_${settings.speed}x` : '';
  const motionTag = settings.motion !== 'normal' ? `_${settings.motion}` : '';
  const filterTag = settings.filter !== 'none' ? `_${settings.filter}` : '';
  const styleTag = settings.style !== 'none' ? `_${settings.style}` : '';
  const colorsTag = settings.colors !== 256 ? `_${settings.colors}c` : '';
  const extraTags = `${shapeTag}${speedTag}${motionTag}${filterTag}${styleTag}${colorsTag}`;
  const outName = `${sanitize(it.name)}_${settings.width}w_${settings.fps}fps${extraTags}_${stamp}.gif`;
  const outPath = path.join(tmpDir, outName);
  const palette = path.join(tmpDir, `palette_${stamp}.png`);

  const full = { ...settings, out: outPath, palettePath: palette };

  state.cancelRequested = false;
  hideError();
  $('status').textContent = 'Converting…';
  $('percent').textContent = '';
  $('bar-fill').style.width = '0%';
  show('converting');

  const encodeStart = Date.now();
  try {
    if (full.palette === 'best') {
      $('status').textContent = 'Generating palette (pass 1/2)…';
      await runProcess(state.ffmpegBin, buildArgs(it, full).pass1);
      if (state.cancelRequested) { cleanupFiles([palette]); show('ready'); return; }
    }
    $('status').textContent = 'Encoding GIF (pass 2/2)…';
    // ffmpeg reports out_time_us on the OUTPUT timeline; setpts compresses it by `speed`.
    // The first out_time_us tick also means "the first output frame landed", so
    // a hard failure surfaces as an error bar instead of a stuck 0% bar.
    const srcStart = full.start;
    const srcEnd = full.end != null ? full.end : (full.clipDuration != null ? full.clipDuration : srcStart);
    const segSec = Math.max(0, srcEnd - srcStart);
    const outSeg = segSec / full.speed;
    await runProcess(state.ffmpegBin, buildArgs(it, full).pass2, (us) => {
      if (outSeg > 0 && !state.cancelRequested) {
        const pct = Math.min(100, Math.round((us / (outSeg * 1e6)) * 100));
        $('percent').textContent = pct + '%';
        $('bar-fill').style.width = pct + '%';
      }
    });
    if (state.cancelRequested) { cleanupFiles([outPath, palette]); show('ready'); return; }
  } catch (err) {
    cleanupFiles([outPath, palette]);
    show('ready');
    showError('Conversion failed:\n' + (err.message || String(err)));
    return;
  }

  cleanupFiles([palette]);
  const sizeBytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  const encodeSec = (Date.now() - encodeStart) / 1000;

  try {
    $('status').textContent = 'Importing into Eagle…';
    const name = `${it.name || 'gif'}_${settings.width}w_${settings.fps}fps${extraTags}`;
    const imported = await eagle.item.addFromPath(outPath, {
      name,
      tags: ['gif'],
      folders: safeImport(it.folders),
    });
    const newId = imported && imported.id ? imported.id : null;

    $('result-name').textContent = `${name}  ·  ${formatBytes(sizeBytes)}  ·  ${encodeSec.toFixed(1)}s`;
    $('result-note').textContent = `Added to ${it.folders && it.folders.length ? 'the same folder' : 'Unfiled'} as the source video.`;
    $('result-img').src = 'file://' + outPath.replace(/\\/g, '/');
    show('done');

    if (newId && eagle.view && typeof eagle.view.setSelectedItems === 'function') {
      try { await eagle.view.setSelectedItems([newId]); } catch (e) { /* non-critical */ }
    }
  } catch (err) {
    // Import failed: leave the file on disk so the user can grab it manually.
    show('error');
    $('fatal-msg').textContent =
      'GIF created but could not be added to Eagle:\n' + (err.message || err) +
      `\n\nThe GIF is at:\n${outPath}`;
  }
}

/* ------------------------------------------------------------------ *
 *  Preview (render a fast low-res GIF before committing to the full convert)
 * ------------------------------------------------------------------ */

// Reuses the real filter chain (buildArgs) but at a reduced size/fps over a
// short sub-clip, so the user can eyeball the style before the slow encode.
async function startPreview() {
  const it = state.current;
  if (!it) return;
  const settings = readSettings();
  clearPreview();

  const srcEnd = settings.end != null ? settings.end
    : (settings.clipDuration != null ? settings.clipDuration : settings.start);
  const avail = Math.max(0, srcEnd - settings.start);
  // Slow-mo expands output (setpts slows time), so shrink the source window to
  // keep the rendered preview short; everything else gets ~3s of source.
  const target = settings.speed < 1 ? Math.min(3, 3 * settings.speed) : 3;
  const dur = Math.max(0.5, Math.min(avail > 0 ? avail : target, target));

  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const pvPath = path.join(os.tmpdir(), `preview_${stamp}.gif`);
  const pv = {
    ...settings,
    out: pvPath,
    palettePath: path.join(os.tmpdir(), `preview_pal_${stamp}.png`),
    palette: 'fast',
    colors: 256,
    width: Math.min(settings.width || PRESETS[settings.preset] || 480, 240),
    fps: Math.min(settings.fps, 8),
    end: settings.start + dur,
    loopMode: 'forever',
  };

  state.cancelRequested = false;
  hideError();
  show('converting');
  $('status').textContent = 'Generating preview…';
  $('percent').textContent = '';
  $('bar-fill').style.width = '0%';
  $('eta-line').textContent = 'Quick preview at reduced size and frame rate — just a moment.';

  try {
    const { pass2 } = buildArgs(it, pv);
    await runProcess(state.ffmpegBin, pass2, (us) => {
      const outDur = dur / pv.speed;
      if (outDur > 0 && !state.cancelRequested) {
        const pct = Math.min(100, Math.round((us / (outDur * 1e6)) * 100));
        $('percent').textContent = pct + '%';
        $('bar-fill').style.width = pct + '%';
      }
    });
    if (state.cancelRequested) { cleanupFiles([pvPath]); show('ready'); return; }
  } catch (err) {
    cleanupFiles([pvPath]);
    show('ready');
    showError('Could not generate a preview:\n' + (err.message || String(err)));
    return;
  }

  cleanupFiles([pv.palettePath]);
  state.previewPath = pvPath;
  const sizeBytes = fs.existsSync(pvPath) ? fs.statSync(pvPath).size : 0;
  $('preview-img').src = 'file://' + pvPath.replace(/\\/g, '/');
  const tags = [
    settings.shape !== 'original' ? settings.shape : null,
    settings.filter !== 'none' ? settings.filter : null,
    settings.style !== 'none' ? (EFFECT_LABELS[settings.style] || settings.style) : null,
    settings.motion !== 'normal' ? settings.motion : null,
    settings.speed !== 1 ? `${settings.speed}x` : null,
  ].filter(Boolean).join(' · ');
  $('preview-tag').textContent = `${dur.toFixed(1)}s source · ${formatBytes(sizeBytes)}`;
  $('preview-note').textContent =
    `Quick render at ${pv.width}px and ${pv.fps} fps so it appears fast.` +
    (tags ? ` Applied: ${tags}.` : '') +
    ' The final GIF keeps your full settings.';
  show('preview');
}

/* ------------------------------------------------------------------ *
 *  Showcase GIF (one clip per effect, concatenated)
 * ------------------------------------------------------------------ */

async function generateShowcase() {
  const it = state.current;
  if (!it) return;
  const effects = selectedEffects();
  if (!effects.length) { showError('Select at least one style effect to showcase.'); return; }

  const per = Math.max(1, Math.min(30, parseFloat($('showcase-seconds').value) || 2));
  const secsInput = parseFloat($('showcase-seconds').value) || 2;

  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const tmp = os.tmpdir();
  const segDir = path.join(tmp, `showcase_${stamp}`);
  fs.mkdirSync(segDir, { recursive: true });

  const endVal = $('end').value;
  const baseSettings = {
    start: parseFloat($('start').value) || 0,
    end: endVal !== '' && isFinite(parseFloat(endVal)) ? parseFloat(endVal) : null,
    shape: $('shape').value,
    width: parseInt($('width').value, 10) || 480,
    preset: $('preset').value,
    fps: Math.min(60, Math.max(1, parseInt($('fps').value, 10) || 12)),
    speed: 1,
    clipDuration: state.probeInfo && state.probeInfo.duration != null ? state.probeInfo.duration : null,
  };
  const srcStart = baseSettings.start;
  const srcEnd = baseSettings.end != null ? baseSettings.end
    : (baseSettings.clipDuration != null ? baseSettings.clipDuration : srcStart);
  const srcLen = Math.max(0.01, srcEnd - srcStart);

  state.cancelRequested = false;
  hideError();
  show('converting');
  $('percent').textContent = '';
  $('bar-fill').style.width = '0%';
  // The showcase re-encodes each effect from the source at full clip length, so
  // it's the slowest flow in the app. Give a concrete sense of how long the
  // whole job will take, then refine it live as segments complete.
  $('eta-line').textContent = `Showcase (1/2) — rendering ${effects.length} effects… This may take a couple of minutes.` +
    ` You can watch the progress below or cancel anytime.`;
  const segs = [];
  const segTimes = [];
  const segStart = Date.now();
  try {
    // Pass 1 of 2: render each effect's clip as a lossless FFV1 segment.
    for (let i = 0; i < effects.length; i++) {
      if (state.cancelRequested) break;
      const eff = effects[i];
      $('status').textContent = `Showcase (1/2) — ${EFFECT_LABELS[eff] || eff} (${i + 1}/${effects.length})…`;
      const st = effectSettings(it, baseSettings, { style: eff });
      const inputChain = buildInputChainFor(it, st, eff);
      const segPath = path.join(segDir, `seg_${String(i).padStart(3, '0')}.mkv`);
      // The style filter runs at the requested output fps; no speed applied.
      const args = [
        '-y', '-ss', String(baseSettings.start), '-t', String(srcLen), '-i', it.filePath,
        '-filter_complex', `${inputChain};[vmain]fps=${baseSettings.fps}[vout]`,
        '-map', '[vout]', '-c:v', 'ffv1', '-pix_fmt', 'yuv420p',
        segPath,
      ];
      const t0 = Date.now();
      await runProcess(state.ffmpegBin, args);
      segTimes.push((Date.now() - t0) / 1000);
      segs.push(segPath);
      // Scale measured per-segment time by the clip's full length (each segment
      // runs srcLen seconds, not just `per`), plus a rough allowance for pass 2.
      const measured = segTimes.reduce((a, b) => a + b, 0) / segTimes.length;
      const perScale = per / srcLen;
      const pass2 = measured * perScale * effects.length * 0.6;
      const total = measured * effects.length + pass2;
      const remaining = total - (measured * (i + 1)) - pass2;
      etaLine(null, remaining);
    }
    if (state.cancelRequested) { cleanupFiles(segs); try { fs.rmSync(segDir, { recursive: true }); } catch (e) {} show('ready'); return; }

    // Build the concat list, trimming each segment to `per` seconds. Paths must
    // be absolute Windows paths (forward-slash) — the concat demuxer resolves
    // them against the list's directory, so relative /tmp paths break here.
    const listPath = path.join(segDir, 'list.txt');
    const lines = segs.map((p) => {
      const abs = p.replace(/\\/g, '/');
      return `file '${abs.replace(/'/g, "\\'")}'\nduration ${per.toFixed(3)}`;
    }).join('\n') + '\n';
    fs.writeFileSync(listPath, lines, 'utf8');

    const concatArgs = [
      '-y', '-safe', '0', '-f', 'concat', '-i', listPath,
      '-an', '-c:v', 'ffv1', '-pix_fmt', 'yuv420p',
      path.join(segDir, 'full.mkv'),
    ];
    await runProcess(state.ffmpegBin, concatArgs);
    if (state.cancelRequested) { cleanupFiles([...segs, path.join(segDir, 'full.mkv')]); try { fs.rmSync(segDir, { recursive: true }); } catch (e) {} show('ready'); return; }

    // Pass 2 of 2: palette two-pass over the concatenated clip.
    const fullPath = path.join(segDir, 'full.mkv');
    const palette = path.join(tmp, `show_palette_${stamp}.png`);
    const outPath = path.join(tmp, `showcase_${sanitize(it.name)}_${per}s_${stamp}.gif`);
    $('status').textContent = 'Showcase (2/2) — generating palette…';
    await runProcess(state.ffmpegBin, [
      '-y', '-i', fullPath,
      '-filter_complex', `[0:v]palettegen=max_colors=256[pal]`,
      '-map', '[pal]', '-frames:v', '1', '-update', '1', palette,
    ]);
    if (state.cancelRequested) { cleanupFiles([...segs, fullPath, palette, outPath]); try { fs.rmSync(segDir, { recursive: true }); } catch (e) {} show('ready'); return; }

    $('status').textContent = 'Showcase (2/2) — encoding GIF…';
    const encodeStart = Date.now();
    await runProcess(state.ffmpegBin, [
      '-y', '-progress', 'pipe:1', '-i', fullPath, '-i', palette,
      '-filter_complex', `[0:v][1:v]paletteuse=dither=sierra2_4a[vout]`,
      '-map', '[vout]', '-loop', '0', outPath,
    ], (us) => {
      const outSeg = per * effects.length;
      if (outSeg > 0 && !state.cancelRequested) {
        const pct = Math.min(100, Math.round((us / (outSeg * 1e6)) * 100));
        $('percent').textContent = pct + '%';
        $('bar-fill').style.width = pct + '%';
        // Once past a few %, the encode's own pace is the best guide.
        if (pct >= 3) etaLine(null, (Date.now() - encodeStart) / 1000 / (pct / 100) * (1 - pct / 100), true);
      }
    });
    if (state.cancelRequested) { cleanupFiles([...segs, fullPath, palette, outPath]); try { fs.rmSync(segDir, { recursive: true }); } catch (e) {} show('ready'); return; }

    // Clean up intermediates, keep the final GIF.
    cleanupFiles([...segs, fullPath, palette]);
    try { fs.rmSync(segDir, { recursive: true }); } catch (e) {}

    const sizeBytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
    $('status').textContent = 'Importing showcase into Eagle…';
    const name = `${sanitize(it.name)}_showcase_${effects.length}fx_${per}s`;
    const imported = await eagle.item.addFromPath(outPath, {
      name,
      tags: ['gif', 'showcase'],
      folders: safeImport(it.folders),
    });
    const newId = imported && imported.id ? imported.id : null;
    cleanupFiles([outPath]);

    $('result-name').textContent = `${name}  ·  ${formatBytes(sizeBytes)}  ·  ${effects.length} effects × ${per}s`;
    $('result-note').textContent = `Showcase GIF added to ${it.folders && it.folders.length ? 'the same folder' : 'Unfiled'} as the source video.`;
    $('result-img').src = 'file://' + outPath.replace(/\\/g, '/');
    show('done');
    if (newId && eagle.view && typeof eagle.view.setSelectedItems === 'function') {
      try { await eagle.view.setSelectedItems([newId]); } catch (e) { /* non-critical */ }
    }
  } catch (err) {
    cleanupFiles(segs);
    try { fs.rmSync(segDir, { recursive: true }); } catch (e) {}
    show('ready');
    showError('Showcase failed:\n' + (err.message || String(err)));
  }
}

/* ------------------------------------------------------------------ *
 *  Export each applied effect as a JPG still
 * ------------------------------------------------------------------ */

async function exportJpgs() {
  const it = state.current;
  if (!it) return;
  const effects = selectedEffects();
  if (!effects.length) { showError('Select at least one style effect to export.'); return; }

  let dir = '';
  try {
    const res = await eagle.dialog.showOpenDialog({
      title: 'Choose a folder to save the effect images',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res && res.canceled) return; // user cancelled — no error
    dir = res && res.filePaths && res.filePaths[0];
  } catch (err) {
    showError('Could not open the folder picker: ' + (err.message || err));
    return;
  }
  if (!dir) { showError('No destination folder selected.'); return; }

  const endVal = $('end').value;
  const baseSettings = {
    start: parseFloat($('start').value) || 0,
    end: endVal !== '' && isFinite(parseFloat(endVal)) ? parseFloat(endVal) : null,
    shape: $('shape').value,
    width: parseInt($('width').value, 10) || 480,
    preset: $('preset').value,
    fps: Math.min(60, Math.max(1, parseInt($('fps').value, 10) || 12)),
    speed: 1,
    clipDuration: state.probeInfo && state.probeInfo.duration != null ? state.probeInfo.duration : null,
  };
  const at = parseFloat($('showcase-frame').value) || 0;

  state.cancelRequested = false;
  hideError();
  show('converting');
  $('percent').textContent = '';
  $('bar-fill').style.width = '0%';
  const outFiles = [];
  state._expStart = Date.now();
  try {
    for (let i = 0; i < effects.length; i++) {
      if (state.cancelRequested) break;
      const eff = effects[i];
      $('status').textContent = `Exporting images — ${EFFECT_LABELS[eff] || eff} (${i + 1}/${effects.length})…`;
      const st = effectSettings(it, baseSettings, { style: eff });
      const inputChain = buildInputChainFor(it, st, eff);
      const outPath = path.join(dir, `${sanitize(it.name)}_${eff}.jpg`);
      const when = Math.max(0, baseSettings.start + at);
      const args = [
        '-y', '-ss', String(when), '-i', it.filePath,
        // Grab the first frame of the style-processed stream. No `fps=1` here:
        // that filter starves on sparse streams (cinemagraph collapses to one
        // frame; hyperlapse compresses 20x), producing no output at all.
        '-filter_complex', `${inputChain};[vmain]select=eq(n\\,0),setpts=N`,
        '-frames:v', '1', '-q:v', '3', outPath,
      ];
      await runProcess(state.ffmpegBin, args);
      outFiles.push(outPath);
    }
    if (state.cancelRequested) { show('ready'); return; }

    const secs = Math.round((Date.now() - state._expStart) / 1000);
    $('export-done-dir').textContent = dir;
    $('export-done-note').textContent = `${effects.length} effect images saved in ${secs}s.`;
    show('export-done');
  } catch (err) {
    show('ready');
    showError('Export failed:\n' + (err.message || String(err)));
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
}

function cleanupFiles(paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
  }
}

function cancel() {
  state.cancelRequested = true;
  if (state.child) {
    try { state.child.kill(); } catch (e) { /* ignore */ }
  }
}

function updateLoopUI() {
  const mode = $('loop-mode').value;
  const showCount = mode === 'count';
  $('label-loop-count').classList.toggle('hidden', !showCount);
}

// Live counts of the Motion / Filter / Style-effect options, shown under the
// header. Computed from the selects so it stays correct as options change.
function updateStatline() {
  const count = (id) => [...$(id).options].filter((o) => o.value !== 'none' && o.value !== 'normal').length;
  $('statline').innerHTML =
    `<span class="stat"><b>${count('motion')}</b> motions</span>` +
    `<span class="stat"><b>${count('filter')}</b> filters</span>` +
    `<span class="stat"><b>${count('style')}</b> style effects</span>`;
}

/* ------------------------------------------------------------------ *
 *  Init
 * ------------------------------------------------------------------ */

async function init() {
  $('btn-install-ffmpeg').addEventListener('click', () => {
    eagle.extraModule.ffmpeg.install().then(() => show('no-ffmpeg'));
  });
  $('btn-retry').addEventListener('click', loadSelected);
  $('btn-close-error').addEventListener('click', () => window.close());
  $('btn-close-done').addEventListener('click', () => window.close());
  $('btn-another').addEventListener('click', () => {
    clearPreview();
    state.current = null;
    loadSelected();
  });
  $('btn-convert').addEventListener('click', startPreview);
  $('btn-preview-convert').addEventListener('click', convert);
  $('btn-preview-back').addEventListener('click', () => { clearPreview(); show('ready'); });
  $('btn-showcase').addEventListener('click', generateShowcase);
  $('btn-export-jpgs').addEventListener('click', exportJpgs);
  $('btn-export-again').addEventListener('click', () => { loadSelected(); });
  $('btn-export-close').addEventListener('click', () => window.close());
  $('btn-cancel').addEventListener('click', cancel);
  $('loop-mode').addEventListener('change', updateLoopUI);
  ['motion', 'filter', 'style'].forEach((id) => {
    $(id).addEventListener('change', updateStatline);
  });
  $('video-picker').addEventListener('change', (e) => {
    const i = parseInt(e.target.value, 10);
    if (state.selected[i]) {
      state.current = state.selected[i];
      renderSource();
      refreshProbe();
    }
  });
  updateLoopUI();
  updateStatline();
  renderShowcase();

  if (!eagle || !eagle.extraModule || !eagle.extraModule.ffmpeg) {
    show('error');
    $('fatal-msg').textContent = 'This plugin requires Eagle 4.0 beta 7 or later.';
    return;
  }

  try {
    const installed = await eagle.extraModule.ffmpeg.isInstalled();
    if (!installed) {
      show('no-ffmpeg');
      return;
    }
    const paths = await eagle.extraModule.ffmpeg.getPaths();
    state.ffmpegBin = paths.ffmpeg;
    state.ffprobeBin = paths.ffprobe;
  } catch (err) {
    show('error');
    $('fatal-msg').textContent = 'Could not set up FFmpeg: ' + err.message;
    return;
  }

  await loadSelected();
}

if (typeof eagle !== 'undefined' && eagle.onPluginCreate) {
  eagle.onPluginCreate(() => init());
} else if (window.onload) {
  window.onload = init;
} else {
  init();
}
