// badwords.js
// Diccionario de palabras o fragmentos que no pueden aparecer en nombres ni clanes.
// Ponlas siempre en MINÚSCULAS. El script ya se encargará de comprobarlas sin importar mayúsculas/minúsculas.

export const forbiddenWords = [
    "admin", "administrator", "sistema", "system", "moderador", "mod", "bicifastness",
    "puta", "puto", "gilipollas", "cabron", "cabrona", "zorra", "maricon", "marica", "facha", 
    "nazi", "hitler", "subnormal", "imbecil", "retrasado", "mierda", "joder", "coño", "polla",
    "pene", "cojones", "sexo", "porno", "violacion", "suicidio", "pito"
    // Añade aquí todas las que consideres oportunas, separadas por comas.
];

// Función para validar un texto contra el diccionario
export function containsBadWords(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    
    // Comprueba si alguna palabra prohibida está DENTRO del texto
    for (let word of forbiddenWords) {
        if (lowerText.includes(word)) {
            return true; // Contiene una palabra prohibida
        }
    }
    return false; // Está limpio
}