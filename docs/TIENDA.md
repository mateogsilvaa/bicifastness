# Tienda: camisetas y tazas con tus marcas

Merchandising impreso bajo demanda con los datos reales de cada piloto: su
nombre, el escudo de su clan, su mejor tiempo en un tramo y su puesto en el
ranking general. El dinero que sale de aquí ayuda a pagar el proyecto.

## Cómo funciona

BiciFastness no tiene servidor propio. La web es estática (GitHub Pages) y el
único proceso de confianza es el worker, que corre en GitHub Actions. Cobra
**Gumroad**, que es el vendedor a efectos fiscales (*merchant of record*):
factura al cliente y calcula, cobra y declara el IVA de cada país. El flujo
«normal» (un endpoint que crea el pago y otro que recibe el webhook) se ha
adaptado así:

```
Navegador ── 1. vista previa (SVG, con tus datos)
    │
    ├─ 2. crea pedidos_tienda/{id}  (borrador: producto, talla, qué trayecto)
    └─ 3. va al producto de Gumroad con ?wanted=true&pedido={id}
                       │
      Gumroad cobra (con IVA y envío) y recoge la dirección;
      el campo personalizado «pedido» viaja con la venta
                       │
Worker (cada ejecución) ── 4. pregunta a Gumroad por las ventas nuevas
    │                        (hace de webhook, pero tirando en vez de recibir)
    ├─ 5. comprueba que la venta es del producto del pedido y no está devuelta
    ├─ 6. saca los datos de Firestore (NO del navegador) y pinta el diseño
    ├─ 7. SVG → PNG con sharp → lo sube a Cloudinary
    └─ 8. crea el pedido en Printful con la dirección y la URL del PNG
```

Piezas:

| Qué | Dónde |
|---|---|
| El diseño (el mismo para vista previa e impresión) | `assets/js/tienda-diseno.js` |
| La página | `tienda/`, `assets/js/paginas/tienda.js` |
| Círculo con corazón (Hoy, Ranking, Mapa), tarjeta en Yo e invitación en Hoy | `assets/js/tienda.js`, `assets/js/yo-vistas.js` |
| Abrir/cerrar y configurar | `/admin/tienda/` → `config/tienda` |
| Del pago a la imprenta | `backend/src/tienda.js` (lo llama el worker) |
| Reglas | `firestore.rules`: `config/tienda`, `pedidos_tienda`, `tienda_interno` |

## Puesta en marcha

1. **Printful.** Crea una tienda de tipo «Manual order platform / API». Genera
   un token privado (Settings → API) con permiso de pedidos. Apunta el id de
   variante de cada talla: catálogo → producto → «Variants», o
   `GET https://api.printful.com/products/{id}`. Ejemplos habituales (compruébalos
   en el catálogo, los ids cambian por color y talla): Bella+Canvas 3001 negra y
   la taza blanca brillante de 11 oz.
2. **Cloudinary.** Cuenta gratuita. Necesitas el *cloud name*, la *API key* y el
   *API secret* (Dashboard). Solo se usa para alojar el PNG que lee Printful.
3. **Gumroad.** Un producto **físico** por artículo (Camiseta, Taza):
   - Tipo «Physical product», con «Require shipping information» activado y
     los países a los que envíes con su gasto de envío. Sin eso la venta no
     trae dirección y el pedido se queda «a revisar».
   - Precio fijo en EUR, sin variantes (la talla se elige en la web y va en
     el pedido) y sin «Pay what you want».
   - Un **campo personalizado** de texto llamado exactamente `pedido`. La web
     lo rellena desde la URL (`?pedido=…`); es lo que ata la venta a nuestro
     pedido. Márcalo como obligatorio: si alguien llega al producto sin pasar
     por la web, no puede comprar a ciegas.
   - El enlace que se pega en el panel es el de la página del producto,
     `https://tu-usuario.gumroad.com/l/<permalink>`. Si le pones un permalink
     personalizado, usa ese mismo: el worker compara el permalink de la venta
     con el del enlace.
   - El token: Settings → Advanced → Applications → crea una aplicación y
     «Generate access token». Solo se usa para **leer ventas**
     (`GET https://api.gumroad.com/v2/sales`).
   - Prueba primero con una compra tuya y devuélvela desde Gumroad: el worker
     no imprime ventas devueltas.
   - Gumroad se queda su comisión (un porcentaje más una cantidad fija por
     venta; mira la tarifa vigente) y paga por transferencia según su
     calendario.
4. **Secretos del repositorio** (Settings → Secrets and variables → Actions):
   `GUMROAD_TOKEN`, `PRINTFUL_TOKEN`, `PRINTFUL_STORE_ID` (si el token es de
   cuenta y no de tienda), `CLOUDINARY_CLOUD`, `CLOUDINARY_API_KEY`,
   `CLOUDINARY_API_SECRET`. Sin `GUMROAD_TOKEN` el worker no toca la tienda.
5. **`/admin/tienda/`**: pega los enlaces de Gumroad, el precio (el mismo que
   en Gumroad, sin impuestos ni envío) y las variantes de Printful (`M=4012`,
   una por línea), marca «A la venta» y pon la tienda «Visible».
6. Los primeros pedidos llegan a Printful como **borrador**: los confirmas tú
   desde su panel después de mirar el diseño. Cuando te fíes, crea la variable
   de repositorio `TIENDA_CONFIRMAR` = `si` y saldrán directos a producción.

**Ojo:** Gumroad está pensado sobre todo para productos digitales. Admite
físicos, pero conviene confirmar con su soporte que acepta merchandising
impreso bajo demanda y cómo trata el IVA del envío, antes de abrir la tienda.
Y aunque Gumroad venda, tú sigues siendo quien cobra sus pagos: eso va en tu
declaración como ingreso.

