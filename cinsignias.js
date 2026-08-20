// insignias.js

// Diccionario central con todas las insignias del juego
export const DICCIONARIO_INSIGNIAS = {
    "rutero_fiel": {
        icono: "fi fi-rr-home",
        titulo: "Hogar, Dulce Hogar",
        descripcion: "Ha subido más de 20 viajes a la misma ruta.",
        color: "#ffffff" // Verde
    },
    "racha_fuego": {
        icono: "fi fi-sr-flame",
        titulo: "Racha",
        descripcion: "Viajes verificados 10 días seguidos.",
        color: "#ffffff" // Naranja fuego
    },
    "trotamundos": {
        icono: "fi fi-rr-earth-europa",
        titulo: "Trotamundos",
        descripcion: "Ha subido viajes en más de 25 rutas diferentes.",
        color: "#ffffff" // Azul tierra
    },
    "top_5_temp": {
        icono: "fi fi-sr-tire",
        titulo: "Top",
        descripcion: "Clan Top 4 o 5 en el ranking de BiciRating en una temporada.",
        color: "#ffffff" // Gris
    },
    "oro_temp": {
        icono: "fi fi-sr-laurel-wreath",
        titulo: "Oro",
        descripcion: "Primer clan en el ranking de BiciRating en una temporada.",
        color: "#FFD700" // Oro
    },
    "plata_temp": {
        icono: "fi fi-sr-laurel-wreath",
        titulo: "Plata",
        descripcion: "Segundo clan en el ranking de BiciRating en una temporada.",
        color: "#C0C0C0" // Plata
    },
    "bronce_temp": {
        icono: "fi fi-sr-laurel-wreath",
        titulo: "Bronce",
        descripcion: "Tercer clan en el ranking de BiciRating en una temporada.",
        color: "#CD7F32" // Bronce
    },
    "francotirador": {
        icono: "fi fi-sr-binoculars",
        titulo: "Francotirador",
        descripcion: "Primero en una ruta mientras estaba destacada (3 veces).",
        color: "#ffffff" // Morado
    },
    "pionero": {
        icono: "fi fi-sr-hourglass-start",
        titulo: "Desde el principio",
        descripcion: "Top 10 primeros clanes creados en BiciFastness.",
        color: "#ffffff" // Cyan
    },
    "diamante": {
        icono: "fi fi-sr-diamond",
        titulo: "VIP",
        descripcion: "Insignia exclusiva y clasificada.",
        color: "#ffffff" // Rosa brillante
    },
    "mecenas": {
        icono: "fi fi-sr-heart",
        titulo: "Mecenas",
        descripcion: "Ha apoyado económicamente al proyecto.",
        color: "#ffffff" // Rojo/Rosa corazón
    }
};

// Función de ayuda para dibujar las insignias en cualquier página

/**
 * Genera los nodos de las insignias de un piloto.
 *
 * Sustituye a `generarHTMLInsignias`, que devolvia una cadena de HTML con los
 * valores interpolados dentro de atributos `title` y `style` y con manejadores
 * `onmouseover` en linea. Como las paginas lo inyectaban con innerHTML, bastaba
 * con una descripcion preparada para ejecutar codigo; ademas los `onmouseover`
 * en linea obligan a permitir 'unsafe-inline' en la CSP, que es justo lo que
 * queremos evitar.
 */
export function generarNodosInsignias(logros) {
  if (!Array.isArray(logros) || logros.length === 0) {
    const vacio = document.createElement('span');
    vacio.textContent = 'Aun no tiene insignias';
    vacio.style.cssText = 'color: var(--tinta-3); font-size: .88rem;';
    return [vacio];
  }

  return logros
    .map((clave) => {
      const insignia = DICCIONARIO_INSIGNIAS[clave];
      if (!insignia) return null;

      const caja = document.createElement('div');
      caja.className = 'insignia-badge';
      // title y style se asignan por propiedad, nunca concatenando HTML.
      caja.title = `${insignia.titulo}: ${insignia.descripcion}`;
      caja.style.cssText = 'font-size: 1.5rem; cursor: help; transition: transform .2s;';
      caja.style.color = insignia.color;
      caja.addEventListener('mouseover', () => { caja.style.transform = 'scale(1.2)'; });
      caja.addEventListener('mouseout', () => { caja.style.transform = 'scale(1)'; });

      const icono = document.createElement('i');
      icono.className = insignia.icono;
      caja.appendChild(icono);
      return caja;
    })
    .filter(Boolean);
}
