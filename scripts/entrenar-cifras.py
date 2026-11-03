#!/usr/bin/env python3
"""
Entrena el lector de cifras (backend/src/lector-cifras.js) con los recortes
confirmados de `dataset_cifras` (los exporta scripts/exportar-cifras.js).

Once clases: 0-9 y ":". Regresion logistica (softmax) con numpy: el modelo es
una matriz de pesos que se guarda en JSON y el worker aplica con un producto.

La segmentacion es GEMELA de `segmentar` en backend/src/lector-cifras.js. Si
cambia una, hay que cambiar la otra.

Uso: python3 scripts/entrenar-cifras.py muestras.json backend/lib/cifras.json
Solo imprime recuentos y aciertos: el log de Actions es publico.
"""

import base64
import io
import json
import sys

import numpy as np
from PIL import Image

ANCHO, ALTO = 12, 16
CLASES = list("0123456789:")


def reescalar(pix, ancho, x0, y0, w, h):
    salida = [0.0] * (ANCHO * ALTO)
    for j in range(ALTO):
        for i in range(ANCHO):
            xa = x0 + (i * w) / ANCHO
            xb = x0 + ((i + 1) * w) / ANCHO
            ya = y0 + (j * h) / ALTO
            yb = y0 + ((j + 1) * h) / ALTO
            suma = 0
            n = 0
            for y in range(int(np.floor(ya)), max(int(np.floor(ya)) + 1, int(np.ceil(yb)))):
                for x in range(int(np.floor(xa)), max(int(np.floor(xa)) + 1, int(np.ceil(xb)))):
                    suma += pix[y * ancho + x]
                    n += 1
            salida[j * ANCHO + i] = suma / n if n else 0
    return salida


def segmentar(gris, ancho, alto):
    mn, mx = min(gris), max(gris)
    if mx - mn < 40:
        return []
    umbral = (mn + mx) / 2
    fondo_claro = sum(gris) / len(gris) > umbral
    tinta = [1 if ((v < umbral) if fondo_claro else (v > umbral)) else 0 for v in gris]
    columnas = [sum(tinta[y * ancho + x] for y in range(alto)) for x in range(ancho)]
    trozos, desde = [], -1
    for x in range(ancho + 1):
        hay = x < ancho and columnas[x] > 0
        if hay and desde < 0:
            desde = x
        if not hay and desde >= 0:
            trozos.append((desde, x))
            desde = -1
    salida = []
    for a, b in trozos:
        if b - a < 1:
            continue
        y0, y1 = alto, 0
        for y in range(alto):
            for x in range(a, b):
                if tinta[y * ancho + x]:
                    y0, y1 = min(y0, y), max(y1, y + 1)
        salida.append(reescalar(tinta, ancho, a, y0, b - a, max(1, y1 - y0)))
    return salida


def glifos_de(png_b64):
    img = Image.open(io.BytesIO(base64.b64decode(png_b64))).convert("L")
    if img.height != 32:
        img = img.resize((max(1, round(img.width * 32 / img.height)), 32))
    return segmentar(list(img.tobytes()), img.width, img.height)


def main():
    entrada, salida = sys.argv[1], sys.argv[2]
    muestras = json.load(open(entrada))
    X, y, usadas, descartadas = [], [], 0, 0
    for m in muestras:
        etiqueta = str(m.get("etiqueta", ""))
        if not etiqueta or any(c not in CLASES for c in etiqueta):
            descartadas += 1
            continue
        glifos = glifos_de(m["png"])
        # Solo si se trocea en tantos glifos como caracteres: asi cada glifo
        # tiene su etiqueta segura.
        if len(glifos) != len(etiqueta):
            descartadas += 1
            continue
        usadas += 1
        for g, c in zip(glifos, etiqueta):
            X.append(g)
            y.append(CLASES.index(c))
    print(f"Muestras: {len(muestras)}, usadas {usadas}, descartadas {descartadas}, glifos {len(X)}")
    if len(X) < 200:
        print("Pocos glifos todavia: no se entrena.")
        return 2
    X = np.array(X, dtype=np.float64)
    y = np.array(y)
    rng = np.random.default_rng(7)
    orden = rng.permutation(len(X))
    corte = int(len(X) * 0.8)
    entreno, prueba = orden[:corte], orden[corte:]
    K = len(CLASES)
    W = np.zeros((K, X.shape[1]))
    b = np.zeros(K)
    Y = np.eye(K)[y]
    for paso in range(1500):
        Z = X[entreno] @ W.T + b
        Z -= Z.max(axis=1, keepdims=True)
        P = np.exp(Z)
        P /= P.sum(axis=1, keepdims=True)
        G = P - Y[entreno]
        W -= 0.5 * (G.T @ X[entreno] / len(entreno) + 1e-4 * W)
        b -= 0.5 * G.mean(axis=0)
    acierto = float(((X[prueba] @ W.T + b).argmax(axis=1) == y[prueba]).mean()) if len(prueba) else 0.0
    print(f"Acierto en prueba: {acierto:.4f} ({len(prueba)} glifos)")
    json.dump({
        "clases": CLASES, "ancho": ANCHO, "alto": ALTO,
        "pesos": np.round(W, 5).tolist(), "sesgos": np.round(b, 5).tolist(),
        "acierto": round(acierto, 4), "glifos": len(X),
    }, open(salida, "w"))
    # Solo se da por bueno si acierta de verdad.
    return 0 if acierto >= 0.99 else 3


if __name__ == "__main__":
    sys.exit(main())
