/**
 * The card is a window onto a refracted duplicate of the background video.
 *
 * Every frame we redraw the current video frame into a canvas that sits inside
 * the card but is positioned to cover the whole viewport, so its pixels line up
 * 1:1 with the real video behind the card. The card's overflow:hidden and
 * border-radius do the clipping; the SVG filter on the canvas does the
 * refraction on composite.
 */

const video = document.getElementById('bg-video');
const container = document.getElementById('dup-video-container');
const canvas = document.getElementById('dup-image');
const card = document.querySelector('[data-glass-card]');

// The duplicate stays at 1x even on retina: the SVG filter's cost scales with
// pixel count, and what shows through is a soft refraction where 4x the filter
// work buys nothing.
const DUP_PIXEL_RATIO = 1;

const ctx = canvas ? canvas.getContext('2d') : null;

function frame() {
  requestAnimationFrame(frame);

  if (!video || !container || !canvas || !ctx || !card) return;
  if (!video.videoWidth || !video.videoHeight) return;

  const rect = card.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  // Sizing the duplicate to the viewport rather than to the card is deliberate.
  // The filter shifts each colour channel by a different amount, so the
  // filtered element's own leading edges show hard channel-separation bands. At
  // viewport size those bands fall outside the card and only clean refraction
  // shows.
  container.style.left = `${-rect.left}px`;
  container.style.top = `${-rect.top}px`;
  container.style.width = `${vw}px`;
  container.style.height = `${vh}px`;

  const w = Math.round(vw * DUP_PIXEL_RATIO);
  const h = Math.round(vh * DUP_PIXEL_RATIO);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  // Reproduce object-fit: cover against the source video dimensions.
  const cover = Math.max(vw / video.videoWidth, vh / video.videoHeight);
  const sw = vw / cover;
  const sh = vh / cover;
  const sx = (video.videoWidth - sw) / 2;
  const sy = (video.videoHeight - sh) / 2;

  try {
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
  } catch {
    // A frame may not be decodable yet; skip it and try again next tick.
  }
}

requestAnimationFrame(frame);