La página ya explica que, al ser personalizado, no hay desistimiento
(art. 103.c TRLGDCU), pero eso no sustituye a unas condiciones de venta.

## Que no moleste

- Cerrada en `/admin/tienda/`, no aparece en ningún sitio.
- Abierta: una tarjeta en el resumen de Yo (y su entrada en el menú), un
  círculo pequeño con corazón en Hoy, Ranking y Mapa y, como mucho, **una
  tarjeta en Hoy**: solo para quien lleva 5 trayectos verificados y una semana de cuenta,
  una vez al mes, tres veces en total, nunca si ya hay otra invitación en
  pantalla, y con «No volver a mostrar».

## Las cuatro preguntas

### 1. La plantilla y la URL dinámica: ¿Cloudinary o código?

Código. Cloudinary puede montar el diseño con capas en la URL
(`l_text:Arial_80_bold:pepa,co_white,g_north,y_300/…`), pero:

- el texto hay que escaparlo a su manera (comas, barras, `%`), y un nombre con
  caracteres raros rompe la URL;
- no mide el texto: o adivinas el tamaño o se sale;
- la vista previa del navegador sería otra cosa distinta de lo que se imprime.

Aquí el diseño es una función que devuelve un SVG (`disenoSVG`). El navegador
lo enseña tal cual y el worker lo convierte en PNG de 3600×4800 (camiseta,
12×16" a 300 ppp) o 2700×1050 (taza) con `sharp`, que ya usaba para las
capturas. Cloudinary solo **aloja** el PNG, porque Printful necesita una URL
pública y en el plan gratuito de Firebase no hay Storage. Si algún día se
prefiere la plantilla de Cloudinary, la URL sería:

```
https://res.cloudinary.com/<nube>/image/upload/
  l_text:Archivo_220_black:<nombre-escapado>,co_rgb:F2F1EE,g_north_west,x_90,y_250/
  l_text:Archivo_330_black:12%3A29,co_rgb:F2F1EE,g_north_west,x_90,y_700/
  plantilla-camiseta.png
```

### 2. El endpoint que crea el pago

No hace falta: el producto de Gumroad ya es el pago configurado, y la web
lleva al cliente a `https://tu-usuario.gumroad.com/l/<permalink>?wanted=true&pedido=<id>`.
`wanted=true` salta directo al pago y `pedido` rellena el campo personalizado
del mismo nombre. Ventaja de seguridad: el precio vive en Gumroad y la web no
puede tocarlo.

### 3. El webhook y el pedido a Printful

Gumroad sí avisa de cada venta (su «Ping», un POST a la URL que le digas),
pero sin servidor no hay a dónde mandarlo, y además ese aviso **no va
firmado**: cualquiera podría inventarse una venta. Así que el worker
**pregunta** con el token: `GET /v2/sales?after=AAAA-MM-DD`, desde el día
anterior a la última vez que miró (`tienda_interno/gumroad`), y salta las
ventas que ya vio por su id. Tarda lo que tarde la siguiente ejecución del
worker (unos minutos), que para un pedido que se imprime en días no importa.

De cada venta se usa: `custom_fields.pedido` (nuestro pedido),
`product_permalink`, `paid`, `refunded`, `chargedback`, y la dirección
(`full_name`, `street_address`, `city`, `state`, `zip_code`, `country_iso2`,
`email`), que `destinatario` convierte en el `recipient` de Printful. Se
guardan en el pedido `gumroadVenta`, `importe` e `impuesto` (en céntimos de
dólar, que es como los da la API de Gumroad). El pedido a Printful
(`cuerpoPrintful`):

```json
{
  "external_id": "uid_20375_0",
  "shipping": "STANDARD",
  "recipient": { "name": "…", "address1": "…", "city": "Madrid", "country_code": "ES", "zip": "28013", "email": "…" },
  "items": [{ "variant_id": 4012, "quantity": 1, "retail_price": "24.90",
              "files": [{ "type": "front", "url": "https://res.cloudinary.com/…png" }] }]
}
```

`external_id` es el id de nuestro pedido, y antes de crearlo se pregunta
`GET /orders/@{external_id}`: una ejecución cortada a medias nunca duplica un
pedido. Si la venta no es del producto del pedido, falta la dirección o la talla
no tiene variante, el pedido queda «a revisar» y te llega un correo. Un fallo
de red se reintenta tres veces antes de avisar.

### 4. Nombres largos y textos que rompen el diseño

Todo texto pasa por dos filtros (`tienda-diseno.js`):

- **`limpiar`**: normaliza, quita emojis y caracteres que la imprenta no tiene
  (saldrían cuadraditos), colapsa espacios y recorta con «…» a un máximo por
  campo (22 el nombre, 26 el clan, 34 cada estación).
- **`linea`**: estima el ancho por letra (por lo alto: la imprenta no tiene
  Archivo y usa otra), **encoge la letra** hasta que cabe; si ni al mínimo
  cabe, **recorta**; y además fija `textLength` con
  `lengthAdjust="spacingAndGlyphs"`, que obliga al renderizador a apretar la
  línea antes que desbordarla. El tiempo nunca se recorta, solo encoge.

Y lo de siempre con texto que viene de la base de datos: se escapa para XML
(un nombre con `<script>` no puede romper el SVG), el color del clan solo
entra si es `#RRGGBB` y el trazo del emblema solo si es un `d` de SVG. Lo
prueban `backend/test/tienda.test.js` y los PNG se pueden generar en local con
`sharp` para mirarlos.
