// Tiny emoji confetti burst — no libraries. Respects reduced-motion.
function confettiBurst() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const EMOJI = ['✨', '🎉', '⭐️', '💫', '🙌', '🎈', '🍀', '🥳'];
  for (let i = 0; i < 26; i++) {
    const p = document.createElement('span');
    p.className = 'confetti-piece';
    p.textContent = EMOJI[Math.floor(Math.random() * EMOJI.length)];
    p.style.left = Math.random() * 100 + 'vw';
    p.style.fontSize = 16 + Math.random() * 14 + 'px';
    p.style.animationDuration = 2.4 + Math.random() * 2 + 's';
    p.style.animationDelay = Math.random() * 0.5 + 's';
    document.body.appendChild(p);
    p.addEventListener('animationend', () => p.remove());
  }
}
