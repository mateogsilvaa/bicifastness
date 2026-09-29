// Modulo de /404.html. Solo el tema: una pagina de error no necesita Firebase,
// y si el fallo es de la red, cargarlo la dejaria en blanco.
(() => {
  let elegido = 'sistema';
  try { elegido = localStorage.getItem('theme') || 'sistema'; } catch { /* modo privado */ }
  const oscuro = elegido === 'dark' || (elegido !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', oscuro ? 'dark' : 'light');
})();
