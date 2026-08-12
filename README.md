# GIF Studio — Eagle Plugin

<img width="700" alt="Screenshot 2026-08-12 220048" src="https://github.com/user-attachments/assets/31190731-0ded-4939-8ea7-d5e86036cdf1" />
<img width="700" alt="Screenshot 2026-08-12 220115" src="https://github.com/user-attachments/assets/4ac97136-e905-47e8-b614-5093de66e2ac" />
<img width="700" alt="Screenshot 2026-08-12 224213" src="https://github.com/user-attachments/assets/9623c290-369e-4e6f-b3f0-55a6a8838c07" />

A [Eagle](https://eagle.cool) plugin that converts any video in your library into an animated GIF, using Eagle's official FFmpeg dependency plugin. The result is auto-imported back into your library, in the same folder as the source video.

## Requirements

- **Eagle 4.0 beta 7 or later** (the FFmpeg extra module is not available before this).
- The **FFmpeg Dependency Plugin** — Eagle prompts you to install it automatically the first time you open this plugin. If it isn't installed, click the **Install FFmpeg** button shown inside the plugin.

Everything runs locally — your videos never leave your machine.

## Installation

Two options:

**Option A — load as a plugin folder (recommended for development)**
1. In Eagle, click the **Plugin** button on the toolbar.
2. Choose **Developer Options** → **Import Plugin** (or "Load plugin folder", depending on your Eagle version).
3. Select the `gif-studio` folder containing `manifest.json`.

**Option B — copy into the plugins directory**
1. Copy this folder into your Eagle plugins directory (in Eagle: **Menu → About → Open plugins directory**).
2. Restart Eagle.

**Option C — packaged release**
- The **Releases** tab of this repository ships `GifStudio_*.eagleplugin` — the package format the Eagle Plugin Center uses.
- You can also produce one from your own copy: press **P** to open the plugin panel → right-click **GIF Studio** → **Pack Plugin**, then choose a save path.

## Usage

1. Select **one or more videos** in your Eagle library.
2. Run **GIF Studio** from the Plugin toolbar.
3. If you selected several videos, pick which one to convert from the dropdown.
4. Adjust the settings if you like:

   | Setting | Default | Notes |
   |---|---|---|
   | Start / End (s) | `0` → video end | Trim to the exact clip you want. Leave **End** empty to use the full video |
   | Shape | Original | Keep the original aspect, or crop to **Square (1:1)**, **Portrait (9:16)**, or **Landscape (16:9)** |
   | Width (px) | `480` | Height scales automatically to keep the aspect ratio |
   | Preset | Medium | **High** = 640px, **Medium** = 480px, **Low** = 320px. Lower = smaller file |
   | FPS | `12` | Higher = smoother but bigger file |
   | Speed | `1x` | **0.25x/0.5x** = slow-motion, **2x/4x/8x** = fast-motion, **16x/32x/64x** = time-lapse. The GIF length is **clip length ÷ Speed** |
   | Palette | 2-pass | 2-pass = best gradients; 1-pass = faster |
   | Loop | Forever | **Forever** repeats the GIF, **Play once** shows it a single time, **Repeat N times** plays it a set number of loops |

   **Creative** — optional overlays and motion:

   | Setting | Default | Notes |
   |---|---|---|
   | Motion | Normal | **Reverse** plays the clip backward; **Boomerang** plays forward then backward |
   | Filter | None | Grayscale, Sepia, Warm, Cool, Vivid, Cinematic, Vignette, Invert |
   | Style effect | None | See the **Style effects** table below |
   | Text / emoji | — | Static caption at top/middle/bottom, or an animated scroll (auto-paces to GIF length) |
   | Font size / Color | `32` / white | Caption styling |
   | Chroma key | Off | Remove a solid background (green/blue/magenta/white) for a transparent GIF. Best results with a bright, even screen; adjust **similarity** if you get halos |

   **Style effects** — one-click looks (applied after crop/scale, before quantization):

   | Effect | What it does |
   |---|---|
   | Glitch / VHS | Color separation, hue jitter, scanline noise, flip — old-tape feel |
   | Pixel sort (melt) | Stretches rows by brightness for a melting, abstract look |
   | 8-bit pixelation | Downscales to a chunky retro-resolution, then upscales |
   | Cinemagraph | Freezes the whole frame; a moving noise texture keeps it alive |
   | Vaporwave / neon | Neon pink/cyan LUT, high saturation, a dark haze border |
   | Duo-tone | Strips to two contrasting shades |
   | ASCII art | Converts the footage to a moving character grid |
   | Rounded corners | Smooths edges into curved corners (transparent outside) |
   | Polaroid frame | White instant-photo border with a caption line below |
   | Light leak | Sweeping colored flares over the exposure |
   | Rain / Snow / Dust | Synthetic weather or film-grain layer |
   | Kaleidoscope | Mirrors + repeats into a symmetric pattern |
   | Zoom burst | Rapid lens-punch zoom on the frame |
   | Color cycling | Continuously shifts hue over the clip |
   | Scanline interlacing | Horizontal black bars — CRT / security-cam look |
   | RGB split & shake | Channel separation + frame vibration (bass/impact) |
   | Predator thermal | Bright→red/yellow, dark→blue/purple infrared map |
   | Night vision HUD | Monochrome green with crosshair, REC + battery readouts |
   | X-ray inverse | Inverted spectrum + high contrast (bone-like) |
   | Green code rain | Matrix-style falling glowing characters |
   | Mirror | Symmetrical half-reflection |
   | Split-screen grid | Repeating 2×2 matrix of the clip |
   | Posterization | Limits colors to flat bands of tone |
   | Solarization | Partial tone inversion (metallic sheen) |
   | Glow & bloom | Blurs the brightest highlights back in for an aura |
   | Time-warp trails | Ghostly echo trail behind motion |
   | Film grain | Moving grain, hair fibers, dust specks |
   | Blueprint drawing | Edge lines over a deep-blue grid |
   | Glass prism | Rainbow-tinted overlapping shards |
   | Floating ember dust | Glowing orange sparks drifting over the clip |
   | Cyberpunk neon rain | Glowing colorful streaks sliding down the screen |
   | Smoke &amp; fog | Semi-transparent mist rolling across the lower frame |
   | Handheld shake | Organic micro-vibration (smartphone feel) |
   | Emboss &amp; engraving | Metallic raised-edge coin-stamp look |
   | Watercolor wash | Colors bleeding outward like wet paint |
   | Crumpled paper | Creased-texture overlay over the pixels |
   | Infrared aerochrome | Greens → pinks/crimsons (military-surveillance film) |
   | Chroma displacement | Color-layer shift with a vibrating halo in motion |
   | Color inversion | Full color-wheel flip |
   | Frame-rate stutter | Choppy claymation-style 5 fps |
   | Strobe flash | Alternating light/dark exposures |
   | Hyperlapse sweep | Extreme fast-forward with smooth motion |
   | Fish-eye warp | Bending ultra-wide lens distortion |
   | Broken glass | Geometric shard reflection |
   | Push-in zoom | Slow continuous lens push |
   | Chalkboard sketch | Dusty white chalk on dark slate |
   | Linocut stamp | High-contrast rough-edged ink blocks |
   | Phosphor glow | Low-light neon hue with a fading trail |
   | Subsurface glow | Translucent inner radiance (skin/wax/liquid) |
   | Async split-screen | Divides the frame into panels playing the same clip at slightly staggered times |
   | Pixel shuffling | Randomly swaps rows/blocks horizontally — scrambled-data-stream look |
   | Vector scope | Strips color; only the sharp wireframe skeleton of moving objects |
   | CRT moiré | Tight grid distortion + color fringing — camera filming an old glass CRT |
   | Cyanotype blueprint | Deep Prussian-blue tones + rough paper texture (19th-c. blueprints) |
   | Molten metal liquid | High-gloss reflective silver/gold chrome coating on moving subjects |
   | Cross-hatch etching | Overlapping fine-pen ink lines in the shadows/midtones (textbook sketch) |
   | Mimeograph bleed | Low-fi single-ink (vibrant purple) print with blurry bleeding edges |
   | Newsprint misalignment | CMYK layers offset — yellow/cyan/magenta dots don't line up |
   | Ink wash dissolve | Edges of moving objects dissolve into wet runny watercolor |
   | Macroblock pixels | Clusters into large blocky squares that tear on fast action |
   | Green screen spill | Intentional messy neon-green fringe around the subject |
   | Interlaced combing | Jagged alternating horizontal lines on fast pans (VHS) |
   | Isometric grid | Layered across a repeating 3D diamond grid — strategy-game landscape |
   | Sonar pulse | Expanding concentric circles that illuminate where shockwaves hit |
   | Nebula gas bloom | Blurs the dark areas and fills them with swirling cosmic gas |
   | Solar flare artifacts | Sharp blinding overexposed bursts washing across the lens |
   | Aurora borealis glow | Dancing neon green/violet ribbons reacting to motion |

   **Optimization** — control file size:

   | Setting | Default | Notes |
   |---|---|---|
   | Dithering | Sierra L2A | Algorithm used to fake smooth gradients; **None** shrinks files but can band |
   | Max colors | `256` | 128 or 64 lowers file size (GIF is limited to 256 colors) |
   | Frame skip | None | Drop every 2nd/3rd frame to halve/third the frame count **without changing playback speed** |
   | Subtitle file | — | Absolute path to an `.srt`/`.ass` to burn into the GIF (e.g. `C:\captions.srt`) |

5. Click **Convert to GIF**. A quick low-resolution preview of the clip with your current settings appears first — click **Convert to GIF** on the preview to run the full encode (the progress bar shows encoding progress), or **Edit settings** to tweak and re-preview.
6. When it's done, the GIF has already been added to your Eagle library — in the **same folder** as the source video — tagged `gif`. You can click **Convert another** to keep going.

## Troubleshooting

- **"No video selected."** — select a video in the Eagle grid first, then refresh.
- **"This plugin requires Eagle 4.0 beta 7 or later."** — update Eagle.
- **Conversion fails** — the error message includes ffmpeg's output. Common causes: an unsupported/corrupt video, a duration/fps combination that's too large, or a subtitle file path that doesn't exist.
- **Reverse / Boomerang is slow** — reversing requires ffmpeg to buffer the whole clip in memory; keep the selected segment short.
- **Chroma key leaves a green/blue fringe** — raise the **similarity** value (0.1 → 0.2–0.3) or pick a closer color preset. Best results on a bright, even screen.
- **Caption text doesn't show** — ffmpeg needs a font available on the system; plain text and emojis work on a standard install. A missing subtitle file will fail the conversion.
- **Style effects are experimental** — they use ffmpeg's filtergraph heavily and some (ASCII, pixel-sort, rain/snow/dust, cinemagraph) are approximations; if one fails or looks off, try the Filter dropdown instead. Heavy styles (glitch, kaleidoscope, ASCII) run at a reduced resolution to keep memory reasonable.
- **Transparent GIF** — only possible via **Chroma key** (removes a solid background). Regular videos have no alpha, so "transparent" without a green/blue screen isn't available.

## License

MIT © 2026 Kerekes Stefan