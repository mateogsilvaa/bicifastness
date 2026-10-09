/**
 * Indice lateral de los textos legales.
 *
 * En una pantalla ancha el texto legal se quedaba en una columna estrecha en
 * medio y el resto en blanco. Aqui, desde 1000 px, se saca un indice de las
 * secciones a la izquierda (fijo al hacer scroll, con la seccion que se lee
 * marcada) y el texto ocupa el resto. Sin JavaScript, o en movil, la pagina es
 * la de siempre: una sola columna.
 */

const ANCHO = window.matchMedia('(min-width: 1000px)');

function ponerIds(titulos) {
  const usados = new Set();
  titulos.forEach((h, i) => {
    if (h.id) { usados.add(h.id); return; }
    let base = h.textContent.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `seccion-${i + 1}`;
    while (usados.has(base)) base += '-x';
    usados.add(base);
    h.id = base;
  });
}

function montar() {
  const principal = document.querySelector('main.legal');
  if (!principal || principal.querySelector('.legal-indice')) return;
  const titulos = [...principal.querySelectorAll(':scope > h2')];
  if (titulos.length < 3) return;
  ponerIds(titulos);

  const indice = document.createElement('nav');
  indice.className = 'legal-indice';
  indice.setAttribute('aria-label', 'En esta página');
  const rotulo = document.createElement('span');
  rotulo.className = 'rotulo';
  rotulo.textContent = 'En esta página';
  const lista = document.createElement('ol');
  const enlaces = new Map();
  for (const h of titulos) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${h.id}`;
    // Sin el numero delante del titulo ("3. Seguridad vial") se lee mejor, pero
    // se deja: es como se cita el texto.
    a.textContent = h.textContent;
    li.append(a);
    lista.append(li);
    enlaces.set(h.id, a);
  }
  indice.append(rotulo, lista);

  const cuerpo = document.createElement('div');
  cuerpo.className = 'legal-cuerpo';
  cuerpo.append(...principal.childNodes);
  principal.append(indice, cuerpo);
  principal.classList.add('con-indice');

  // La seccion que se esta leyendo.
  const visibles = new Set();
  const marcar = () => {
    const primera = titulos.find((h) => visibles.has(h.id)) || null;
    for (const [id, a] of enlaces) {
      if (primera && id === primera.id) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }
  };
  if ('IntersectionObserver' in window) {
    const observador = new IntersectionObserver((entradas) => {
      for (const e of entradas) {
        if (e.isIntersecting) visibles.add(e.target.id); else visibles.delete(e.target.id);
      }
      marcar();
    }, { rootMargin: '0px 0px -70% 0px' });
    titulos.forEach((h) => observador.observe(h));
  }
}

if (ANCHO.matches) montar();
else ANCHO.addEventListener('change', (e) => { if (e.matches) montar(); }, { once: true });
