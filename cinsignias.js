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
        icono: "fi fi-ss-fire-flame-curved",
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
        icono: "fi fi-br-tire",
        titulo: "Top",
        descripcion: "Top 4 o 5 en el ranking de BiciRating en una temporada.",
        color: "#ffffff" // Gris
    },
    "oro_temp": {
        icono: "fi fi-bs-first-laurel",
        titulo: "Oro",
        descripcion: "Primero en el ranking de BiciRating en una temporada.",
        color: "#FFD700" // Oro
    },
    "plata_temp": {
        icono: "fi fi-bs-second-laurel",
        titulo: "Plata",
        descripcion: "Segundo en el ranking de BiciRating en una temporada.",
        color: "#C0C0C0" // Plata
    },
    "bronce_temp": {
        icono: "fi fi-bs-third-laurel",
        titulo: "Bronce",
        descripcion: "Tercero en el ranking de BiciRating en una temporada.",
        color: "#CD7F32" // Bronce
    },
    "francotirador": {
        icono: "fi fi-sr-binoculars",
        titulo: "Francotirador",
        descripcion: "Primero en una ruta mientras estaba destacada (3 veces).",
        color: "#ffffff" // Morado
    },
    "pionero": {
        icono: "fi fi-br-hourglass-start",
        titulo: "Desde el principio",
        descripcion: "Top 10 primeros usuarios en registrarse en BiciFastness.",
        color: "#ffffff" // Cyan
    },
    "diamante": {
        icono: "fi fi-rs-diamond",
        titulo: "VIP",
        descripcion: "Insignia exclusiva y clasificada.",
        color: "#ffffff" // Rosa brillante
    },
    "mecenas": {
        icono: "fi fi-br-circle-heart",
        titulo: "Mecenas",
        descripcion: "Ha apoyado económicamente al proyecto.",
        color: "#ffffff" // Rojo/Rosa corazón
    }
};

// Función de ayuda para dibujar las insignias en cualquier página
export function generarHTMLInsignias(arrayInsigniasDelUsuario) {
    if (!arrayInsigniasDelUsuario || arrayInsigniasDelUsuario.length === 0) {
        return `<span style="color: #888; font-size: 0.9em;">Aún no tiene insignias</span>`;
    }

    let html = `<div class="contenedor-insignias" style="display: flex; gap: 10px; flex-wrap: wrap;">`;
    
    arrayInsigniasDelUsuario.forEach(id => {
        const insignia = DICCIONARIO_INSIGNIAS[id];
        if (insignia) {
            // Dibujamos el icono con un "tooltip" (title) nativo para que se lea la descripción al pasar el ratón
            html += `
                <div class="insignia-badge" 
                     title="${insignia.titulo}: ${insignia.descripcion}" 
                     style="font-size: 1.5rem; color: ${insignia.color}; cursor: help; transition: transform 0.2s;"
                     onmouseover="this.style.transform='scale(1.2)'"
                     onmouseout="this.style.transform='scale(1)'">
                    <i class="${insignia.icono}"></i>
                </div>
            `;
        }
    });

    html += `</div>`;
    return html;
}