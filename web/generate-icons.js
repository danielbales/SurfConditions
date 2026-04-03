// Run with: node generate-icons.js
// Generates icons/icon-192.png and icons/icon-512.png
const { createCanvas } = require('canvas');
const fs = require('fs');

function makeIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const s = size;

  // Background
  const grad = ctx.createLinearGradient(0, 0, 0, s);
  grad.addColorStop(0, '#071020');
  grad.addColorStop(1, '#0f1f3d');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(0, 0, s, s, s * 0.18);
  ctx.fill();

  // Wave emoji style — draw a wave
  const waveY = s * 0.62;
  const amp = s * 0.08;

  ctx.beginPath();
  ctx.moveTo(0, waveY);
  for (let x = 0; x <= s; x += 2) {
    const y = waveY + Math.sin((x / s) * Math.PI * 2.5) * amp;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(s, s);
  ctx.lineTo(0, s);
  ctx.closePath();
  const waveGrad = ctx.createLinearGradient(0, waveY - amp, 0, s);
  waveGrad.addColorStop(0, 'rgba(0, 212, 170, 0.8)');
  waveGrad.addColorStop(1, 'rgba(30, 144, 255, 0.6)');
  ctx.fillStyle = waveGrad;
  ctx.fill();

  // Text
  ctx.fillStyle = '#e8f4fd';
  ctx.font = `bold ${s * 0.38}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('🌊', s / 2, s * 0.37);

  return canvas.toBuffer('image/png');
}

fs.mkdirSync('icons', { recursive: true });
fs.writeFileSync('icons/icon-192.png', makeIcon(192));
fs.writeFileSync('icons/icon-512.png', makeIcon(512));
console.log('Icons generated.');
